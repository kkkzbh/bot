import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi-plugin-chatluna/chains', () => ({
  ChainMiddlewareRunStatus: { STOP: 1, CONTINUE: 0 },
}));

const promptAssemblyMocks = vi.hoisted(() => ({
  registerPromptFragment: vi.fn(),
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
    h: {
      parse,
      audio: (src: string) => ({
        toString: () => `<audio src="${src}"/>`,
      }),
      image: (source: string | Buffer, mime?: string) => ({
        toString: () =>
          typeof source === 'string'
            ? `<img src="${source}" />`
            : `<img src="data:${mime};base64,${source.toString('base64')}" />`,
      }),
    },
  };
});

vi.mock('../src/plugins/shared/prompt-context/index.js', () => ({
  registerPromptFragment: promptAssemblyMocks.registerPromptFragment,
}));

import { apply, inject } from '../src/plugins/reply/index.js';

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

function createStoredReplyAgentTail(conversationId: string) {
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
  databaseGetImpl?: (table: string, query: Record<string, unknown>) => Promise<any[]>;
  databaseUpsertImpl?: (table: string, rows: Record<string, unknown>[]) => Promise<unknown>;
  databaseRemoveImpl?: (table: string, query: Record<string, unknown>) => Promise<unknown>;
  normalizeReplyAgentHistoryImpl?: (room: Record<string, unknown>, finalVisibleText: string) => Promise<unknown>;
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
        return createStoredReplyAgentTail(String(query.conversation ?? 'conv-1'));
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
    normalizeReplyAgentHistory: vi.fn(async (room: Record<string, unknown>, finalVisibleText: string) => {
      if (overrides.normalizeReplyAgentHistoryImpl) {
        return overrides.normalizeReplyAgentHistoryImpl(room, finalVisibleText);
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
    getPolicy: () => chainMiddlewares.get('qqbot_reply_transport_policy'),
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createReplyAgentResponse(input: Record<string, unknown>) {
  return {
    content: '',
    additional_kwargs: {
      chatluna_agent_terminal_tool: {
        name: 'submit_reply_plan',
        input,
      },
    },
  };
}

describe('qq voice plugin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    promptAssemblyMocks.registerPromptFragment.mockReset();
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
    const prepareContext1 = { options: { room: { conversationId: 'conv-serial' } } };
    const prepareContext2 = { options: { room: { conversationId: 'conv-serial' } } };

    await prepare?.(session1, prepareContext1);

    let secondPrepared = false;
    const prepareSecondPromise = prepare?.(session2, prepareContext2).then(() => {
      secondPrepared = true;
    });

    await flushMicrotasks();
    expect(secondPrepared).toBe(false);

    await executor?.(session1, {
      options: {
        room: { conversationId: 'conv-serial' },
        responseMessage: createReplyAgentResponse({
          segments: [{ kind: 'text', content: '第一条回复' }],
        }),
      },
    });

    await prepareSecondPromise;
    expect(secondPrepared).toBe(true);
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['第一条回复']);
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

  it('registers policy and executor middlewares on ready', async () => {
    const { ready, getPolicy, getExecutor } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    expect(getPolicy()).toBeTypeOf('function');
    expect(getExecutor()).toBeTypeOf('function');
  });

  it('switches QQ reply turns to reply-agent and only injects voice execution rules when voice is unavailable', async () => {
    const { ready, getPolicy, bot } = createHarness();
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

    const policy = getPolicy();
    const session = createSession(bot, {
      content: '请发一条语音给我听',
      strippedContent: '请发一条语音给我听',
    });
    const context = {
      options: {
        room: { conversationId: 'conv-1' },
        inputMessage: {
          content: '请发一条语音给我听',
          additional_kwargs: {},
        },
      },
    };

    await policy?.(session, context);
    expect((context.options.room as any).chatMode).toBe('reply-agent');
    expect(promptAssemblyMocks.registerPromptFragment).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        source: 'qqbot_reply_transport_capability',
        payload: {
          kind: 'json',
          value: expect.objectContaining({
            reply_plan: expect.objectContaining({
              enabled: true,
              multiline_available: true,
              terminal_tool: 'submit_reply_plan',
            }),
            voice: expect.objectContaining({
              enabled: false,
              max_words: 80,
              max_seconds: 45,
            }),
          }),
        },
      }),
    );
    expect(
      promptAssemblyMocks.registerPromptFragment.mock.calls.some(
        ([conversationId, fragment]) =>
          conversationId === 'conv-1' && fragment?.source === 'qqbot_reply_transport_execution_rules',
      ),
    ).toBe(true);
    expect(
      promptAssemblyMocks.registerPromptFragment.mock.calls.some(
        ([conversationId, fragment]) =>
        conversationId === 'conv-1' && fragment?.source === 'qqbot_reply_transport_route',
      ),
    ).toBe(false);
    expect(context.options.inputMessage.additional_kwargs).toEqual({});
  });

  it('injects compact voice execution rules with multi-segment examples when TTS is healthy', async () => {
    const { ready, getPolicy, bot } = createHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'http://127.0.0.1:8082/healthz') {
          return new Response('ok', { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await ready();
    await flushMicrotasks();

    const policy = getPolicy();
    const session = createSession(bot, {
      content: '普通闲聊一下',
      strippedContent: '普通闲聊一下',
    });
    const context = {
      options: {
        room: { conversationId: 'conv-voice' },
        inputMessage: {
          content: '普通闲聊一下',
          additional_kwargs: {},
        },
      },
    };

    await policy?.(session, context);
    const executionRuleCall = promptAssemblyMocks.registerPromptFragment.mock.calls.find(
      ([conversationId, fragment]) =>
        conversationId === 'conv-voice' && fragment?.source === 'qqbot_reply_transport_execution_rules',
    );
    const executionRules = String(executionRuleCall?.[1]?.payload?.value ?? '');
    expect(executionRules).toContain('最终只能调用 submit_reply_plan');
    expect(executionRules).toContain('如果要发语音，就提交 voice 段');
    expect(executionRules).toContain(
      '文本 + voice 混排示例：submit_reply_plan({"segments":[{"kind":"text","content":"先说一句"},{"kind":"voice","content":"接着用语音继续"},{"kind":"text","content":"最后补一句"}]})',
    );
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

  it('executes a text ReplyPlan through the executor and normalizes the tail to visible text', async () => {
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
        room: { conversationId: 'conv-text' },
        responseMessage: createReplyAgentResponse({
          segments: [{ kind: 'text', content: '今晚先这样吧' }],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['今晚先这样吧']);
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeReplyAgentHistory).toHaveBeenCalledWith(
      { conversationId: 'conv-text' },
      '今晚先这样吧',
    );
  });

  it('executes a multiline ReplyPlan and suppresses the raw JSON response', async () => {
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
        room: { conversationId: 'conv-1' },
        responseMessage: createReplyAgentResponse({
          segments: [{ kind: 'multiline', content: 'echo hi\npwd' }],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['echo hi\npwd']);
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeReplyAgentHistory).toHaveBeenCalledWith(
      { conversationId: 'conv-1' },
      'echo hi\npwd',
    );
  });

  it('executes an image ReplyPlan and stores the existing image history text form', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '发张图',
      strippedContent: '发张图',
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
        room: { conversationId: 'conv-image' },
        responseMessage: createReplyAgentResponse({
          segments: [{ kind: 'image', asset_ref: 'https://example.com/image.png', alt: '测试图片' }],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls.map((call: any[]) => String(call[1]))).toEqual(['<img src="https://example.com/image.png" />']);
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeReplyAgentHistory).toHaveBeenCalledWith(
      { conversationId: 'conv-image' },
      '（发送图片：测试图片）',
    );
  });

  it('logs history normalization failures after send instead of surfacing a second user-visible error', async () => {
    const { ready, getExecutor, bot } = createHarness({
      normalizeReplyAgentHistoryImpl: async () => {
        throw new Error('reply-agent history normalization failed: latest message missing (conv-broken)');
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
        room: { conversationId: 'conv-broken' },
        responseMessage: createReplyAgentResponse({
          segments: [{ kind: 'text', content: '收到' }],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['收到']);
    expect(context.options.responseMessage).toBeNull();
    expect(
      loggerMocks.warn.mock.calls.some(
        ([message, detail]) =>
          String(message).includes('reply-agent history normalization failed') &&
          String(detail).includes('latest message missing'),
      ),
    ).toBe(true);
  });

  it('throws when reply-agent ends without submit_reply_plan and logs protocol failure details', async () => {
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
        room: { conversationId: 'conv-rerun', roomId: 7, model: 'deepseek/deepseek-chat', preset: 'sakiko' },
        responseMessage: {
          content: '模型直接说了一句普通文本',
          additional_kwargs: {},
        },
      },
    };

    await expect(executor?.(session, context)).rejects.toThrow('reply-agent 未提交 submit_reply_plan 终态工具。');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    const debugCalls = loggerMocks.warn.mock.calls.filter(([message]) => String(message).includes('reply-plan-debug'));
    expect(debugCalls).toHaveLength(1);
    expect(JSON.parse(String(debugCalls[0][1]))).toEqual({
      stage: 'terminal_tool_missing_or_invalid',
      conversationId: 'conv-rerun',
      roomId: 7,
      roomModel: 'deepseek/deepseek-chat',
      preset: 'sakiko',
      parseError: 'reply-agent 未提交 submit_reply_plan 终态工具。',
      rawOutputText: '模型直接说了一句普通文本',
      terminalToolName: null,
      terminalToolPayload: null,
    });
  });

  it('executes a sticker ReplyPlan and sends one image payload', async () => {
    const { ready, getExecutor, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const stickerEntry = {
      id: 'bored',
      file: 'images/personas/sakiko/bored.png',
      hash: 'hash-1',
      mime: 'image/png',
      scopes: ['persona:sakiko'],
      caption: '无语少女',
      keywords: ['无语', '沉默'],
      moods: ['无语'],
      scenes: ['日常吐槽'],
      historyLabel: '无语少女',
      confidence: 0.95,
      buffer: Buffer.from('fake-png'),
    };
    const session = createSession(bot, {
      content: '来个表情包',
      strippedContent: '来个表情包',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
        qqSticker: {
          catalog: {
            version: 1,
            generatedAt: '2026-03-16T00:00:00.000Z',
            model: 'doubao-seed-2-0-mini-260215',
            entries: [stickerEntry],
            byId: new Map([['bored', stickerEntry]]),
          },
          preset: 'sakiko',
          availableCount: 1,
        },
      },
    });
    const context = {
      options: {
        room: { conversationId: 'conv-sticker', preset: 'sakiko' },
        responseMessage: createReplyAgentResponse({
          segments: [{ kind: 'sticker', content: '无语地看对方一眼' }],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls).toHaveLength(1);
    expect(String((bot.sendMessage.mock.calls as Array<any[]>)[0]?.[1] ?? '')).toContain(
      '<img src="data:image/png;base64,',
    );
    expect(context.options.responseMessage).toBeNull();
  });

  it('preserves text and sticker order in a mixed ReplyPlan and stores sticker history lines', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const stickerEntry = {
      id: 'cold',
      file: 'images/personas/sakiko/cold.png',
      hash: 'hash-2',
      mime: 'image/png',
      scopes: ['persona:sakiko'],
      caption: '冷淡举手',
      keywords: ['冷淡', '拒绝'],
      moods: ['冷淡'],
      scenes: ['追问私事'],
      historyLabel: '冷淡举手',
      confidence: 0.95,
      buffer: Buffer.from('fake-cold'),
    };
    const session = createSession(bot, {
      content: '混排一下',
      strippedContent: '混排一下',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: false,
            source: 'cached',
            refreshedAt: Date.now(),
          },
        },
        qqSticker: {
          catalog: {
            version: 1,
            generatedAt: '2026-03-16T00:00:00.000Z',
            model: 'doubao-seed-2-0-mini-260215',
            entries: [stickerEntry],
            byId: new Map([['cold', stickerEntry]]),
          },
          preset: 'sakiko',
          availableCount: 1,
        },
      },
    });
    const context = {
      options: {
        room: { conversationId: 'conv-sticker-mix', preset: 'sakiko' },
        responseMessage: createReplyAgentResponse({
          segments: [
            { kind: 'text', content: '前一句' },
            { kind: 'sticker', content: '冷淡拒绝，被追问私事' },
            { kind: 'text', content: '后一句' },
          ],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls.map((call: any[]) => String(call[1]))).toEqual([
      '前一句',
      expect.stringContaining('<img src="data:image/png;base64,'),
      '后一句',
    ]);
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeReplyAgentHistory).toHaveBeenCalledWith(
      { conversationId: 'conv-sticker-mix', preset: 'sakiko' },
      '前一句\n（发送表情包：冷淡举手）\n后一句',
    );
  });

  it('executes a voice ReplyPlan, sends one audio payload, and stores the voice history text form', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8082/healthz') {
        return new Response('ok', { status: 200 });
      }
      if (url === 'http://127.0.0.1:8082/synthesize' && init?.method === 'POST') {
        return new Response(Uint8Array.from([82, 73, 70, 70]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '请用语音回我一句晚安',
      strippedContent: '请用语音回我一句晚安',
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
        room: { conversationId: 'conv-voice' },
        responseMessage: createReplyAgentResponse({
          segments: [{ kind: 'voice', content: '晚安' }],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls).toHaveLength(1);
    const audioCall = (bot.sendMessage.mock.calls as Array<any[]>)[0];
    expect(String(audioCall?.[1] ?? '')).toContain('<audio src="data:audio/wav;base64,');
    expect(context.options.responseMessage).toBeNull();
    expect(chatluna.normalizeReplyAgentHistory).toHaveBeenCalledWith(
      { conversationId: 'conv-voice' },
      '（发送语音：晚安）',
    );
  });

  it('downgrades a voice ReplyPlan to plain text when synthesis fails before send', async () => {
    const { ready, getExecutor, bot } = createHarness();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8082/healthz') {
        return new Response('ok', { status: 200 });
      }
      if (url === 'http://127.0.0.1:8082/synthesize' && init?.method === 'POST') {
        throw new Error('tts broken');
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await ready();
    await flushMicrotasks();

    const executor = getExecutor();
    const session = createSession(bot, {
      content: '请用语音回我一句晚安',
      strippedContent: '请用语音回我一句晚安',
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
        room: { conversationId: 'conv-voice' },
        responseMessage: createReplyAgentResponse({
          segments: [{ kind: 'voice', content: '晚安' }],
        }),
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['晚安']);
    expect(context.options.responseMessage).toBeNull();
  });
});
