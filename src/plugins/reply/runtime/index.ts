import type { OutboundMessageSegment } from '../../shared/outbound/index.js';

export type ReplyRunState = 'generating' | 'sending';
export type ReplyRunMode = 'interrupt' | 'queue';

export interface ReplyRuntimeRoomLike {
  roomId?: number | string;
  conversationId?: string;
  model?: string;
  [key: string]: unknown;
}

export interface ReplyTurnInput {
  text: string;
  displayName: string;
  userId: string;
  isDirect: boolean;
}

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
  strandKey: string;
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
  strandKey: string;
  conversationId?: string;
  room: ReplyRuntimeRoomLike;
  input: ReplyTurnInput;
  resolve: (result: ReplyRuntimePrepareResult) => void;
}

interface ReplyRuntimeCollectionState {
  snapshot: ReplyRuntimeContinuationSnapshot;
  pending: PendingTurnEntry[];
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
  private readonly currentRunByStrand = new Map<string, string>();
  private readonly runs = new Map<string, ReplyRuntimeRun>();
  private readonly completionResolvers = new Map<string, () => void>();
  private readonly completionPromises = new Map<string, Promise<void>>();
  private readonly collections = new Map<string, ReplyRuntimeCollectionState>();
  private readonly collectWindowMs: number;
  private readonly maxPendingInputs: number;

  constructor(private readonly options: ReplyRuntimeOptions) {
    this.collectWindowMs = Math.max(1, Math.floor(options.collectWindowMs ?? DEFAULT_COLLECT_WINDOW_MS));
    this.maxPendingInputs = Math.max(1, Math.floor(options.maxPendingInputs ?? DEFAULT_MAX_PENDING_INPUTS));
  }

  async prepareRun(args: {
    runId: string;
    strandKey: string;
    conversationId?: string;
    room: ReplyRuntimeRoomLike;
    input: ReplyTurnInput;
    mode?: ReplyRunMode;
  }): Promise<ReplyRuntimePrepareResult> {
    const { mode = 'interrupt' } = args;

    if (mode === 'queue') {
      while (true) {
        const previousRunId = this.currentRunByStrand.get(args.strandKey);
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

    const collecting = this.collections.get(args.strandKey);
    if (collecting) {
      return this.enqueueCollectedTurn(collecting, args);
    }

    const previousRunId = this.currentRunByStrand.get(args.strandKey);
    const previousRun = previousRunId ? this.runs.get(previousRunId) : null;
    if (!previousRun) {
      const run = this.createRun(args);
      return {
        action: 'continue',
        run,
        inputText: normalizeInputText(args.input.text),
      };
    }

    const snapshot = this.captureContinuationSnapshot(previousRun);
    const collectionPromise = this.startCollection(args, snapshot);
    await this.interruptRun(previousRun);
    return collectionPromise;
  }

  getRun(runId: string | undefined): ReplyRuntimeRun | null {
    if (!runId) return null;
    return this.runs.get(runId) ?? null;
  }

  isCurrentRun(runId: string | undefined): boolean {
    const run = this.getRun(runId);
    if (!run) return false;
    return this.currentRunByStrand.get(run.strandKey) === run.id;
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
    if (this.currentRunByStrand.get(run.strandKey) === run.id) {
      this.currentRunByStrand.delete(run.strandKey);
    }
    this.runs.delete(run.id);
    this.completionResolvers.get(run.id)?.();
    this.completionResolvers.delete(run.id);
    this.completionPromises.delete(run.id);
    return run;
  }

  private createRun(args: {
    runId: string;
    strandKey: string;
    conversationId?: string;
    room: ReplyRuntimeRoomLike;
    input: ReplyTurnInput;
  }): ReplyRuntimeRun {
    const created: ReplyRuntimeRun = {
      id: args.runId,
      strandKey: args.strandKey,
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
    this.currentRunByStrand.set(args.strandKey, args.runId);
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
    if (this.currentRunByStrand.get(run.strandKey) === run.id) {
      this.currentRunByStrand.delete(run.strandKey);
    }

    if (run.state === 'generating') {
      await this.options.stopChat(run.room, run.requestId).catch(() => undefined);
    }

    run.sendAbortController?.abort();
  }

  private startCollection(args: {
    runId: string;
    strandKey: string;
    conversationId?: string;
    room: ReplyRuntimeRoomLike;
    input: ReplyTurnInput;
  }, snapshot: ReplyRuntimeContinuationSnapshot): Promise<ReplyRuntimePrepareResult> {
    const state: ReplyRuntimeCollectionState = {
      snapshot,
      pending: [],
    };
    this.collections.set(args.strandKey, state);
    return this.enqueueCollectedTurn(state, args);
  }

  private enqueueCollectedTurn(
    state: ReplyRuntimeCollectionState,
    args: {
      runId: string;
      strandKey: string;
      conversationId?: string;
      room: ReplyRuntimeRoomLike;
      input: ReplyTurnInput;
    },
  ): Promise<ReplyRuntimePrepareResult> {
    if (state.pending.length >= this.maxPendingInputs) {
      throw new Error(`reply turn pending input overflow: ${args.strandKey}`);
    }

    return new Promise<ReplyRuntimePrepareResult>((resolve) => {
      state.pending.push({
        runId: args.runId,
        strandKey: args.strandKey,
        conversationId: args.conversationId,
        room: args.room,
        input: args.input,
        resolve,
      });
      if (state.timer) {
        clearTimeout(state.timer);
      }
      state.timer = setTimeout(() => {
        this.finalizeCollection(args.strandKey);
      }, this.collectWindowMs);
    });
  }

  private finalizeCollection(strandKey: string): void {
    const state = this.collections.get(strandKey);
    if (!state) return;

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.collections.delete(strandKey);

    if (!state.pending.length) {
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
      strandKey: carrier.strandKey,
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
}

export function cloneSegment(segment: OutboundMessageSegment): OutboundMessageSegment {
  return { ...segment };
}
