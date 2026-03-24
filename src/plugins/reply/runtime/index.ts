import type { TurnInput } from '../pipeline/types.js';
import type { OutboundMessageSegment } from '../../shared/outbound/index.js';

export type ReplyRunState = 'generating' | 'sending';
export type ReplyRunMode = 'interrupt' | 'queue';

export interface ReplyRuntimeRoomLike {
  roomId?: number | string;
  conversationId?: string;
  model?: string;
  [key: string]: unknown;
}

export type ReplyTurnInput = TurnInput;

export interface ReplyTurnContinuationContext {
  alreadySentText: string;
  pendingUnitTexts: string[];
  supplementalMessages: string[];
}

export interface ReplyRuntimePrepareResult {
  action: 'continue' | 'stop';
  run?: ReplyRuntimeRun;
  inputText?: string;
  continuationContext?: ReplyTurnContinuationContext;
}

export interface ReplyRuntimeRun {
  id: string;
  queueKey: string;
  actorKey: string;
  conversationId?: string;
  room: ReplyRuntimeRoomLike;
  input: ReplyTurnInput;
  state: ReplyRunState;
  plannedUnitHistoryLines: string[];
  committedHistoryLines: string[];
  requestId: string;
  sendAbortController?: AbortController;
}

export interface ReplyRuntimeOptions {
  stopChat: (room: ReplyRuntimeRoomLike, requestId: string) => Promise<void>;
  collectWindowMs?: number;
  maxPendingInputs?: number;
}

interface ReplyRuntimeContinuationSnapshot {
  alreadySentText: string;
  pendingUnitTexts: string[];
  hasModelOutput: boolean;
  baseInput?: ReplyTurnInput;
}

interface PendingTurnEntry {
  runId: string;
  queueKey: string;
  actorKey: string;
  conversationId?: string;
  room: ReplyRuntimeRoomLike;
  input: ReplyTurnInput;
  resolve: (result: ReplyRuntimePrepareResult) => void;
}

interface ReplyRuntimePendingState {
  queueKey: string;
  actorKey: string;
  snapshot: ReplyRuntimeContinuationSnapshot;
  pending: PendingTurnEntry[];
  ready: boolean;
  timer?: NodeJS.Timeout;
}

const DEFAULT_COLLECT_WINDOW_MS = 400;
const DEFAULT_MAX_PENDING_INPUTS = 8;

function normalizeInputText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

function formatInputWithIdentity(input: ReplyTurnInput): string {
  const text = normalizeInputText(input.text);
  if (!text) return '';
  if (input.isDirect) return text;
  return `[${input.displayName}/${input.userId}] ${text}`;
}

function renderAggregatedInput(inputs: ReplyTurnInput[]): string {
  const normalized = inputs
    .map((input) => ({
      ...input,
      text: normalizeInputText(input.text),
    }))
    .filter((input) => input.text);
  if (!normalized.length) return '';

  const firstUserId = normalized[0].userId;
  const sameUser = normalized.every((input) => input.userId === firstUserId);
  if (sameUser) {
    return normalized.map((input) => input.text).join('\n').trim();
  }

  return normalized.map((input) => formatInputWithIdentity(input)).filter(Boolean).join('\n').trim();
}

function buildSupplementalMessages(inputs: ReplyTurnInput[]): string[] {
  return inputs.map((input) => formatInputWithIdentity(input)).filter(Boolean);
}

export class ReplyRuntime {
  private readonly currentRunByQueueKey = new Map<string, string>();
  private readonly activeRunByActorKey = new Map<string, string>();
  private readonly runs = new Map<string, ReplyRuntimeRun>();
  private readonly completionResolvers = new Map<string, () => void>();
  private readonly completionPromises = new Map<string, Promise<void>>();
  private readonly pendingStatesByActorKey = new Map<string, ReplyRuntimePendingState>();
  private readonly queueActorOrder = new Map<string, string[]>();
  private readonly collectWindowMs: number;
  private readonly maxPendingInputs: number;

