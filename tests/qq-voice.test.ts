import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi-plugin-chatluna/chains', () => ({
  ChainMiddlewareRunStatus: { STOP: 1, CONTINUE: 0 },
}));

const promptAssemblyMocks = vi.hoisted(() => ({
  registerPromptFragment: vi.fn(),
  peekPromptFragments: vi.fn(() => []),
  clearPromptAssemblyTurn: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
    min: () => MockSchemaNode;
    max: () => MockSchemaNode;
    role: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
    min: () => createSchemaNode(),
    max: () => createSchemaNode(),
    role: () => createSchemaNode(),
  });

  const parseAttrs = (input: string) => {
    const attrs: Record<string, string> = {};
    for (const matched of input.matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[matched[1]] = matched[2];
    }
    return attrs;
  };

  const parse = (content: string) => {
    const elements: Array<{ type: string; attrs: Record<string, string>; children: never[] }> = [];
    const pattern = /<(audio|at)\b([\s\S]*?)\/>/gi;
    let lastIndex = 0;
    let matched: RegExpExecArray | null;

    while ((matched = pattern.exec(content))) {
      const text = content.slice(lastIndex, matched.index);
      if (text) {
        elements.push({ type: 'text', attrs: { content: text }, children: [] });
      }
      elements.push({ type: matched[1], attrs: parseAttrs(matched[2] ?? ''), children: [] });
      lastIndex = pattern.lastIndex;
    }

    const tail = content.slice(lastIndex);
    if (tail) {
      elements.push({ type: 'text', attrs: { content: tail }, children: [] });
    }

    return elements;
  };

  class MockLogger {
    info(...args: any[]): void {
      loggerMocks.info(...args);
    }
    warn(...args: any[]): void {
      loggerMocks.warn(...args);
    }
    error(...args: any[]): void {
      loggerMocks.error(...args);
    }
    debug(...args: any[]): void {
      loggerMocks.debug(...args);
    }
  }

  const hFactory = ((type: string, attrs: Record<string, unknown> = {}, children: unknown[] = []) => ({
    type,
    attrs,
    children,
  })) as unknown as {
    (type: string, attrs?: Record<string, unknown>, children?: unknown[]): Record<string, unknown>;
    parse: typeof parse;
    text: (content: string) => Record<string, unknown>;
    audio: (src: string) => Record<string, unknown>;
    image: (source: string | Buffer, mime?: string) => Record<string, unknown>;
  };
  hFactory.parse = parse;
  hFactory.text = (content: string) => ({
    type: 'text',
    attrs: { content },
    children: [],
    toString: () => content,
  });
  hFactory.audio = (src: string) => ({
    type: 'audio',
    attrs: { src },
    children: [],
    toString: () => `<audio src="${src}"/>`,
  });
  hFactory.image = (source: string | Buffer, mime?: string) => ({
    type: 'img',
    attrs: {
      src:
        typeof source === 'string'
          ? source
          : `data:${mime};base64,${source.toString('base64')}`,
    },
    children: [],
    toString: () =>
      typeof source === 'string'
        ? `<img src="${source}" />`
        : `<img src="data:${mime};base64,${source.toString('base64')}" />`,
  });

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      boolean: () => createSchemaNode(),
      string: () => createSchemaNode(),
      natural: () => createSchemaNode(),
      number: () => createSchemaNode(),
      array: () => createSchemaNode(),
      union: () => createSchemaNode(),
      const: () => createSchemaNode(),
    },
    h: hFactory,
  };
});

vi.mock('../src/plugins/shared/prompt-context/index.js', async () => {
  const actual = await vi.importActual<typeof import('../src/plugins/shared/prompt-context/index.js')>(
    '../src/plugins/shared/prompt-context/index.js',
  );
  return {
    ...actual,
    registerPromptFragment: promptAssemblyMocks.registerPromptFragment,
    peekPromptFragments: promptAssemblyMocks.peekPromptFragments,
    clearPromptAssemblyTurn: promptAssemblyMocks.clearPromptAssemblyTurn,
  };
});

import { apply, inject } from '../src/plugins/reply/index.js';
import { ReplyRuntime } from '../src/plugins/reply/runtime/index.js';

type Middleware = (session: Record<string, any>, next: () => Promise<unknown>) => Promise<unknown>;
type EventHandler = (...args: any[]) => Promise<unknown> | unknown;
type ChainMiddleware = (session: Record<string, any>, context: Record<string, any>) => Promise<number>;

function createChainBuilder(store: Map<string, ChainMiddleware>) {
  return {
    middleware: (name: string, middleware: ChainMiddleware) => {
      store.set(name, middleware);
      const builder = {
        after: () => builder,
        before: () => builder,
      };
      return builder;
    },
  };
}

