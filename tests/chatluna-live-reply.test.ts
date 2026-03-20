import { afterEach, describe, expect, it, vi } from 'vitest';

const promptAssemblyMocks = vi.hoisted(() => ({
  registerPromptFragment: vi.fn(),
}));

vi.mock('koishi', () => {
  class MockLogger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
  };
});

vi.mock('../src/plugins/prompt-assembly.js', () => ({
  beginPromptAssemblyTurn: vi.fn(),
  registerPromptFragment: promptAssemblyMocks.registerPromptFragment,
}));

import { apply } from '../src/plugins/chatluna-model-guard.js';
import {
  LiveReplyCoordinator,
  rewriteConversationTailForLiveReply,
  type LiveReplyDatabaseLike,
  type StoredConversationRecord,
  type StoredMessageRecord,
} from '../src/plugins/chatluna-live-reply.js';
import { parseOutboundMessagePlan } from '../src/plugins/message-send-utils.js';

type Middleware = (session: Record<string, any>, next: () => Promise<unknown>) => Promise<unknown>;
type BeforeSendHandler = (session: Record<string, any>, options: Record<string, any>) => Promise<boolean | void>;
type GateHandler = (session: Record<string, any>, context: Record<string, any>) => Promise<number>;

type TableName = 'chathub_conversation' | 'chathub_message';

class MemoryDatabase implements LiveReplyDatabaseLike {
  private readonly tables = new Map<TableName, Record<string, any>[]>([
    ['chathub_conversation', []],
    ['chathub_message', []],
  ]);

  seed(table: TableName, rows: Record<string, any>[]): void {
    this.tables.set(
      table,
      rows.map((row) => ({ ...row })),
    );
  }

  async get(table: string, query: Record<string, unknown>): Promise<any[]> {
    return (this.tables.get(table as TableName) ?? [])
      .filter((row) => matches(row, query))
      .map((row) => ({ ...row }));
  }

  async upsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
    const current = [...(this.tables.get(table as TableName) ?? [])];
    for (const row of rows) {
      const index = current.findIndex((item) => item.id === row.id);
      if (index >= 0) {
        current[index] = { ...current[index], ...row };
      } else {
        current.push({ ...row });
      }
    }
    this.tables.set(table as TableName, current);
  }

  async remove(table: string, query: Record<string, unknown>): Promise<void> {
    const current = this.tables.get(table as TableName) ?? [];
    this.tables.set(
      table as TableName,
      current.filter((row) => !matches(row, query)),
    );
  }
}

function matches(row: Record<string, unknown>, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, expected]) => {
    if (Array.isArray(expected)) {
      return expected.includes(row[key]);
    }

    if (expected && typeof expected === 'object' && '$in' in expected) {
      return Array.isArray((expected as { $in?: unknown[] }).$in) && (expected as { $in: unknown[] }).$in.includes(row[key]);
    }

    return row[key] === expected;
  });
}

function createChainBuilder(store: Map<string, GateHandler>): {
  middleware: (name: string, middleware: GateHandler) => { after: (name: string) => any; before: (name: string) => any };
} {
  return {
    middleware: (name, middleware) => {
      store.set(name, middleware);
      const builder = {
        after: () => builder,
        before: () => builder,
      };
      return builder;
    },
  };
}

function createHarness(config: Record<string, unknown> = {}) {
  promptAssemblyMocks.registerPromptFragment.mockReset();
  const middlewares: Middleware[] = [];
  const eventHandlers = new Map<string, Function[]>();
  const chainMiddlewares = new Map<string, GateHandler>();
  const database = new MemoryDatabase();
  const clearCache = vi.fn(async () => true);
  const inject = vi.fn();

  const ctx = {
    database,
    chatluna: {
      clearCache,
      contextManager: { inject },
      chatChain: createChainBuilder(chainMiddlewares),
    },
    middleware: vi.fn((handler: Middleware) => {
      middlewares.push(handler);
    }),
    on: vi.fn((event: string, handler: Function) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    }),
  };

  apply(ctx as never, {
    liveReplyEnabled: true,
    liveReplyCollectWindowMs: 600,
    liveReplyMaxPendingMessages: 8,
    liveReplyHistoryRewriteFallback: 'queue',
    ...config,
  });

  for (const handler of eventHandlers.get('ready') ?? []) {
    handler();
  }

  const beforeSendHandlers = eventHandlers.get('before-send') ?? [];
  if (!middlewares[0] || !beforeSendHandlers[0]) {
    throw new Error('chatluna-model-guard did not register expected handlers');
  }

  const gate = chainMiddlewares.get('qqbot_live_replan_gate');
  if (!gate) {
    throw new Error('live reply gate middleware was not registered');
  }

  return {
    inbound: middlewares[0],
    beforeSend: beforeSendHandlers[0] as BeforeSendHandler,
    gate,
    database,
    clearCache,
    inject,
  };
}