  constructor(private readonly options: ReplyRuntimeOptions) {
    this.collectWindowMs = Math.max(1, Math.floor(options.collectWindowMs ?? DEFAULT_COLLECT_WINDOW_MS));
    this.maxPendingInputs = Math.max(1, Math.floor(options.maxPendingInputs ?? DEFAULT_MAX_PENDING_INPUTS));
  }

  async prepareRun(args: {
    runId: string;
    queueKey: string;
    actorKey: string;
    conversationId?: string;
    room: ReplyRuntimeRoomLike;
    input: ReplyTurnInput;
    mode?: ReplyRunMode;
  }): Promise<ReplyRuntimePrepareResult> {
    const { mode = 'interrupt' } = args;

    if (mode === 'queue') {
      while (true) {
        const previousRunId = this.currentRunByQueueKey.get(args.queueKey);
        if (!previousRunId) break;
        await this.waitForRunCompletion(previousRunId);
      }

      const run = this.createRun(args);
      return {
        action: 'continue',
        run,
        inputText: normalizeInputText(args.input.text),
      };
    }

    const activeRunId = this.activeRunByActorKey.get(args.actorKey);
    const activeRun = activeRunId ? this.runs.get(activeRunId) : null;
    if (activeRun) {
      const snapshot = this.captureContinuationSnapshot(activeRun);
      const pendingState = this.getOrCreatePendingState(args, snapshot);
      const pendingPromise = this.enqueuePendingTurn(pendingState, args);
      this.moveActorToQueueTail(args.queueKey, args.actorKey);
      await this.interruptRun(activeRun);
      this.tryStartNext(args.queueKey);
      return pendingPromise;
    }

    const existingPendingState = this.pendingStatesByActorKey.get(args.actorKey);
    if (existingPendingState) {
      return this.enqueuePendingTurn(existingPendingState, args);
    }

    if (!this.currentRunByQueueKey.get(args.queueKey) && !this.getQueue(args.queueKey).length) {
      const run = this.createRun(args);
      return {
        action: 'continue',
        run,
        inputText: normalizeInputText(args.input.text),
      };
    }

    const pendingState = this.getOrCreatePendingState(args, {
      alreadySentText: '',
      pendingUnitTexts: [],
      hasModelOutput: false,
    });
    const pendingPromise = this.enqueuePendingTurn(pendingState, args);
    this.enqueueActorIfMissing(args.queueKey, args.actorKey);
    this.tryStartNext(args.queueKey);
    return pendingPromise;
  }

  getRun(runId: string | undefined): ReplyRuntimeRun | null {
    if (!runId) return null;
    return this.runs.get(runId) ?? null;
  }

  isCurrentRun(runId: string | undefined): boolean {
    const run = this.getRun(runId);
    if (!run) return false;
    return (
      this.currentRunByQueueKey.get(run.queueKey) === run.id &&
      this.activeRunByActorKey.get(run.actorKey) === run.id
    );
  }

  beginSending(runId: string): AbortSignal | null {
    const run = this.getRun(runId);
    if (!run) return null;
    run.state = 'sending';
    run.sendAbortController = new AbortController();
    return run.sendAbortController.signal;
  }

  setPlannedUnitHistory(runId: string, historyLines: string[]): void {
    const run = this.getRun(runId);
    if (!run) return;
    run.plannedUnitHistoryLines = historyLines.map((line) => line.trim()).filter(Boolean);
  }

  recordCommittedUnit(runId: string, historyLine: string): void {
    const run = this.getRun(runId);
    if (!run) return;
    const normalized = historyLine.trim();
    if (!normalized) return;
    run.committedHistoryLines.push(normalized);
  }

  wasInterrupted(runId: string | undefined): boolean {
    const run = this.getRun(runId);
    if (!run) return true;
    return !this.isCurrentRun(runId) || run.sendAbortController?.signal.aborted === true;
  }