function createStoredResearchCompatibilityTail(conversationId: string) {
  return [
    {
      id: 'msg-human-1',
      role: 'human',
      parent: null,
      conversation: conversationId,
      text: '上一轮用户输入',
      content: null,
      name: null,
      tool_calls: null,
      tool_call_id: null,
      additional_kwargs_binary: null,
      rawId: null,
    },
    {
      id: 'msg-ai-1',
      role: 'ai',
      parent: 'msg-human-1',
      conversation: conversationId,
      text: '',
      content: null,
      name: null,
      tool_calls: [{ id: 'tool-submit', name: 'submit_reply_plan', args: { segments: [] } }],
      tool_call_id: null,
      additional_kwargs_binary: null,
      rawId: null,
    },
    {
      id: 'msg-tool-1',
      role: 'tool',
      parent: 'msg-ai-1',
      conversation: conversationId,
      text: '{"segments":[{"kind":"text","content":"旧回复"}]}',
      content: null,
      name: 'submit_reply_plan',
      tool_calls: null,
      tool_call_id: 'tool-submit',
      additional_kwargs_binary: null,
      rawId: null,
    },
  ];
}

function createHarness(overrides: {
  canSendRecord?: boolean;
  canSendRecordImpl?: () => Promise<boolean>;
  includeInternalRequest?: boolean;
  pluginConfig?: Record<string, unknown>;
  replyInterruptEnabled?: boolean;
  createChatModelImpl?: (model: string) => Promise<{ invoke: (input: unknown, options?: Record<string, unknown>) => Promise<{ content?: unknown }> }>;
  databaseGetImpl?: (table: string, query: Record<string, unknown>) => Promise<any[]>;
  databaseUpsertImpl?: (table: string, rows: Record<string, unknown>[]) => Promise<unknown>;
  databaseRemoveImpl?: (table: string, query: Record<string, unknown>) => Promise<unknown>;
  normalizeResearchReplyHistoryImpl?: (room: Record<string, unknown>, finalVisibleText: string) => Promise<unknown>;
} = {}) {
  const middlewares: Middleware[] = [];
  const events = new Map<string, EventHandler[]>();
  const chainMiddlewares = new Map<string, ChainMiddleware>();
  const inject = vi.fn();

  const database = {
    get: vi.fn(async (table: string, query: Record<string, unknown>) => {
      if (overrides.databaseGetImpl) {
        return overrides.databaseGetImpl(table, query);
      }
      if (table === 'chathub_conversation') {
        return [{ id: query.id ?? 'conv-1', latestId: 'msg-tool-1' }];
      }
      if (table === 'chathub_message') {
        return createStoredResearchCompatibilityTail(String(query.conversation ?? 'conv-1'));
      }
      return [];
    }),
    upsert: vi.fn(async (table: string, rows: Record<string, unknown>[]) => {
      if (overrides.databaseUpsertImpl) {
        return overrides.databaseUpsertImpl(table, rows);
      }
      return undefined;
    }),
    remove: vi.fn(async (table: string, query: Record<string, unknown>) => {
      if (overrides.databaseRemoveImpl) {
        return overrides.databaseRemoveImpl(table, query);
      }
      return undefined;
    }),
  };

  const internal: Record<string, any> = {
    canSendRecord: vi.fn(async () => {
      if (overrides.canSendRecordImpl) return overrides.canSendRecordImpl();
      return overrides.canSendRecord ?? true;
    }),
    getRecord: vi.fn(async (file: string) => ({ file })),
    sendPrivateMsg: vi.fn(async () => 'msg-id'),
    sendGroupMsg: vi.fn(async () => 'msg-id'),
  };

  const bot = {
    platform: 'onebot',
    selfId: 'bot-1',
    internal,
    sendMessage: vi.fn(async () => ['msg-id']),
  };

  if (overrides.includeInternalRequest !== false) {
    bot.internal._request = vi.fn(async () => ({ retcode: 0, data: { yes: true } }));
  }

  const chatluna = {
    contextManager: { inject },
    chatChain: {
      ...createChainBuilder(chainMiddlewares),
      receiveMessage: vi.fn(async () => false),
    },
    createChatModel: vi.fn(async (model: string) => ({
      value: await (overrides.createChatModelImpl?.(model) ??
        Promise.resolve({
          invoke: async () => ({
            content: JSON.stringify({
              decision: 'reply',
              messages: [{ modality: 'text', content: '默认回复' }],
            }),
          }),
        })),
    })),
    normalizeResearchReplyHistory: vi.fn(async (room: Record<string, unknown>, finalVisibleText: string) => {
      if (overrides.normalizeResearchReplyHistoryImpl) {
        return overrides.normalizeResearchReplyHistoryImpl(room, finalVisibleText);
      }
      return {
        deletedMessageIds: ['msg-tool-1', 'msg-ai-1'],
        latestId: 'msg-ai-normalized',
        normalizedMessageId: 'msg-ai-normalized',
        normalizedText: finalVisibleText,
      };
    }),
  };

  const ctx = {
    bots: [bot],
    chatluna,
    featurePolicy: {
      resolveFeatureEnabled: vi.fn(async (_session: Record<string, any>, featureKey: string) => {
        if (featureKey === 'QQBOT_REPLY_INTERRUPT_ENABLED') {
          return overrides.replyInterruptEnabled ?? false;
        }
        return true;
      }),
    },
    database,
    get: vi.fn((name: string) => {
      if (name !== 'chatluna') return undefined;
      return chatluna;
    }),
    middleware: vi.fn((handler: Middleware) => {
      middlewares.push(handler);
    }),
    on: vi.fn((name: string, handler: EventHandler) => {
      const existing = events.get(name) ?? [];
      existing.push(handler);
      events.set(name, existing);
    }),
  };

  apply(ctx as never, {
    enabled: true,
    inputEnabled: true,
    outputEnabled: true,
    asrBaseUrl: 'http://127.0.0.1:8081',
    ttsBaseUrl: 'http://127.0.0.1:8082',
    inputMaxSeconds: 60,
    outputMaxWords: 80,
    outputMaxSeconds: 45,
    transcribeTimeoutMs: 30_000,
    synthTimeoutMs: 300_000,
    ...overrides.pluginConfig,
  });

  return {
    inbound: middlewares[0],
    capabilityMiddleware: middlewares[1],
    ready: (events.get('ready') ?? [])[0],
    getPrepare: () => chainMiddlewares.get('qqbot_reply_runtime_prepare'),
    getToolMemoryState: () => chainMiddlewares.get('qqbot_reply_tool_memory_state'),
    getPolicy: () => chainMiddlewares.get('qqbot_reply_transport_policy'),
    getPromptCompiler: () => chainMiddlewares.get('qqbot_reply_prompt_compiler'),
    getExecutor: () => chainMiddlewares.get('qqbot_reply_plan_executor'),
    chatluna,
    inject,
    bot,
    database,
  };
}