function seedConversation(database: MemoryDatabase, conversationId: string, assistantText: string, options: {
  latestRole?: string;
  assistantId?: string;
  assistantParentRole?: string;
  toolCalls?: unknown;
} = {}): void {
  const humanId = 'human-1';
  const parentRole = options.assistantParentRole ?? 'human';
  const assistantParentId = parentRole === 'human' ? humanId : 'tool-1';
  const rows: StoredMessageRecord[] = [
    {
      id: humanId,
      role: 'human',
      parent: null,
      conversation: conversationId,
      text: '上一轮用户消息',
    },
  ];

  if (parentRole !== 'human') {
    rows.push({
      id: 'tool-1',
      role: parentRole,
      parent: humanId,
      conversation: conversationId,
      text: 'tool payload',
    });
  }

  rows.push({
    id: options.assistantId ?? 'ai-1',
    role: options.latestRole ?? 'ai',
    parent: assistantParentId,
    conversation: conversationId,
    text: assistantText,
    tool_calls: options.toolCalls ?? '{}',
  });

  database.seed('chathub_conversation', [
    {
      id: conversationId,
      latestId: options.assistantId ?? 'ai-1',
    } satisfies StoredConversationRecord,
  ]);
  database.seed('chathub_message', rows);
}

function createSession(sent: string[], overrides: Record<string, unknown> = {}): Record<string, any> {
  const content = String(overrides.content ?? '');
  const sendImpl =
    (overrides.sendImpl as ((content: string) => Promise<unknown>) | undefined) ??
    (async (message: string) => {
      sent.push(message);
      return ['msg-id'];
    });

  return {
    platform: 'onebot',
    isDirect: false,
    channelId: 'group-100',
    guildId: 'group-100',
    userId: 'u1',
    username: '用户',
    author: { name: '用户' },
    content,
    stripped: { content },
    bot: {
      selfId: 'bot-1',
      sendMessage: vi.fn(async (_channelId: string, message: string) => {
        return sendImpl(message);
      }),
    },
    ...overrides,
  };
}

function createSendSession(sourceSession: Record<string, any>, content: string): Record<string, any> {
  return {
    platform: sourceSession.platform,
    isDirect: sourceSession.isDirect,
    channelId: sourceSession.channelId,
    guildId: sourceSession.guildId,
    userId: sourceSession.userId,
    username: sourceSession.username,
    author: sourceSession.author,
    bot: sourceSession.bot,
    content,
  };
}

