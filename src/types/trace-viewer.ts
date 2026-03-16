import 'koishi';

export type TracePhase =
  | 'inbound'
  | 'route'
  | 'prepare'
  | 'llm-input'
  | 'tool-loop'
  | 'llm-output'
  | 'outbound'
  | 'error';

export interface TraceSessionRecord {
  id: number;
  traceId: string;
  route: string;
  status: string;
  platform: string | null;
  channelId: string | null;
  guildId: string | null;
  userId: string | null;
  conversationId: string | null;
  requestId: string | null;
  model: string | null;
  inputPreview: string | null;
  finalReplyPreview: string | null;
  errorText: string | null;
  hasToolCall: number;
  createdAt: number;
  updatedAt: number;
}

export interface TraceEventRecord {
  id: number;
  traceId: string;
  seq: number;
  phase: TracePhase;
  kind: string;
  payload: string;
  truncated: number;
  createdAt: number;
}

export interface TraceInjectedPromptRecord {
  source: string;
  sourceLabel: string;
  stage: string;
  content: string;
  createdAt: number;
}

export interface TraceInjectedPromptView extends TraceInjectedPromptRecord {
  createdAtText: string;
}

export interface TraceStartOptions {
  session?: {
    platform?: string;
    channelId?: string;
    guildId?: string;
    userId?: string;
  } | null;
  route: string;
  input?: string | null;
}

export interface TraceRecordOptions {
  traceId?: string | null;
  phase: TracePhase;
  kind: string;
  payload?: unknown;
}

export interface TraceFinishOptions {
  traceId?: string | null;
  status?: string;
  finalReply?: string | null;
  error?: string | null;
  requestId?: string | null;
  conversationId?: string | null;
  model?: string | null;
  hasToolCall?: boolean;
}

export interface TraceViewerServiceLike {
  ensureTrace(options: TraceStartOptions): string;
  bindTrace(session: { state?: Record<string, unknown> | undefined } | null | undefined, traceId: string): void;
  getTraceId(session?: { state?: Record<string, unknown> | undefined } | null): string | null;
  getCurrentTraceId(): string | null;
  runWithTrace<T>(traceId: string, fn: () => Promise<T>): Promise<T>;
  record(options: TraceRecordOptions): void;
  update(traceId: string, patch: Partial<TraceSessionRecord>): void;
  finish(options: TraceFinishOptions): void;
}

declare module 'koishi' {
  interface Tables {
    trace_session: TraceSessionRecord;
    trace_event: TraceEventRecord;
  }

  interface Context {
    traceViewer?: TraceViewerServiceLike;
  }
}