  getCommittedHistoryText(runId: string | undefined): string {
    const run = this.getRun(runId);
    if (!run) return '';
    return run.committedHistoryLines.join('\n').trim();
  }

  finishRun(runId: string | undefined): ReplyRuntimeRun | null {
    const run = this.getRun(runId);
    if (!run) return null;
    if (this.currentRunByQueueKey.get(run.queueKey) === run.id) {
      this.currentRunByQueueKey.delete(run.queueKey);
    }
    if (this.activeRunByActorKey.get(run.actorKey) === run.id) {
      this.activeRunByActorKey.delete(run.actorKey);
    }
    this.runs.delete(run.id);
    this.completionResolvers.get(run.id)?.();
    this.completionResolvers.delete(run.id);
    this.completionPromises.delete(run.id);
    this.tryStartNext(run.queueKey);
    return run;
  }

  private createRun(args: {
    runId: string;
    queueKey: string;
    actorKey: string;
    conversationId?: string;
    room: ReplyRuntimeRoomLike;
    input: ReplyTurnInput;
  }): ReplyRuntimeRun {
    const created: ReplyRuntimeRun = {
      id: args.runId,
      queueKey: args.queueKey,
      actorKey: args.actorKey,
      conversationId: args.conversationId,
      room: args.room,
      input: args.input,
      state: 'generating',
      plannedUnitHistoryLines: [],
      committedHistoryLines: [],
      requestId: args.runId,
    };
    this.ensureCompletionTracking(args.runId);
    this.runs.set(args.runId, created);
    this.currentRunByQueueKey.set(args.queueKey, args.runId);
    this.activeRunByActorKey.set(args.actorKey, args.runId);
    return created;
  }

  private captureContinuationSnapshot(run: ReplyRuntimeRun): ReplyRuntimeContinuationSnapshot {
    const alreadySentText = run.committedHistoryLines.join('\n').trim();
    const pendingUnitTexts = run.plannedUnitHistoryLines.slice(run.committedHistoryLines.length);
    return {
      alreadySentText,
      pendingUnitTexts,
      hasModelOutput: run.plannedUnitHistoryLines.length > 0,
      baseInput: run.plannedUnitHistoryLines.length > 0 ? undefined : run.input,
    };
  }

  private async interruptRun(run: ReplyRuntimeRun): Promise<void> {
    if (this.currentRunByQueueKey.get(run.queueKey) === run.id) {
      this.currentRunByQueueKey.delete(run.queueKey);
    }
    if (this.activeRunByActorKey.get(run.actorKey) === run.id) {
      this.activeRunByActorKey.delete(run.actorKey);
    }

    if (run.state === 'generating') {
      await this.options.stopChat(run.room, run.requestId).catch(() => undefined);
    }

    run.sendAbortController?.abort();
  }

  private getOrCreatePendingState(
    args: {
      queueKey: string;
      actorKey: string;
    },
    snapshot: ReplyRuntimeContinuationSnapshot,
  ): ReplyRuntimePendingState {
    const existing = this.pendingStatesByActorKey.get(args.actorKey);
    if (existing) return existing;

    const state: ReplyRuntimePendingState = {
      queueKey: args.queueKey,
      actorKey: args.actorKey,
      snapshot,
      pending: [],
      ready: false,
    };
    this.pendingStatesByActorKey.set(args.actorKey, state);
    return state;
  }

  private enqueuePendingTurn(
    state: ReplyRuntimePendingState,
    args: {
      runId: string;
      queueKey: string;
      actorKey: string;
      conversationId?: string;
      room: ReplyRuntimeRoomLike;
      input: ReplyTurnInput;
    },
  ): Promise<ReplyRuntimePrepareResult> {
    if (state.pending.length >= this.maxPendingInputs) {
      throw new Error(`reply turn pending input overflow: ${args.actorKey}`);
    }

    return new Promise<ReplyRuntimePrepareResult>((resolve) => {
      state.pending.push({
        runId: args.runId,
        queueKey: args.queueKey,
        actorKey: args.actorKey,
        conversationId: args.conversationId,
        room: args.room,
        input: args.input,
        resolve,
      });
      this.schedulePendingState(state);
    });
  }