function createGateContext(room: Record<string, unknown>, messageId: string, content: string): Record<string, any> {
  return {
    config: {},
    options: {
      room,
      messageId,
      inputMessage: {
        content,
      },
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('live reply conversation rewrite', () => {
  it('deletes the latest ai message when nothing has been sent yet', async () => {
    const database = new MemoryDatabase();
    seedConversation(database, 'conv-delete', '未发出的整段回复');

    const result = await rewriteConversationTailForLiveReply({
      database,
      conversationId: 'conv-delete',
      committedText: '',
      logger: { warn: vi.fn() },
    });

    expect(result).toEqual({
      kind: 'deleted',
      latestId: 'human-1',
      messageId: 'ai-1',
    });
    await expect(database.get('chathub_message', { id: 'ai-1' })).resolves.toEqual([]);
    await expect(database.get('chathub_conversation', { id: 'conv-delete' })).resolves.toEqual([
      expect.objectContaining({ latestId: 'human-1' }),
    ]);
  });

  it('falls back to queue when the latest tail is not a plain ai message', async () => {
    const database = new MemoryDatabase();
    seedConversation(database, 'conv-fallback', '工具链回复', {
      assistantParentRole: 'tool',
    });

    const logger = { warn: vi.fn() };
    const result = await rewriteConversationTailForLiveReply({
      database,
      conversationId: 'conv-fallback',
      committedText: '已发送前缀',
      logger,
    });

    expect(result).toEqual({
      kind: 'fallback',
      reason: 'tool-parent',
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('treats empty structured tool_calls metadata as a normal ai tail', async () => {
    const database = new MemoryDatabase();
    seedConversation(database, 'conv-empty-tool-calls', '已发前缀\n未发尾部', {
      toolCalls: [],
    });

    const result = await rewriteConversationTailForLiveReply({
      database,
      conversationId: 'conv-empty-tool-calls',
      committedText: '已发前缀',
      logger: { warn: vi.fn() },
    });

    expect(result).toEqual({
      kind: 'truncated',
      latestId: 'ai-1',
      messageId: 'ai-1',
      text: '已发前缀',
    });
    await expect(database.get('chathub_message', { id: 'ai-1' })).resolves.toEqual([
      expect.objectContaining({ text: '已发前缀' }),
    ]);
  });
});

describe('live reply gate + drain', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops unsent tail and only lets the latest carrier continue after the collect window', async () => {
    vi.useFakeTimers();

    const { inbound, beforeSend, gate, database, clearCache, inject } = createHarness();
    seedConversation(database, 'conv-live-1', '第一句\n第二句\n第三句', {
      toolCalls: [],
    });
    const room = { roomId: 1, conversationId: 'conv-live-1', model: 'deepseek/deepseek-chat' };
    const sent: string[] = [];

    const firstSession = createSession(sent, {
      userId: 'u1',
      username: '甲',
      author: { name: '甲' },
      content: '原始提问',
    });
    const firstSendSession = createSendSession(firstSession, '第一句\n第二句\n第三句');

    await inbound(firstSession, async () => {
      await gate(firstSession, createGateContext(room, 'msg-1', '原始提问'));
      return beforeSend(firstSendSession, {});
    });

    await flushMicrotasks();
    expect(sent).toEqual(['第一句']);

    const secondSession = createSession(sent, {
      userId: 'u2',
      username: '乙',
      author: { name: '乙' },
      content: '我补充第一点',
    });
    const thirdSession = createSession(sent, {
      userId: 'u3',
      username: '丙',
      author: { name: '丙' },
      content: '再补一句',
    });

    const secondPending = inbound(secondSession, async () =>
      gate(secondSession, createGateContext(room, 'msg-2', '我补充第一点')),
    );
    const thirdPending = inbound(thirdSession, async () =>
      gate(thirdSession, createGateContext(room, 'msg-3', '再补一句')),
    );

    await flushMicrotasks();
    expect(sent).toEqual(['第一句']);
    expect(clearCache).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    const [secondResult, thirdResult] = await Promise.all([secondPending, thirdPending]);

    expect(secondResult).toBe(1);
    expect(thirdResult).toBe(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual(['第一句']);
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(promptAssemblyMocks.registerPromptFragment).toHaveBeenCalledTimes(1);

    const injected = promptAssemblyMocks.registerPromptFragment.mock.calls[0];
    expect(injected?.[0]).toBe('conv-live-1');
    expect(injected?.[1]).toMatchObject({
      source: 'qqbot_live_reply_continuation',
      authority: 'assistant_state',
      trust: 'trusted',
      ttl: 'turn',
    });
    expect(String((injected?.[1] as { payload?: { value?: unknown } })?.payload?.value ?? '')).toContain('第一句');
    expect(String((injected?.[1] as { payload?: { value?: unknown } })?.payload?.value ?? '')).toContain(
      '[乙/u2] 我补充第一点',
    );

    await expect(database.get('chathub_message', { id: 'ai-1' })).resolves.toEqual([
      expect.objectContaining({ text: '第一句' }),
    ]);
  });

  it('falls back to queue instead of hanging when rewrite throws unexpectedly', async () => {
    vi.useFakeTimers();

    const harness = createHarness();
    seedConversation(harness.database, 'conv-live-error', '第一句\n第二句\n第三句');
    const room = { roomId: 1, conversationId: 'conv-live-error', model: 'deepseek/deepseek-chat' };
    const sent: string[] = [];

    const originalGet = harness.database.get.bind(harness.database);
    harness.database.get = vi.fn(async (table: string, query: Record<string, unknown>) => {
      if (table === 'chathub_conversation') {
        throw new Error('boom');
      }
      return originalGet(table, query);
    });

    const firstSession = createSession(sent, {
      userId: 'u1',
      username: '甲',
      author: { name: '甲' },
      content: '原始提问',
    });
    const firstSendSession = createSendSession(firstSession, '第一句\n第二句\n第三句');

    await harness.inbound(firstSession, async () => {
      await harness.gate(firstSession, createGateContext(room, 'msg-live-error-1', '原始提问'));
      return harness.beforeSend(firstSendSession, {});
    });

    await flushMicrotasks();
    expect(sent).toEqual(['第一句']);

    const interruptSession = createSession(sent, {
      userId: 'u2',
      username: '乙',
      author: { name: '乙' },
      content: '打断一下',
    });

    const interruptPending = harness.inbound(interruptSession, async () =>
      harness.gate(interruptSession, createGateContext(room, 'msg-live-error-2', '打断一下')),
    );

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(600);
    await expect(interruptPending).resolves.toBe(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual(['第一句']);
    expect(harness.clearCache).not.toHaveBeenCalled();
  });

  it('keeps private sessions isolated by peer', async () => {
    vi.useFakeTimers();

    const harness = createHarness();
    const room = { roomId: 1, conversationId: 'conv-private-1', model: 'deepseek/deepseek-chat' };
    const sent: string[] = [];
    seedConversation(harness.database, 'conv-private-1', '第一句\n第二句');

    const privateSession = createSession(sent, {
      isDirect: true,
      channelId: 'private-u1',
      guildId: undefined,
      userId: 'u1',
      username: '小明',
      author: { name: '小明' },
      content: '私聊原始提问',
    });
    const privateSendSession = createSendSession(privateSession, '第一句\n第二句');

    await harness.inbound(privateSession, async () => {
      await harness.gate(privateSession, createGateContext(room, 'msg-private-1', '私聊原始提问'));
      return harness.beforeSend(privateSendSession, {});
    });

    await flushMicrotasks();
    expect(sent).toEqual(['第一句']);

    const samePeer = createSession(sent, {
      isDirect: true,
      channelId: 'private-u1',
      guildId: undefined,
      userId: 'u1',
      username: '小明',
      author: { name: '小明' },
      content: '继续说',
    });
    const otherPeer = createSession(sent, {
      isDirect: true,
      channelId: 'private-u2',
      guildId: undefined,
      userId: 'u2',
      username: '路人',
      author: { name: '路人' },
      content: '不相关私聊',
    });

    const samePending = harness.inbound(samePeer, async () =>
      harness.gate(samePeer, createGateContext(room, 'msg-private-2', '继续说')),
    );
    const otherResult = await harness.inbound(otherPeer, async () =>
      harness.gate(
        otherPeer,
        createGateContext({ roomId: 2, conversationId: 'conv-private-2', model: 'deepseek/deepseek-chat' }, 'msg-other', '不相关私聊'),
      ),
    );

    expect(otherResult).toBe(2);

    await vi.advanceTimersByTimeAsync(600);
    await expect(samePending).resolves.toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sent).toEqual(['第一句']);
    expect(harness.clearCache).toHaveBeenCalledTimes(1);
  });

  it('preserves committed voice tags in continuation text and drops unsent tail after rewrite', async () => {
    vi.useFakeTimers();

    const database = new MemoryDatabase();
    seedConversation(database, 'conv-voice-tail', '<qqbot-voice>\n先发语音\n</qqbot-voice>\n尾句\n<qqbot-voice>\n后发语音\n</qqbot-voice>');
    const clearCache = vi.fn(async () => true);
    const inject = vi.fn();
    const coordinator = new LiveReplyCoordinator({
      runtime: {
        enabled: true,
        collectWindowMs: 600,
        maxPendingMessages: 8,
        historyRewriteFallback: 'queue',
      },
      database,
      clearCache,
      inject,
      logger: { warn: vi.fn() },
    });

    const room = { roomId: 1, conversationId: 'conv-voice-tail', model: 'deepseek/deepseek-chat' };
    coordinator.bindScope('scope-voice-tail', room, 'msg-voice-1');

    const sent: string[] = [];
    const plan = parseOutboundMessagePlan('<qqbot-voice>\n先发语音\n</qqbot-voice>\n尾句\n<qqbot-voice>\n后发语音\n</qqbot-voice>');
    const drainPending = coordinator.drainDraftPlan('scope-voice-tail', plan, async (segment) => {
      if (segment.kind === 'voice-block') {
        if (segment.content === '先发语音') {
          sent.push(`voice:${segment.content}`);
        }
        return;
      }

      sent.push(`text:${segment.content}`);
    });

    await flushMicrotasks();
    expect(sent).toEqual(['voice:先发语音', 'text:尾句']);

    const interruptPending = coordinator.waitForInterrupt(
      'scope-voice-tail',
      createSession([], {
        userId: 'u9',
        username: '丁',
        author: { name: '丁' },
        content: '插话',
      }) as never,
      room,
      'msg-voice-2',
    );

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(600);
    await expect(interruptPending).resolves.toBe('continue');
    await vi.runAllTimersAsync();
    await drainPending;

    expect(sent).toEqual(['voice:先发语音', 'text:尾句']);
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(String(inject.mock.calls[0]?.[0]?.instruction ?? inject.mock.calls[0]?.[0]?.value ?? '')).toContain(
      '<qqbot-voice>\n先发语音\n</qqbot-voice>',
    );
    expect(String(inject.mock.calls[0]?.[0]?.instruction ?? inject.mock.calls[0]?.[0]?.value ?? '')).toContain('尾句');
    await expect(database.get('chathub_message', { id: 'ai-1' })).resolves.toEqual([
      expect.objectContaining({ text: '<qqbot-voice>\n先发语音\n</qqbot-voice>\n尾句' }),
    ]);
  });

  it('stops the old draft and only lets the latest waiter continue when rewrite falls back to queue', async () => {
    vi.useFakeTimers();

    const database = new MemoryDatabase();
    seedConversation(database, 'conv-queue-fallback', '旧回复', {
      assistantParentRole: 'tool',
    });
    const clearCache = vi.fn(async () => true);
    const inject = vi.fn();
    const coordinator = new LiveReplyCoordinator({
      runtime: {
        enabled: true,
        collectWindowMs: 600,
        maxPendingMessages: 8,
        historyRewriteFallback: 'queue',
      },
      database,
      clearCache,
      inject,
      logger: { warn: vi.fn() },
    });

    const room = { roomId: 1, conversationId: 'conv-queue-fallback', model: 'deepseek/deepseek-chat' };
    coordinator.bindScope('scope-queue-fallback', room, 'msg-old-1');

    const sent: string[] = [];
    const plan = parseOutboundMessagePlan('第一句\n第二句');
    const drainPending = coordinator.drainDraftPlan('scope-queue-fallback', plan, async (segment) => {
      sent.push(`${segment.kind}:${segment.content}`);
    });

    await flushMicrotasks();
    expect(sent).toEqual(['text-line:第一句']);

    const firstInterrupt = coordinator.waitForInterrupt(
      'scope-queue-fallback',
      createSession([], {
        userId: 'u10',
        username: '甲',
        author: { name: '甲' },
        content: '先等等',
      }) as never,
      room,
      'msg-new-1',
    );
    const secondInterrupt = coordinator.waitForInterrupt(
      'scope-queue-fallback',
      createSession([], {
        userId: 'u11',
        username: '乙',
        author: { name: '乙' },
        content: '我再补一句',
      }) as never,
      room,
      'msg-new-2',
    );

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(600);
    await expect(firstInterrupt).resolves.toBe('stop');
    await expect(secondInterrupt).resolves.toBe('continue');
    await vi.runAllTimersAsync();
    await drainPending;

    expect(sent).toEqual(['text-line:第一句']);
    expect(clearCache).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
    await expect(database.get('chathub_message', { id: 'ai-1' })).resolves.toEqual([
      expect.objectContaining({ text: '旧回复' }),
    ]);
  });
});
