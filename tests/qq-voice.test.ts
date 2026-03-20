import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi-plugin-chatluna/chains', () => ({
  ChainMiddlewareRunStatus: { STOP: 1, CONTINUE: 0 },
}));

const promptAssemblyMocks = vi.hoisted(() => ({
  registerPromptFragment: vi.fn(),
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
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
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
      image: (buffer: Buffer, mime: string) => ({
        toString: () => `<img src="data:${mime};base64,${buffer.toString('base64')}" />`,
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

function createHarness(overrides: {
  canSendRecord?: boolean;
  canSendRecordImpl?: () => Promise<boolean>;
  includeInternalRequest?: boolean;
  pluginConfig?: Record<string, unknown>;
} = {}) {
  const middlewares: Middleware[] = [];
  const events = new Map<string, EventHandler[]>();
  const chainMiddlewares = new Map<string, ChainMiddleware>();
  const inject = vi.fn();

  const database = {
    get: vi.fn(async (table: string, query: Record<string, unknown>) => {
      if (table === 'chathub_conversation') {
        return [{ id: query.id ?? 'conv-1', latestId: 'msg-ai-1' }];
      }
      if (table === 'chathub_message') {
        return [
          {
            id: query.id ?? 'msg-ai-1',
            role: 'ai',
            content: null,
            parent: 'msg-human-1',
            name: null,
            tool_calls: null,
            tool_call_id: null,
            additional_kwargs_binary: null,
            rawId: null,
            conversation: 'conv-1',
          },
        ];
      }
      return [];
    }),
    upsert: vi.fn(async () => undefined),
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
  };

  const ctx = {
    bots: [bot],
    chatluna,
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

describe('qq voice plugin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    promptAssemblyMocks.registerPromptFragment.mockReset();
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

  it('injects a text fallback persona line when TTS is down', async () => {
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
    expect(promptAssemblyMocks.registerPromptFragment).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        source: 'qqbot_reply_transport_capability',
        payload: {
          kind: 'json',
          value: expect.objectContaining({
            reply_plan: expect.objectContaining({
              plain_path_available: true,
              structured_path_available: true,
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
    expect(promptAssemblyMocks.registerPromptFragment).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        source: 'qqbot_reply_transport_execution_rules',
        payload: {
          kind: 'text',
          value: expect.stringContaining('本轮不使用语音回复'),
        },
      }),
    );
    expect(context.options.inputMessage.additional_kwargs).toEqual({
      qqbot_override_request_params: {
        response_format: {
          type: 'json_object',
        },
      },
    });
  });

  it('injects the same voice capability policy whenever TTS is healthy', async () => {
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
    expect(promptAssemblyMocks.registerPromptFragment).toHaveBeenCalledWith(
      'conv-voice',
      expect.objectContaining({
        source: 'qqbot_reply_transport_capability',
        payload: {
          kind: 'json',
          value: expect.objectContaining({
            reply_plan: expect.objectContaining({
              multiline_available: true,
              schema: {
                segments: [{ kind: 'text|multiline|voice|sticker', content: 'string' }],
              },
            }),
            voice: expect.objectContaining({
              enabled: true,
              source: 'cached',
              max_words: 80,
              max_seconds: 45,
              sequence_mode: 'ordered_segments',
            }),
          }),
        },
      }),
    );
    expect(promptAssemblyMocks.registerPromptFragment).toHaveBeenCalledWith(
      'conv-voice',
      expect.objectContaining({
        source: 'qqbot_reply_transport_execution_rules',
        payload: {
          kind: 'text',
          value: expect.stringContaining('本轮语音回复可用'),
        },
      }),
    );
    expect(context.options.inputMessage.additional_kwargs).toEqual({
      qqbot_override_request_params: {
        response_format: {
          type: 'json_object',
        },
      },
    });
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

  it('executes a multiline ReplyPlan and suppresses the raw JSON response', async () => {
    const { ready, getExecutor, bot, database } = createHarness();
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
          routeDecision: {
            route: 'structured',
            reason: 'structured_multiline_task',
          },
        },
      },
    });
    const context = {
      options: {
        room: { conversationId: 'conv-1' },
        responseMessage: {
          content: '{"segments":[{"kind":"multiline","content":"echo hi\\npwd"}]}',
        },
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['echo hi\npwd']);
    expect(context.options.responseMessage).toBeNull();
    expect(database.upsert).toHaveBeenCalled();
  });

  it('wraps plain text output into a text ReplyPlan and still executes through the executor', async () => {
    const { ready, getExecutor, bot } = createHarness();
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
          routeDecision: {
            route: 'plain',
            reason: 'plain_text_task',
          },
        },
      },
    });
    const context = {
      options: {
        room: { conversationId: 'conv-plain' },
        responseMessage: {
          content: '今晚先这样吧',
        },
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['今晚先这样吧']);
    expect(context.options.responseMessage).toBeNull();
  });

  it('retries structured once and then reruns through plain route when structured output stays invalid', async () => {
    const { ready, getExecutor, bot, chatluna } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    const phases: string[] = [];
    (chatluna.chatChain.receiveMessage as any).mockImplementation(async (retrySession: Record<string, any>) => {
      const capture = retrySession.state?.qqReplyTransport?.generationCapture;
      if (!capture) return false;
      phases.push(capture.phase);
      retrySession.state.qqReplyTransport.generationCapture = {
        ...capture,
        result:
          capture.phase === 'structured_retry'
            ? {
                plan: null,
                error: 'structured 输出不是合法 JSON 对象。',
              }
            : {
                plan: {
                  segments: [{ kind: 'text', content: '这次只用文字回复' }],
                },
                error: null,
              },
      };
      return false;
    });

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
          routeDecision: {
            route: 'structured',
            reason: 'explicit_rich_request',
          },
        },
      },
    });
    const context = {
      options: {
        room: { conversationId: 'conv-rerun' },
        responseMessage: {
          content: '不是合法 JSON',
        },
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(chatluna.chatChain.receiveMessage).toHaveBeenCalledTimes(2);
    expect(phases).toEqual(['structured_retry', 'plain_retry']);
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['这次只用文字回复']);
    expect(context.options.responseMessage).toBeNull();
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
          routeDecision: {
            route: 'structured',
            reason: 'explicit_rich_request',
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
        responseMessage: {
          content: '{"segments":[{"kind":"sticker","content":"无语地看对方一眼"}]}',
        },
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

  it('preserves text and sticker order in a mixed ReplyPlan', async () => {
    const { ready, getExecutor, bot } = createHarness();
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
          routeDecision: {
            route: 'structured',
            reason: 'daily_chat_with_sticker',
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
        responseMessage: {
          content:
            '{"segments":[{"kind":"text","content":"前一句"},{"kind":"sticker","content":"冷淡拒绝，被追问私事"},{"kind":"text","content":"后一句"}]}',
        },
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
  });

  it('executes a voice ReplyPlan and sends one audio payload', async () => {
    const { ready, getExecutor, bot } = createHarness();
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
          routeDecision: {
            route: 'structured',
            reason: 'explicit_rich_request',
          },
        },
      },
    });
    const context = {
      options: {
        room: { conversationId: 'conv-voice' },
        responseMessage: {
          content: '{"segments":[{"kind":"voice","content":"晚安"}]}',
        },
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls).toHaveLength(1);
    const audioCall = (bot.sendMessage.mock.calls as Array<any[]>)[0];
    expect(String(audioCall?.[1] ?? '')).toContain('<audio src="data:audio/wav;base64,');
    expect(context.options.responseMessage).toBeNull();
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
          routeDecision: {
            route: 'structured',
            reason: 'explicit_rich_request',
          },
        },
      },
    });
    const context = {
      options: {
        room: { conversationId: 'conv-voice' },
        responseMessage: {
          content: '{"segments":[{"kind":"voice","content":"晚安"}]}',
        },
      },
    };

    const result = await executor?.(session, context);
    expect(typeof result).toBe('number');
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['晚安']);
    expect(context.options.responseMessage).toBeNull();
  });
});