  private schedulePendingState(state: ReplyRuntimePendingState): void {
    state.ready = false;
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.ready = true;
      this.tryStartNext(state.queueKey);
    }, this.collectWindowMs);
  }

  private tryStartNext(queueKey: string): void {
    if (this.currentRunByQueueKey.has(queueKey)) return;

    const queue = this.getQueue(queueKey);
    while (queue.length > 0) {
      const actorKey = queue[0];
      const state = this.pendingStatesByActorKey.get(actorKey);
      if (!state || state.queueKey !== queueKey) {
        queue.shift();
        continue;
      }
      if (!state.ready) {
        return;
      }
      this.startPendingState(state);
      return;
    }
  }

  private startPendingState(state: ReplyRuntimePendingState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.pendingStatesByActorKey.delete(state.actorKey);
    this.removeActorFromQueue(state.queueKey, state.actorKey);

    if (!state.pending.length) {
      this.tryStartNext(state.queueKey);
      return;
    }

    const carrier = state.pending[state.pending.length - 1];
    const earlier = state.pending.slice(0, -1);
    earlier.forEach((entry) => entry.resolve({ action: 'stop' }));

    const continuationContext = state.snapshot.hasModelOutput
      ? {
          alreadySentText: state.snapshot.alreadySentText,
          pendingUnitTexts: [...state.snapshot.pendingUnitTexts],
          supplementalMessages: buildSupplementalMessages(earlier.map((entry) => entry.input)),
        }
      : undefined;
    const inputText = state.snapshot.hasModelOutput
      ? normalizeInputText(carrier.input.text)
      : renderAggregatedInput([
          ...(state.snapshot.baseInput ? [state.snapshot.baseInput] : []),
          ...state.pending.map((entry) => entry.input),
        ]);
    const run = this.createRun({
      runId: carrier.runId,
      queueKey: carrier.queueKey,
      actorKey: carrier.actorKey,
      conversationId: carrier.conversationId,
      room: carrier.room,
      input: carrier.input,
    });

    carrier.resolve({
      action: 'continue',
      run,
      inputText,
      continuationContext,
    });
  }

  private ensureCompletionTracking(runId: string): void {
    if (this.completionPromises.has(runId)) return;
    let resolve: () => void = () => {};
    const promise = new Promise<void>((nextResolve) => {
      resolve = nextResolve;
    });
    this.completionResolvers.set(runId, resolve);
    this.completionPromises.set(runId, promise);
  }

  private async waitForRunCompletion(runId: string): Promise<void> {
    await this.completionPromises.get(runId);
  }

  private getQueue(queueKey: string): string[] {
    const existing = this.queueActorOrder.get(queueKey);
    if (existing) return existing;

    const created: string[] = [];
    this.queueActorOrder.set(queueKey, created);
    return created;
  }

  private enqueueActorIfMissing(queueKey: string, actorKey: string): void {
    const queue = this.getQueue(queueKey);
    if (queue.includes(actorKey)) return;
    queue.push(actorKey);
  }

  private moveActorToQueueTail(queueKey: string, actorKey: string): void {
    const queue = this.getQueue(queueKey);
    const filtered = queue.filter((key) => key !== actorKey);
    filtered.push(actorKey);
    this.queueActorOrder.set(queueKey, filtered);
  }

  private removeActorFromQueue(queueKey: string, actorKey: string): void {
    const queue = this.getQueue(queueKey);
    const nextQueue = queue.filter((key) => key !== actorKey);
    if (nextQueue.length === 0) {
      this.queueActorOrder.delete(queueKey);
      return;
    }
    this.queueActorOrder.set(queueKey, nextQueue);
  }
}

export function cloneSegment(segment: OutboundMessageSegment): OutboundMessageSegment {
  return { ...segment };
}