function createSession(bot: Record<string, any>, overrides: Record<string, unknown> = {}): Record<string, any> {
  const content = overrides.content ?? '';
  return {
    platform: 'onebot',
    channelId: 'group-100',
    guildId: 'group-100',
    userId: 'u1',
    content,
    stripped: { content: String(overrides.strippedContent ?? content) },
    state: {},
    bot,
    send: vi.fn(async () => ['msg-id']),
    ...overrides,
  };
}

function createPluginRoom(conversationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId,
    roomId: 7,
    model: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
    preset: 'sakiko',
    chatMode: 'plugin',
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createReplyV2Response(input: string | Record<string, unknown>) {
  const reply =
    typeof input === 'string'
      ? {
          decision: 'reply',
          messages: [{ modality: 'text', content: input }],
        }
      : input;
  return {
    content: JSON.stringify(reply),
    additional_kwargs: {},
  };
}

function createRawReplyResponse(content: unknown) {
  return {
    content,
    additional_kwargs: {},
  };
}

function createStickerState(availableCount = 1) {
  const entry = {
    id: 'bored',
    file: 'images/personas/sakiko/bored.png',
    hash: 'hash-1',
    mime: 'image/png',
    scopes: ['persona:sakiko'],
    caption: '无语少女',
    keywords: ['无语'],
    moods: ['无语'],
    scenes: ['吐槽'],
    historyLabel: '无语少女',
    confidence: 0.95,
    buffer: Buffer.from('fake-sticker'),
  };

  return {
    catalog: {
      version: 1,
      generatedAt: '2026-03-23T00:00:00.000Z',
      model: 'test-model',
      entries: [entry],
      byId: new Map([[entry.id, entry]]),
    },
    preset: 'sakiko',
    availableCount,
  };
}

describe('qq voice plugin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    promptAssemblyMocks.registerPromptFragment.mockReset();
    promptAssemblyMocks.peekPromptFragments.mockReset();
    promptAssemblyMocks.peekPromptFragments.mockReturnValue([]);
    promptAssemblyMocks.clearPromptAssemblyTurn.mockReset();
    loggerMocks.info.mockReset();
    loggerMocks.warn.mockReset();
    loggerMocks.error.mockReset();
    loggerMocks.debug.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('declares required services so reply plan middleware can register on the live chat chain', () => {
    if (Array.isArray(inject)) {
      expect(inject).toEqual(expect.arrayContaining(['chatluna', 'database']));
      return;
    }

    expect(inject).toEqual(
      expect.objectContaining({
        required: expect.arrayContaining(['chatluna', 'database']),
      }),
    );
  });

  it('serializes turns instead of interrupting when reply interrupt is disabled', async () => {
    const { ready, getPrepare, getExecutor, bot } = createHarness({ replyInterruptEnabled: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const executor = getExecutor();
    const session1 = createSession(bot, {
      content: '第一条',
      strippedContent: '第一条',
    });
    const session2 = createSession(bot, {
      content: '第二条',
      strippedContent: '第二条',
    });
    const prepareContext1 = { options: { room: createPluginRoom('conv-serial') } };
    const prepareContext2 = { options: { room: createPluginRoom('conv-serial') } };

    await prepare?.(session1, prepareContext1);

    let secondPrepared = false;
    const prepareSecondPromise = prepare?.(session2, prepareContext2).then(() => {
      secondPrepared = true;
    });

    await flushMicrotasks();
    expect(secondPrepared).toBe(false);

    await executor?.(session1, {
      options: {
        room: createPluginRoom('conv-serial'),
        responseMessage: createReplyV2Response('第一条回复'),
      },
    });

    await prepareSecondPromise;
    expect(secondPrepared).toBe(true);
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['第一条回复']);
  });

  it('requeues self-interruptions to the group tail while keeping one shared group queue', async () => {
    vi.useFakeTimers();
    const { ready, getPrepare, getExecutor, bot } = createHarness({ replyInterruptEnabled: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const executor = getExecutor();
    const room = createPluginRoom('conv-group-tail');
    const sessionA1 = createSession(bot, {
      userId: 'u1',
      content: 'A1',
      strippedContent: 'A1',
      author: { nick: '甲', name: '甲' },
    });
    const sessionB = createSession(bot, {
      userId: 'u2',
      content: 'B1',
      strippedContent: 'B1',
      author: { nick: '乙', name: '乙' },
    });
    const sessionA2 = createSession(bot, {
      userId: 'u1',
      content: 'A2',
      strippedContent: 'A2',
      author: { nick: '甲', name: '甲' },
    });
    const contextA1 = {
      options: {
        room: { ...room },
        inputMessage: { content: 'A1', additional_kwargs: {} },
      },
    };
    const contextB = {
      options: {
        room: { ...room },
        inputMessage: { content: 'B1', additional_kwargs: {} },
      },
    };
    const contextA2 = {
      options: {
        room: { ...room },
        inputMessage: { content: 'A2', additional_kwargs: {} },
      },
    };

    await prepare?.(sessionA1, contextA1);

    let bResolved = false;
    const prepareBPromise = prepare?.(sessionB, contextB).then((result) => {
      bResolved = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(450);
    await flushMicrotasks();
    expect(bResolved).toBe(false);

    let a2Resolved = false;
    const prepareA2Promise = prepare?.(sessionA2, contextA2).then((result) => {
      a2Resolved = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(450);
    await flushMicrotasks();

    expect(bResolved).toBe(true);
    expect(a2Resolved).toBe(false);
    expect(contextB.options.inputMessage.content).toBe('B1');

    await executor?.(sessionB, {
      options: {
        room: { ...room },
        responseMessage: createReplyV2Response('回复B'),
      },
    });

    await prepareA2Promise;
    expect(a2Resolved).toBe(true);
    expect(contextA2.options.inputMessage.content).toBe('A1\nA2');
  });

  it('preserves image_url content when prepare rewrites aggregated input text', async () => {
    vi.useFakeTimers();
    const { ready, getPrepare, getExecutor, bot } = createHarness({ replyInterruptEnabled: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const executor = getExecutor();
    const room = createPluginRoom('conv-image-preserve');
    const sessionA1 = createSession(bot, {
      userId: 'u1',
      content: '先看一下',
      strippedContent: '先看一下',
      author: { nick: '甲', name: '甲' },
    });
    const sessionA2 = createSession(bot, {
      userId: 'u1',
      content: '这张图里是什么？',
      strippedContent: '这张图里是什么？',
      author: { nick: '甲', name: '甲' },
    });
    const contextA1 = {
      options: {
        room: { ...room },
        inputMessage: { content: '先看一下', additional_kwargs: {} },
      },
    };
    const contextA2 = {
      options: {
        room: { ...room },
        inputMessage: {
          content: [
            { type: 'text', text: '这张图里是什么？' },
            { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
          ],
          additional_kwargs: {},
        },
      },
    };

    await prepare?.(sessionA1, contextA1);

    let prepareResolved = false;
    const pendingPrepare = prepare?.(sessionA2, contextA2).then((result) => {
      prepareResolved = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(450);
    await flushMicrotasks();
    expect(prepareResolved).toBe(true);

    await pendingPrepare;
    expect(contextA2.options.inputMessage.content).toEqual([
      { type: 'text', text: '先看一下\n这张图里是什么？' },
      { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
    ]);
  });

  it('transcribes first incoming audio and merges it into session content', async () => {
    const { inbound, bot } = createHarness();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://example.com/input.amr') {
        return new Response(Uint8Array.from([1, 2, 3]), { status: 200 });
      }
      if (url === 'http://127.0.0.1:8081/transcribe' && init?.method === 'POST') {
        return Response.json({ text: '转写内容', language: 'zh', durationMs: 1_500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = createSession(bot, {
      content: '<audio src="https://example.com/input.amr"/>补充说明',
      strippedContent: '补充说明',
    });

    const result = await inbound(session, async () => session.content);
    expect(result).toBe('补充说明\n转写内容');
    expect(session.content).toBe('补充说明\n转写内容');
    expect(session.state.qqVoice).toEqual({
      transcript: '转写内容',
      durationMs: 1_500,
      source: 'src',
    });
  });

  it('registers policy, prompt compiler, and executor middlewares on ready', async () => {
    const { ready, getPolicy, getPromptCompiler, getExecutor } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    expect(getPolicy()).toBeTypeOf('function');
    expect(getPromptCompiler()).toBeTypeOf('function');
    expect(getExecutor()).toBeTypeOf('function');
  });

  it('injects recent tool memory as assistant_state before reply planning', async () => {
    const { ready, getToolMemoryState, bot } = createHarness({
      databaseGetImpl: async (table: string, query: Record<string, unknown>) => {
        if (table === 'chathub_conversation') {
          return [{
            id: query.id ?? 'conv-memory',
            additional_kwargs: JSON.stringify({
              __chatluna_internal_tool_memory_v1: JSON.stringify([
                {
                  turnId: 'turn-1',
                  createdAt: '2026-03-23T06:00:00.000Z',
                  toolName: 'web_search',
                  inputDigest: '{"query":"液态玻璃"}',
                  snippetFormat: 'text',
                  snippet: '搜索结果 A',
                  freshnessHint: '2026-03-23T06:00:00.000Z',
                },
              ]),
            }),
          }];
        }
        if (table === 'chathub_message') {
          return createStoredResearchCompatibilityTail(String(query.conversation ?? 'conv-memory'));
        }
        return [];
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const middleware = getToolMemoryState();
    const session = createSession(bot, {
      content: '继续说',
      strippedContent: '继续说',
    });
    const context = {
      options: {
        room: { conversationId: 'conv-memory' },
        inputMessage: {
          content: '继续说',
          additional_kwargs: {},
        },
      },
    };

    await middleware?.(session, context);

    expect(promptAssemblyMocks.registerPromptFragment).toHaveBeenCalledWith(
      'conv-memory',
      expect.objectContaining({
        source: 'qqbot_reply_tool_memory',
        authority: 'assistant_state',
        payload: expect.objectContaining({
          kind: 'text',
          value: expect.stringContaining('搜索结果 A'),
        }),
      }),
    );
  });

  it('compiles QQ reply turns into explicit agent prompt envelopes and requests structured output', async () => {
    const { ready, getPrepare, getPolicy, getPromptCompiler, bot, inject } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') {
          throw new Error('connect timeout');
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const policy = getPolicy();
    const promptCompiler = getPromptCompiler();
    const session = createSession(bot, {
      content: '请发一条语音给我听',
      strippedContent: '请发一条语音给我听',
    });
    const context = {
      options: {
        room: createPluginRoom('conv-1'),
        inputMessage: {
          content: '请发一条语音给我听',
          additional_kwargs: {},
        },
      },
    };

    await prepare?.(session, context);
    await policy?.(session, context);
    await promptCompiler?.(session, context);
    expect((context.options.room as any).chatMode).toBe('plugin');
    expect(promptAssemblyMocks.registerPromptFragment).not.toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ source: 'qqbot_reply_transport_capability' }),
    );
    expect(promptAssemblyMocks.registerPromptFragment).not.toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ source: 'qqbot_reply_transport_execution_rules' }),
    );
    expect(promptAssemblyMocks.clearPromptAssemblyTurn).toHaveBeenCalledWith('conv-1');
    expect(inject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'qqbot_reply_prompt_envelope',
        conversationId: 'conv-1',
        stage: 'after_scratchpad',
        value: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('qqbot_agent_reply_contract'),
          }),
        ]),
      }),
    );
    expect(context.options.inputMessage.additional_kwargs).toEqual(
      expect.objectContaining({
        qqbot_reply_mode: 'agent',
        qqbot_final_response_schema: expect.objectContaining({
          title: 'StructuredReplyV1',
          properties: expect.objectContaining({
            decision: expect.objectContaining({
              description: expect.any(String),
            }),
          }),
        }),
      }),
    );
    expect(context.options.inputMessage.additional_kwargs).not.toHaveProperty('qqbot_final_response_instruction');
  });

  it('injects explicit group speaker identity rules and current speaker identity into the reply prompt envelope', async () => {
    const { ready, getPrepare, getPolicy, getPromptCompiler, bot, inject } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const policy = getPolicy();
    const promptCompiler = getPromptCompiler();
    const session = createSession(bot, {
      content: '交个朋友怎么样？',
      strippedContent: '交个朋友怎么样？',
      userId: 'u2',
      author: {
        nick: '小祥',
        name: '小祥QQ昵称',
      },
    });
    const context = {
      options: {
        room: createPluginRoom('conv-group'),
        inputMessage: {
          content: '交个朋友怎么样？',
          additional_kwargs: {},
        },
      },
    };

    await prepare?.(session, context);
    await policy?.(session, context);
    await promptCompiler?.(session, context);

    const injectedEnvelope = inject.mock.calls.find((call) => {
      const payload = call[0] as Record<string, any> | undefined;
      return payload?.name === 'qqbot_reply_prompt_envelope';
    })?.[0];
    expect(injectedEnvelope).toBeDefined();

    const envelopeText = (injectedEnvelope?.value ?? []).map((message: { content?: unknown }) => String(message?.content ?? '')).join('\n');
    expect(envelopeText).toContain('[] 内是发言者身份标记');
    expect(envelopeText).toContain('不同标记的消息当成同一个人');
    expect(envelopeText).toContain('当前主输入对应的发言者才是本轮直接回应对象');
    expect(envelopeText).toContain('"displayName": "小祥"');
    expect(envelopeText).toContain('"userId": "u2"');
  });

  it('rejects non-plugin rooms during prepare before the model runs', async () => {
    const { ready, getPrepare, getPolicy, getPromptCompiler, bot, inject } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') {
          throw new Error('connect timeout');
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const policy = getPolicy();
    const promptCompiler = getPromptCompiler();
    const session = createSession(bot, {
      content: '查一下苹果说的液态玻璃是什么',
      strippedContent: '查一下苹果说的液态玻璃是什么',
    });
    const context = {
      options: {
        room: {
          conversationId: 'conv-chat',
          roomId: 8,
          model: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
          preset: 'sakiko',
          chatMode: 'chat',
        },
        inputMessage: {
          content: '查一下苹果说的液态玻璃是什么',
          additional_kwargs: {},
        },
      },
    };

    await expect(prepare?.(session, context)).rejects.toThrow('room.chatMode=plugin');
    expect(policy).toBeDefined();
    expect(promptCompiler).toBeDefined();
    expect(inject).not.toHaveBeenCalled();
  });

  it('stops the prepare stage early when the turn input is empty', async () => {
    const { ready, getPrepare, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const session = createSession(bot, {
      content: '   ',
      strippedContent: '   ',
    });
    const result = await prepare?.(session, {
      options: {
        room: createPluginRoom('conv-empty'),
      },
    });

    expect(result).toBe(1);
  });

  it('amortizes tts probing across turns and refreshes again on the 12th turn', async () => {
    const { ready, capabilityMiddleware, bot } = createHarness();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8082/healthz') {
        return new Response('ok', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await ready();
    await flushMicrotasks();

    const session = createSession(bot, {
      content: '普通聊天',
      strippedContent: '普通聊天',
    });

    for (let index = 0; index < 11; index += 1) {
      await capabilityMiddleware?.(session, async () => undefined);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await capabilityMiddleware?.(session, async () => undefined);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('executes a text structured reply through the executor and normalizes the tail to visible text', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '普通聊聊',
      strippedContent: '普通聊聊',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        room: createPluginRoom('conv-text'),
        responseMessage: createReplyV2Response('今晚先这样吧'),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['今晚先这样吧']);
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-text' }),
      '今晚先这样吧',
    );
  });

  it('quotes only the first dispatched text segment when the runtime exposes a first-reply quote target', async () => {
    const { ready, getPrepare, getExecutor, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const quoteSpy = vi.spyOn(ReplyRuntime.prototype, 'consumeFirstReplyQuote');
    quoteSpy.mockImplementationOnce(() => 'msg-b').mockImplementationOnce(() => null);

    try {
      const session = createSession(bot, {
        userId: 'u2',
        content: 'B1',
        strippedContent: 'B1',
        messageId: 'msg-b',
      });
      const context = {
        options: {
          room: createPluginRoom('conv-quote-text'),
          responseMessage: createReplyV2Response('第一句\n第二句'),
        },
      };

      await executor?.(session, context);

      const calls = bot.sendMessage.mock.calls as any[][];
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[1]).toEqual([
        expect.objectContaining({ type: 'quote', attrs: expect.objectContaining({ id: 'msg-b' }) }),
        expect.objectContaining({ type: 'text', attrs: expect.objectContaining({ content: '第一句' }) }),
      ]);
      expect(calls[1]?.[1]).toBe('第二句');
    } finally {
      quoteSpy.mockRestore();
    }
  });

  it('executes a voice structured reply through the executor', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') {
          return new Response('ok', { status: 200 });
        }
        if (url === 'http://127.0.0.1:8082/synthesize') {
          return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '请只发一句语音',
      strippedContent: '请只发一句语音',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: true,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        room: createPluginRoom('conv-voice'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          messages: [{ modality: 'voice', content: '收到。' }],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    const voiceCalls = bot.sendMessage.mock.calls as any[][];
    expect(String(voiceCalls[0]?.[1] ?? '')).toContain('<audio src="data:audio/wav;base64,');
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-voice' }),
      '（发送语音：收到。）',
    );
  });

  it('does not backfill quote after a first voice segment even when the runtime exposes a quote target', async () => {
    const { ready, getPrepare, getExecutor, bot } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') {
          return new Response('ok', { status: 200 });
        }
        if (url === 'http://127.0.0.1:8082/synthesize') {
          return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
        }
        return new Response('ok', { status: 200 });
      }),
    );

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const quoteSpy = vi.spyOn(ReplyRuntime.prototype, 'consumeFirstReplyQuote');
    quoteSpy.mockImplementationOnce(() => 'msg-b').mockImplementationOnce(() => null);

    try {
      const session = createSession(bot, {
        userId: 'u2',
        content: 'B1',
        strippedContent: 'B1',
        messageId: 'msg-b',
        state: {
          qqReplyTransport: {
            capabilitySnapshot: {
              canMultiline: true,
              canVoice: true,
              source: 'cached',
              refreshedAt: Date.now(),
            },
          },
        },
      });
      const context = {
        options: {
          room: createPluginRoom('conv-quote-voice'),
          responseMessage: createReplyV2Response({
            decision: 'reply',
            messages: [
              { modality: 'voice', content: '收到。' },
              { modality: 'text', content: '第二句' },
            ],
          }),
        },
      };

      await executor?.(session, context);

      const calls = bot.sendMessage.mock.calls as any[][];
      expect(calls).toHaveLength(2);
      expect(Array.isArray(calls[0]?.[1])).toBe(false);
      expect(String(calls[0]?.[1] ?? '')).toContain('audio');
      expect(calls[1]?.[1]).toBe('第二句');
    } finally {
      quoteSpy.mockRestore();
    }
  });

  it('rejects voice structured replies when voice capability is unavailable', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '请只发一句语音',
      strippedContent: '请只发一句语音',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        room: createPluginRoom('conv-voice-fallback'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          messages: [{ modality: 'voice', content: '收到。' }],
        }),
      },
    };

    await expect(executor?.(session, context)).rejects.toThrow('voice capability is unavailable');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(chatluna.normalizeResearchReplyHistory).not.toHaveBeenCalled();
  });

  it('executes sticker actions and preserves sticker history text', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '配一个表情包',
      strippedContent: '配一个表情包',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
        qqSticker: createStickerState(),
      },
    });
    const context = {
      options: {
        room: createPluginRoom('conv-sticker'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          messages: [
            { modality: 'text', content: '……随你' },
            { modality: 'meme', content: '无语地看对方一眼' },
          ],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage).toHaveBeenCalledTimes(2);
    const stickerCalls = bot.sendMessage.mock.calls as any[][];
    expect(stickerCalls[0]?.[1]).toBe('……随你');
    expect(String(stickerCalls[1]?.[1] ?? '')).toContain('<img src="data:image/png;base64,');
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-sticker' }),
      '……随你\n（发送表情包：无语少女）',
    );
  });

  it('quotes the first sticker segment when the runtime exposes a first-reply quote target', async () => {
    const { ready, getPrepare, getExecutor, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const quoteSpy = vi.spyOn(ReplyRuntime.prototype, 'consumeFirstReplyQuote').mockReturnValueOnce('msg-b');

    try {
      const session = createSession(bot, {
        userId: 'u2',
        content: 'B1',
        strippedContent: 'B1',
        messageId: 'msg-b',
        state: {
          qqReplyTransport: {
            capabilitySnapshot: {
              canMultiline: true,
              canVoice: false,
              source: 'cached',
              refreshedAt: Date.now(),
            },
          },
          qqSticker: createStickerState(),
        },
      });
      const context = {
        options: {
          room: createPluginRoom('conv-quote-sticker'),
          responseMessage: createReplyV2Response({
            decision: 'reply',
            messages: [{ modality: 'meme', content: '无语地看对方一眼' }],
          }),
        },
      };

      await executor?.(session, context);

      const calls = bot.sendMessage.mock.calls as any[][];
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toEqual([
        expect.objectContaining({ type: 'quote', attrs: expect.objectContaining({ id: 'msg-b' }) }),
        expect.objectContaining({ type: 'img' }),
      ]);
    } finally {
      quoteSpy.mockRestore();
    }
  });

  it('rejects meme structured replies when sticker capability is unavailable', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '配一个表情包',
      strippedContent: '配一个表情包',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        room: createPluginRoom('conv-sticker-drop'),
        responseMessage: createReplyV2Response({
          decision: 'reply',
          messages: [
            { modality: 'text', content: '还是先说正事。' },
            { modality: 'meme', content: '无语地看对方一眼' },
          ],
        }),
      },
    };

    await expect(executor?.(session, context)).rejects.toThrow('meme output but sticker capability is unavailable');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(chatluna.normalizeResearchReplyHistory).not.toHaveBeenCalled();
  });

  it('splits multiline text actions through the executor and suppresses the raw JSON response', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '给我两行命令',
      strippedContent: '给我两行命令',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        room: createPluginRoom('conv-1'),
        responseMessage: createReplyV2Response('echo hi\npwd'),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['echo hi', 'pwd']);
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeResearchReplyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
      'echo hi\npwd',
    );
  });

  it('logs history normalization failures after send instead of surfacing a second user-visible error', async () => {
    const { ready, getExecutor, bot } = createHarness({
      normalizeResearchReplyHistoryImpl: async () => {
        throw new Error('research reply history normalization failed: latest message missing (conv-broken)');
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '普通聊聊',
      strippedContent: '普通聊聊',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        room: createPluginRoom('conv-broken'),
        responseMessage: createReplyV2Response('收到'),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['收到']);
    expect(context.options.responseMessage).toBeNull();
    expect(
      loggerMocks.warn.mock.calls.some(
        ([message, detail]) =>
          String(message).includes('research reply history normalization failed') &&
          String(detail).includes('latest message missing'),
      ),
    ).toBe(true);
  });

  it('rejects plugin rooms whose model does not support structured json schema', async () => {
    const { ready, getPrepare, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const prepare = getPrepare();
    const session = createSession(bot, {
      content: '查一下液态玻璃是什么',
      strippedContent: '查一下液态玻璃是什么',
    });
    const context = {
      options: {
        room: createPluginRoom('conv-research', {
          model: 'deepseek/deepseek-chat',
        }),
        inputMessage: {
          content: '查一下液态玻璃是什么',
          additional_kwargs: {},
        },
      },
    };

    await expect(prepare?.(session, context)).rejects.toThrow('requires SiliconFlow Kimi-K2.5');
    expect(chatluna.createChatModel).not.toHaveBeenCalled();
  });

  it('rejects plain-text outputs unless the raw model output itself is JSON', async () => {
    const { ready, getExecutor, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '发个表情包',
      strippedContent: '发个表情包',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        room: createPluginRoom('conv-rerun'),
        responseMessage: createRawReplyResponse('模型直接说了一句普通文本'),
      },
    };

    await expect(executor?.(session, context)).rejects.toThrow('structured reply compiler expected JSON');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(loggerMocks.warn.mock.calls.some(([message]) => String(message).includes('reply-plan-debug'))).toBe(false);
  });

  it('rejects fenced json outputs instead of trying to recover them', async () => {
    const { ready, getExecutor, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '发个表情包',
      strippedContent: '发个表情包',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
      },
    });
    const context = {
      options: {
        room: createPluginRoom('conv-fenced-json'),
        responseMessage: createRawReplyResponse(
          ['```json', '{"decision":"reply","messages":[{"modality":"text","content":"收到"}]}', '```'].join('\n'),
        ),
      },
    };

    await expect(executor?.(session, context)).rejects.toThrow('structured reply compiler expected JSON');
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });
});
