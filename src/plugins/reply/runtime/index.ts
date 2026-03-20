import type { OutboundMessageSegment } from '../../shared/outbound/index.js';

export type ReplyRunState = 'generating' | 'sending';

export interface SearchToolRuntimeEvent {
  toolName: 'web_search';
  status: 'called' | 'succeeded' | 'empty' | 'failed';
  query?: string;
  detail?: string;
  at: number;
}

export interface ReplyRuntimeRoomLike {
  roomId?: number | string;
  conversationId?: string;
  model?: string;
  [key: string]: unknown;
}

export interface ReplyRuntimeRun {
  id: string;
  strandKey: string;
  conversationId?: string;
  room: ReplyRuntimeRoomLike;
  session?: {
    state?: Record<string, unknown> & {
      qqReplyTransport?: {
        suppressAbortNotice?: boolean;
      };
    };
  };
  state: ReplyRunState;
  committedSegments: OutboundMessageSegment[];
  committedHistoryLines: string[];
  requestId: string;
  suppressAbortNotice: boolean;
  supersededBy?: string;
  sendAbortController?: AbortController;
  searchEvents: SearchToolRuntimeEvent[];
}

export interface ReplyRuntimeOptions {
  stopChat: (room: ReplyRuntimeRoomLike, requestId: string) => Promise<void>;
}

function cloneSegment(segment: OutboundMessageSegment): OutboundMessageSegment {
  return { ...segment };
}

export class ReplyRuntime {
  private readonly currentRunByStrand = new Map<string, string>();
  private readonly runs = new Map<string, ReplyRuntimeRun>();

  constructor(private readonly options: ReplyRuntimeOptions) {}

  async beginRun(args: {
    runId: string;
    strandKey: string;
    conversationId?: string;
    room: ReplyRuntimeRoomLike;
    session?: ReplyRuntimeRun['session'];
  }): Promise<ReplyRuntimeRun> {
    const { runId, strandKey, conversationId, room, session } = args;
    const previousRunId = this.currentRunByStrand.get(strandKey);
    const previousRun = previousRunId ? this.runs.get(previousRunId) : null;

    if (previousRun) {
      previousRun.supersededBy = runId;
      previousRun.suppressAbortNotice = true;
      if (previousRun.session) {
        const current = previousRun.session.state ?? {};
        current.qqReplyTransport = {
          ...(current.qqReplyTransport ?? {}),
          suppressAbortNotice: true,
        };
        previousRun.session.state = current;
      }
      if (previousRun.state === 'generating') {
        await this.options.stopChat(previousRun.room, previousRun.requestId).catch(() => undefined);
      }
      previousRun.sendAbortController?.abort();
    }

    const created: ReplyRuntimeRun = {
      id: runId,
      strandKey,
      conversationId,
      room,
      session,
      state: 'generating',
      committedSegments: [],
      committedHistoryLines: [],
      requestId: runId,
      suppressAbortNotice: false,
      searchEvents: [],
    };
    this.runs.set(runId, created);
    this.currentRunByStrand.set(strandKey, runId);
    return created;
  }

  reuseRun(args: {
    runId: string;
    strandKey: string;
    conversationId?: string;
    room: ReplyRuntimeRoomLike;
    session?: ReplyRuntimeRun['session'];
  }): ReplyRuntimeRun {
    const existing = this.runs.get(args.runId);
    if (existing) {
      if (args.session) existing.session = args.session;
      return existing;
    }

    const created: ReplyRuntimeRun = {
      id: args.runId,
      strandKey: args.strandKey,
      conversationId: args.conversationId,
      room: args.room,
      session: args.session,
      state: 'generating',
      committedSegments: [],
      committedHistoryLines: [],
      requestId: args.runId,
      suppressAbortNotice: false,
      searchEvents: [],
    };
    this.runs.set(args.runId, created);
    this.currentRunByStrand.set(args.strandKey, args.runId);
    return created;
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

  markGenerating(runId: string): void {
    const run = this.getRun(runId);
    if (!run) return;
    run.state = 'generating';
  }

  beginSending(runId: string): AbortSignal | null {
    const run = this.getRun(runId);
    if (!run) return null;
    run.state = 'sending';
    run.sendAbortController = new AbortController();
    return run.sendAbortController.signal;
  }

  recordCommittedSegment(runId: string, segment: OutboundMessageSegment, historyLine: string): void {
    const run = this.getRun(runId);
    if (!run) return;
    run.committedSegments.push(cloneSegment(segment));
    const normalized = historyLine.trim();
    if (normalized) {
      run.committedHistoryLines.push(normalized);
    }
  }

  recordSearchEvent(runId: string, event: SearchToolRuntimeEvent): void {
    const run = this.getRun(runId);
    if (!run) return;
    run.searchEvents.push({ ...event });
  }

  wasInterrupted(runId: string | undefined): boolean {
    const run = this.getRun(runId);
    if (!run) return true;
    return !this.isCurrentRun(runId) || run.sendAbortController?.signal.aborted === true || Boolean(run.supersededBy);
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
    return run;
  }
}
