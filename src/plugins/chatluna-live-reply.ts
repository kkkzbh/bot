import { gzipSync } from 'node:zlib';
import type { Session } from 'koishi';
import {
  calculateSmartSendDelayMs,
  renderOutboundMessageSegmentsRaw,
  type OutboundMessagePlan,
  type OutboundMessageSegment,
} from './message-send-utils.js';
import { resolveSessionDisplayName } from './session-user-name.js';

export interface LiveReplyConfig {
  liveReplyEnabled?: boolean;
  liveReplyCollectWindowMs?: number;
  liveReplyMaxPendingMessages?: number;
  liveReplyHistoryRewriteFallback?: 'queue' | string;
}

export interface LiveReplyRuntimeConfig {
  enabled: boolean;
  collectWindowMs: number;
  maxPendingMessages: number;
  historyRewriteFallback: 'queue';
}

export interface LiveReplyRoomLike {
  roomId?: number | string;
  conversationId?: string;
  model?: string;
  preset?: string;
  chatMode?: string;
  [key: string]: unknown;
}

export interface LiveReplyDatabaseLike {
  get(table: string, query: Record<string, unknown>): Promise<any[]>;
  upsert(table: string, rows: Record<string, unknown>[]): Promise<unknown>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
}

export interface LiveReplyLoggerLike {
  warn(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
}

export interface LiveReplyInterrupt {
  isDirect: boolean;
  text: string;
  displayName: string;
  userId: string;
}

interface LiveReplyWaiter {
  room: LiveReplyRoomLike;
  messageId?: string;
  interrupt: LiveReplyInterrupt;
  resolve: (decision: LiveReplyWaiterDecision) => void;
}

interface LiveReplyDecisionPromise {
  promise: Promise<LiveReplyDrainDecision>;
  resolve: (decision: LiveReplyDrainDecision) => void;
}

type LiveReplyStatus = 'idle' | 'draining' | 'collecting' | 'queueing';

interface LiveReplyScopeState {
  status: LiveReplyStatus;
  room?: LiveReplyRoomLike;
  conversationId?: string;
  activeMessageId?: string;
  committedSegments: OutboundMessageSegment[];
  draftSegments: OutboundMessageSegment[];
  pendingInterrupts: LiveReplyInterrupt[];
  collectTimer?: NodeJS.Timeout;
  carrierWaiters: LiveReplyWaiter[];
  decision?: LiveReplyDecisionPromise;
  cancelDraft?: () => void;
}

export interface StoredConversationRecord {
  id: string;
  latestId?: string | null;
  additional_kwargs?: string | null;
  updatedAt?: number | Date;
}

export interface StoredMessageRecord {
  id: string;
  role?: string | null;
  parent?: string | null;
  conversation?: string | null;
  additional_kwargs?: string | null;
  additional_kwargs_binary?: unknown;
  tool_call_id?: string | null;
  tool_calls?: unknown;
  name?: string | null;
  rawId?: string | null;
  text?: string | null;
  content?: unknown;
}

export type LiveReplyHistoryRewriteResult =
  | { kind: 'deleted'; latestId: string | null; messageId: string }
  | { kind: 'truncated'; latestId: string; messageId: string; text: string }
  | { kind: 'fallback'; reason: string };

type LiveReplyDrainDecision = { kind: 'rewrite' } | { kind: 'queue' };
export type LiveReplyWaiterDecision = 'continue' | 'stop';

export interface LiveReplyCoordinatorOptions {
  runtime: LiveReplyRuntimeConfig;
  database: LiveReplyDatabaseLike;
  clearCache: (room: LiveReplyRoomLike) => Promise<unknown>;
  inject: (options: { conversationId: string; instruction: string }) => void;
  logger: LiveReplyLoggerLike;
}

export interface LiveReplyDraftRunOptions {
  cancelDraft?: () => void;
  abortSignal?: AbortSignal;
}

const coordinatorRegistry = new WeakMap<object, LiveReplyCoordinator>();

function clampToNatural(value: unknown, fallback: number, min = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function serializeStoredStringContent(text: string): ArrayBuffer {
  const buffer = gzipSync(Buffer.from(JSON.stringify(text), 'utf8'));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function hasStructuredToolCalls(value: unknown): boolean {
  if (value == null) return false;

  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized !== '' && normalized !== '{}' && normalized !== '[]' && normalized !== 'null';
  }

  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof ArrayBuffer) return value.byteLength > 0;
  if (ArrayBuffer.isView(value)) return value.byteLength > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;

  return Boolean(value);
}

function isToolTail(message: StoredMessageRecord): boolean {
  const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id.trim() : '';
  if (toolCallId) return true;

  return hasStructuredToolCalls(message.tool_calls);
}

function createDecisionPromise(): LiveReplyDecisionPromise {
  let resolve: (decision: LiveReplyDrainDecision) => void = () => {};
  const promise = new Promise<LiveReplyDrainDecision>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyInterrupt(interrupt: LiveReplyInterrupt): string {
  if (interrupt.isDirect) return interrupt.text;
  return `[${interrupt.displayName}/${interrupt.userId}] ${interrupt.text}`;
}

function buildContinuationInstruction(committedText: string, interrupts: LiveReplyInterrupt[]): string {
  const lines = ['这是一次发送期被插话打断后的续写。'];

  if (committedText.trim()) {
    lines.push('以下内容已经发给用户，不要重复：');
    lines.push(committedText);
  }

  if (interrupts.length > 0) {
    lines.push('当前用户最新消息已经作为本轮输入。你还需要同时兼顾这些刚刚到来的补充消息：');
    lines.push(...interrupts.map((interrupt) => stringifyInterrupt(interrupt)));
  } else {
    lines.push('当前用户最新消息已经作为本轮输入，请直接自然承接，不要重新开场。');
  }

  return lines.join('\n');
}

function resetScopeDraft(scope: LiveReplyScopeState): void {
  scope.committedSegments = [];
  scope.draftSegments = [];
  scope.cancelDraft = undefined;
}

function clearCollectionTimer(scope: LiveReplyScopeState): void {
  if (!scope.collectTimer) return;
  clearTimeout(scope.collectTimer);
  scope.collectTimer = undefined;
}

function isCollectingScope(scope: LiveReplyScopeState): boolean {
  return scope.status === 'collecting';
}

function ensurePlainText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

function getOrCreateScope(scopes: Map<string, LiveReplyScopeState>, scopeKey: string): LiveReplyScopeState {
  const existing = scopes.get(scopeKey);
  if (existing) return existing;

  const created: LiveReplyScopeState = {
    status: 'idle',
    committedSegments: [],
    draftSegments: [],
    pendingInterrupts: [],
    carrierWaiters: [],
  };
  scopes.set(scopeKey, created);
  return created;
}

export function registerLiveReplyCoordinator(owner: object, coordinator: LiveReplyCoordinator | null): void {
  if (coordinator) {
    coordinatorRegistry.set(owner, coordinator);
    return;
  }

  coordinatorRegistry.delete(owner);
}

export function getLiveReplyCoordinator(owner: object): LiveReplyCoordinator | null {
  return coordinatorRegistry.get(owner) ?? null;
}

export function resolveLiveReplyRuntimeConfig(config: LiveReplyConfig = {}): LiveReplyRuntimeConfig {
  const envEnabled = resolveBoolean(process.env.QQBOT_LIVE_REPLY_ENABLED, false);

  return {
    enabled: config.liveReplyEnabled ?? envEnabled,
    collectWindowMs: clampToNatural(
      config.liveReplyCollectWindowMs ?? process.env.QQBOT_LIVE_REPLY_COLLECT_WINDOW_MS,
      600,
    ),
    maxPendingMessages: clampToNatural(
      config.liveReplyMaxPendingMessages ?? process.env.QQBOT_LIVE_REPLY_MAX_PENDING_MESSAGES,
      8,
    ),
    historyRewriteFallback:
      (config.liveReplyHistoryRewriteFallback ?? process.env.QQBOT_LIVE_REPLY_HISTORY_REWRITE_FALLBACK) === 'queue'
        ? 'queue'
        : 'queue',
  };
}

export function extractIncomingSessionText(session: Session): string {
  const stripped = session.stripped?.content?.trim();
  if (stripped) return stripped;
  return session.content?.trim() ?? '';
}

export function createLiveReplyInterrupt(session: Session): LiveReplyInterrupt {
  return {
    isDirect: !!session.isDirect,
    text: ensurePlainText(extractIncomingSessionText(session)),
    displayName: resolveSessionDisplayName(session),
    userId: session.userId?.trim() || '用户',
  };
}

export function readCommittedDraftText(scope: {
  committedSegments: OutboundMessageSegment[];
}): string {
  return renderOutboundMessageSegmentsRaw(scope.committedSegments);
}

export async function rewriteConversationTailForLiveReply(args: {
  database: LiveReplyDatabaseLike;
  conversationId: string;
  committedText: string;
  logger: LiveReplyLoggerLike;
}): Promise<LiveReplyHistoryRewriteResult> {
  const { database, conversationId, committedText, logger } = args;
  const [conversation] = (await database.get('chathub_conversation', {
    id: conversationId,
  })) as StoredConversationRecord[];

  if (!conversation?.id) {
    logger.warn('live reply rewrite skipped for %s: conversation not found.', conversationId);
    return { kind: 'fallback', reason: 'conversation-not-found' };
  }

  const latestId = conversation.latestId ?? null;
  if (!latestId) {
    logger.warn('live reply rewrite skipped for %s: conversation has no latestId.', conversationId);
    return { kind: 'fallback', reason: 'conversation-empty' };
  }

  const messages = (await database.get('chathub_message', {
    conversation: conversationId,
  })) as StoredMessageRecord[];
  const messageMap = new Map(messages.map((message) => [message.id, message]));

  const latest = messageMap.get(latestId);
  if (!latest) {
    logger.warn('live reply rewrite skipped for %s: latest message missing.', conversationId);
    return { kind: 'fallback', reason: 'broken-latest' };
  }

  if (latest.role !== 'ai') {
    logger.warn(
      'live reply rewrite skipped for %s: latest tail role is %s instead of ai.',
      conversationId,
      String(latest.role ?? ''),
    );
    return { kind: 'fallback', reason: 'latest-not-ai' };
  }

  if (isToolTail(latest)) {
    logger.warn('live reply rewrite skipped for %s: latest ai message contains tool metadata.', conversationId);
    return { kind: 'fallback', reason: 'tool-tail' };
  }

  const parent = latest.parent ? messageMap.get(latest.parent) : undefined;
  if (parent && (parent.role === 'tool' || parent.role === 'function')) {
    logger.warn('live reply rewrite skipped for %s: ai tail follows tool/function messages.', conversationId);
    return { kind: 'fallback', reason: 'tool-parent' };
  }

  const updatedAt = Date.now();
  if (!committedText.trim()) {
    await database.remove('chathub_message', {
      id: latest.id,
    });
    await database.upsert('chathub_conversation', [
      {
        ...conversation,
        latestId: latest.parent ?? null,
        updatedAt,
      },
    ]);
    return {
      kind: 'deleted',
      latestId: latest.parent ?? null,
      messageId: latest.id,
    };
  }

  await database.upsert('chathub_message', [
    {
      ...latest,
      text: committedText,
      content: serializeStoredStringContent(committedText),
    },
  ]);
  await database.upsert('chathub_conversation', [
    {
      ...conversation,
      latestId: latest.id,
      updatedAt,
    },
  ]);

  return {
    kind: 'truncated',
    latestId: latest.id,
    messageId: latest.id,
    text: committedText,
  };
}

export class LiveReplyCoordinator {
  private readonly runtime: LiveReplyRuntimeConfig;
  private readonly database: LiveReplyDatabaseLike;
  private readonly clearCache: (room: LiveReplyRoomLike) => Promise<unknown>;
  private readonly inject: (options: { conversationId: string; instruction: string }) => void;
  private readonly logger: LiveReplyLoggerLike;
  private readonly scopes = new Map<string, LiveReplyScopeState>();

  constructor(options: LiveReplyCoordinatorOptions) {
    this.runtime = options.runtime;
    this.database = options.database;
    this.clearCache = options.clearCache;
    this.inject = options.inject;
    this.logger = options.logger;
  }

  bindScope(scopeKey: string, room: LiveReplyRoomLike, messageId?: string): void {
    const scope = getOrCreateScope(this.scopes, scopeKey);
    scope.room = room;
    scope.conversationId = room.conversationId?.trim() || scope.conversationId;
    scope.activeMessageId = messageId ?? scope.activeMessageId;
  }

  shouldIntercept(scopeKey: string, room?: LiveReplyRoomLike): boolean {
    if (!this.runtime.enabled) return false;

    const scope = this.scopes.get(scopeKey);
    if (!scope) return false;
    if (scope.status !== 'draining' && scope.status !== 'collecting') return false;

    const activeConversationId = scope.conversationId?.trim();
    const nextConversationId = room?.conversationId?.trim();
    if (activeConversationId && nextConversationId && activeConversationId !== nextConversationId) {
      return false;
    }

    return true;
  }

  async waitForInterrupt(scopeKey: string, session: Session, room: LiveReplyRoomLike, messageId?: string): Promise<LiveReplyWaiterDecision> {
    const scope = getOrCreateScope(this.scopes, scopeKey);

    if (scope.status !== 'draining' && scope.status !== 'collecting') {
      return 'continue';
    }

    if (scope.carrierWaiters.length >= this.runtime.maxPendingMessages) {
      this.logger.warn(
        'live reply interrupt overflow for %s, falling back to queue (limit=%d).',
        scopeKey,
        this.runtime.maxPendingMessages,
      );
      await this.resolveCollectionAsQueue(scopeKey);
      return 'continue';
    }

    const interrupt = createLiveReplyInterrupt(session);
    return new Promise<LiveReplyWaiterDecision>((resolve) => {
      scope.pendingInterrupts.push(interrupt);
      scope.carrierWaiters.push({
        room,
        messageId,
        interrupt,
        resolve,
      });

      if (!scope.decision) {
        scope.decision = createDecisionPromise();
      }

      if (scope.status === 'draining') {
        scope.status = 'collecting';
      }

      if (!scope.collectTimer) {
        scope.collectTimer = setTimeout(() => {
          void this.finalizeCollection(scopeKey).catch(async (error) => {
            this.logger.warn(
              'live reply finalize failed for %s: %s',
              scopeKey,
              error instanceof Error ? error.message : String(error),
            );
            await this.resolveCollectionAsQueue(scopeKey);
          });
        }, this.runtime.collectWindowMs);
      }
    });
  }

  async drainDraftPlan(
    scopeKey: string,
    draft: OutboundMessagePlan,
    sendSegment: (segment: OutboundMessageSegment) => Promise<unknown>,
    options: LiveReplyDraftRunOptions = {},
  ): Promise<void> {
    const scope = getOrCreateScope(this.scopes, scopeKey);
    clearCollectionTimer(scope);
    scope.pendingInterrupts = [];
    scope.carrierWaiters = [];
    scope.decision = undefined;
    scope.status = 'draining';
    scope.cancelDraft = options.cancelDraft;
    scope.committedSegments = [];
    scope.draftSegments = [...draft.segments];

    while (scope.draftSegments.length > 0) {
      const currentDecision = scope.decision as LiveReplyDecisionPromise | undefined;
      if (currentDecision) {
        const decision = await currentDecision.promise;
        if (decision.kind === 'rewrite') {
          resetScopeDraft(scope);
          scope.status = 'idle';
          scope.decision = undefined;
          return;
        }

        scope.status = 'queueing';
        scope.decision = undefined;
      }

      if (options.abortSignal?.aborted) {
        resetScopeDraft(scope);
        scope.status = 'idle';
        scope.decision = undefined;
        return;
      }

      const nextSegment = scope.draftSegments.shift();
      if (!nextSegment) break;

      await sendSegment(nextSegment);
      if (options.abortSignal?.aborted) {
        resetScopeDraft(scope);
        scope.status = 'idle';
        scope.decision = undefined;
        return;
      }

      scope.committedSegments.push(nextSegment);

      if (scope.draftSegments.length === 0) {
        if (isCollectingScope(scope)) {
          await this.resolveCollectionAsQueue(scopeKey);
        }
        break;
      }

      if (nextSegment.kind === 'text-line') {
        await sleep(calculateSmartSendDelayMs(nextSegment.content));
      }
    }

    clearCollectionTimer(scope);
    scope.pendingInterrupts = [];
    scope.carrierWaiters = [];
    scope.decision = undefined;
    scope.status = 'idle';
    resetScopeDraft(scope);
  }

  private async finalizeCollection(scopeKey: string): Promise<void> {
    const scope = this.scopes.get(scopeKey);
    if (!scope || scope.status !== 'collecting') return;

    clearCollectionTimer(scope);

    const waiters = [...scope.carrierWaiters];
    const pendingInterrupts = [...scope.pendingInterrupts];
    if (!waiters.length || !scope.decision) {
      await this.resolveCollectionAsQueue(scopeKey);
      return;
    }

    const carrier = waiters[waiters.length - 1];
    const conversationId = scope.conversationId?.trim();
    const room = scope.room;
    const committedText = readCommittedDraftText(scope);
    if (!conversationId || !room || scope.draftSegments.length < 1) {
      await this.resolveCollectionAsQueue(scopeKey);
      return;
    }

    const rewriteResult = await rewriteConversationTailForLiveReply({
      database: this.database,
      conversationId,
      committedText,
      logger: this.logger,
    });

    if (rewriteResult.kind === 'fallback') {
      if (this.runtime.historyRewriteFallback === 'queue') {
        await this.resolveCollectionAsQueue(scopeKey);
      }
      return;
    }

    await this.clearCache(room);
    this.inject({
      conversationId,
      instruction: buildContinuationInstruction(committedText, pendingInterrupts.slice(0, -1)),
    });
    scope.cancelDraft?.();

    scope.status = 'queueing';
    scope.room = carrier.room;
    scope.activeMessageId = carrier.messageId ?? scope.activeMessageId;
    waiters.slice(0, -1).forEach((waiter) => waiter.resolve('stop'));
    carrier.resolve('continue');

    scope.pendingInterrupts = [];
    scope.carrierWaiters = [];
    scope.decision.resolve({ kind: 'rewrite' });
  }

  private async resolveCollectionAsQueue(scopeKey: string): Promise<void> {
    const scope = this.scopes.get(scopeKey);
    if (!scope) return;

    clearCollectionTimer(scope);
    if (!scope.decision) {
      scope.decision = createDecisionPromise();
    }

    scope.status = 'queueing';
    const waiters = [...scope.carrierWaiters];
    waiters.forEach((waiter) => waiter.resolve('continue'));
    scope.pendingInterrupts = [];
    scope.carrierWaiters = [];
    scope.decision.resolve({ kind: 'queue' });
  }
}
