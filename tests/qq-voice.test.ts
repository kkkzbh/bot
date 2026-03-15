import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi-plugin-chatluna/chains', () => ({
  ChainMiddlewareRunStatus: { STOP: 1, CONTINUE: 0 },
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
    },
  };
});

import { apply } from '../src/plugins/qq-voice.js';

type Middleware = (session: Record<string, any>, next: () => Promise<unknown>) => Promise<unknown>;
type EventHandler = (...args: any[]) => Promise<unknown> | unknown;
type ChainMiddleware = (session: Record<string, any>, context: Record<string, any>) => Promise<number>;
type ToolDescriptor = {
  createTool: (params: unknown) => any;
  selector: () => boolean;
  authorization?: (session: Record<string, any>) => boolean;
};

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
  const registeredTools = new Map<string, ToolDescriptor>();
  const inject = vi.fn();

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
    chatChain: createChainBuilder(chainMiddlewares),
    platform: {
      registerTool: vi.fn((name: string, tool: ToolDescriptor) => {
        registeredTools.set(name, tool);
      }),
    },
  };

  const ctx = {
    bots: [bot],
    chatluna,
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
    setInterval: vi.fn(),
  };

  apply(ctx as never, {
    enabled: true,
    inputEnabled: true,
    outputEnabled: true,
    asrBaseUrl: 'http://127.0.0.1:8081',
    ttsBaseUrl: 'http://127.0.0.1:8082',
    inputMaxSeconds: 60,
    outputMaxChars: 30,
    transcribeTimeoutMs: 30_000,
    synthTimeoutMs: 180_000,
    ...overrides.pluginConfig,
  });

  return {
    inbound: middlewares[0],
    capabilityMiddleware: middlewares[1],
    beforeSend: (events.get('before-send') ?? [])[0],
    ready: (events.get('ready') ?? [])[0],
    getPolicy: () => chainMiddlewares.get('qqbot_reply_transport_policy'),
    inject,
    bot,
    tools: registeredTools,
    ctx,
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

async function invokeTool(
  descriptor: ToolDescriptor,
  input: unknown,
  session: Record<string, any>,
): Promise<string> {
  const tool = descriptor.createTool({});
  return (await (tool as any)._call(input, undefined, {
    configurable: { session, conversationId: 'conv-1' },
  })) as string;
}

function createToolInstance(descriptor: ToolDescriptor): any {
  return descriptor.createTool({});
}

describe('qq voice plugin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
      voiceReplyRequested: false,
    });
  });

  it('registers reply transport tools and policy middleware on ready', async () => {
    const { ready, tools, getPolicy } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    expect(tools.has('reply_compose')).toBe(true);
    expect(tools.has('reply_compose_with_voice')).toBe(true);
    expect(getPolicy()).toBeTypeOf('function');
  });

  it('injects unavailable transport policy when explicit voice request arrives and TTS is down', async () => {
    const { ready, getPolicy, inject, bot } = createHarness();
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

    await policy?.(session, { options: { room: { conversationId: 'conv-1' } } });
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]?.[0]).toMatchObject({
      name: 'qqbot_reply_transport_policy',
      conversationId: 'conv-1',
      once: true,
      stage: 'after_scratchpad',
    });
    expect(String(inject.mock.calls[0]?.[0]?.value ?? '')).toContain('reply_compose_with_voice 不可用');
  });

  it('injects voice-capable transport policy when explicit voice request arrives and TTS is healthy', async () => {
    const { ready, getPolicy, inject, bot } = createHarness();
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
      content: '请用语音回我一句晚安',
      strippedContent: '请用语音回我一句晚安',
    });

    await policy?.(session, { options: { room: { conversationId: 'conv-voice' } } });
    const injectedPolicy = String(inject.mock.calls[0]?.[0]?.value ?? '');
    expect(injectedPolicy).toContain('reply_compose_with_voice 可用');
    expect(injectedPolicy).toContain('必须优先调用 reply_compose_with_voice');
    expect(injectedPolicy).toContain('不要直接输出纯文本');
    expect(injectedPolicy).toContain('reply_compose 和 reply_compose_with_voice 都是最终交付工具');
    expect(injectedPolicy).toContain('不要输出“（语音已发送）”');
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

  it('reply_compose sends structured segments and suppresses the later assistant text send', async () => {
    const { ready, tools, beforeSend, bot } = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await ready();
    await flushMicrotasks();

    const session = createSession(bot, {
      content: '最终正文不该再发一次',
      strippedContent: '最终正文不该再发一次',
    });
    const tool = createToolInstance(tools.get('reply_compose')!);
    const result = await tool._call(
      {
        segments: [
          { kind: 'text', content: '第一句' },
          { kind: 'multiline', content: '第二行\n第三行' },
        ],
      },
      undefined,
      {
        configurable: { session, conversationId: 'conv-1' },
      },
    );

    expect(JSON.parse(result)).toEqual({ status: 'delivered' });
    expect(tool.returnDirect).not.toBe(true);
    expect(bot.sendMessage.mock.calls.map((call: any[]) => call[1])).toEqual(['第一句', '第二行\n第三行']);

    const suppressed = await beforeSend(session, {});
    expect(suppressed).toBe(true);
    expect(bot.sendMessage.mock.calls).toHaveLength(2);
  });

  it('suppresses the trailing assistant text after voice tool delivery even when before-send sees a cloned session', async () => {
    const { ready, tools, beforeSend, bot } = createHarness();
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

    const originalSession = createSession(bot, {
      isDirect: true,
      channelId: 'private:90000123',
      guildId: undefined,
      userId: '90000123',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: true,
            source: 'forced',
            refreshedAt: Date.now(),
            explicitVoiceRequest: true,
          },
        },
      },
    });

    const tool = createToolInstance(tools.get('reply_compose_with_voice')!);
    const result = await tool._call(
      {
        segments: [{ kind: 'voice', content: '晚安' }],
      },
      undefined,
      {
        configurable: { session: originalSession, conversationId: 'conv-1' },
      },
    );

    expect(JSON.parse(result)).toEqual({ status: 'delivered' });
    expect(tool.returnDirect).not.toBe(true);
    expect(bot.sendMessage.mock.calls).toHaveLength(1);

    const clonedSendSession = createSession(bot, {
      channelId: 'private:90000123',
      guildId: undefined,
      userId: '90000123',
      content: '（语音已发送）',
      strippedContent: '（语音已发送）',
      state: {},
    });

    const suppressed = await beforeSend(clonedSendSession, {});
    expect(suppressed).toBe(true);
    expect(bot.sendMessage.mock.calls).toHaveLength(1);
  });

  it('reply_compose_with_voice authorization reuses the preloaded snapshot for private sessions even when tool auth sees no isDirect flag', async () => {
    const { ready, capabilityMiddleware, tools, bot } = createHarness();
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

    const originalSession = createSession(bot, {
      isDirect: true,
      channelId: 'private:90000123',
      guildId: undefined,
      userId: '90000123',
      content: '请用语音回我一句晚安',
      strippedContent: '请用语音回我一句晚安',
    });

    await capabilityMiddleware?.(originalSession, async () => undefined);

    const clonedSession = createSession(bot, {
      channelId: 'private:90000123',
      guildId: undefined,
      userId: '90000123',
      content: '请用语音回我一句晚安',
      strippedContent: '请用语音回我一句晚安',
      state: {},
    });

    expect(tools.get('reply_compose_with_voice')?.authorization?.(clonedSession)).toBe(true);
  });

  it('reply_compose_with_voice authorization follows the latest capability snapshot', async () => {
    const { ready, capabilityMiddleware, tools, bot } = createHarness();
    const fetchMock = vi
      .fn(async () => new Response('ok', { status: 200 }))
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await ready();
    await flushMicrotasks();

    const voiceTool = tools.get('reply_compose_with_voice')!;
    const session = createSession(bot, {
      content: '请发语音',
      strippedContent: '请发语音',
    });

    await capabilityMiddleware?.(session, async () => undefined);
    expect(voiceTool.authorization?.(session)).toBe(false);

    await capabilityMiddleware?.(session, async () => undefined);
    expect(voiceTool.authorization?.(session)).toBe(true);
  });

  it('reply_compose_with_voice authorization can reuse the preloaded snapshot on a cloned session object', async () => {
    const { ready, capabilityMiddleware, tools, bot } = createHarness();
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

    const originalSession = createSession(bot, {
      content: '请用语音回我一句晚安',
      strippedContent: '请用语音回我一句晚安',
    });

    await capabilityMiddleware?.(originalSession, async () => undefined);

    const clonedSession = createSession(bot, {
      content: '请用语音回我一句晚安',
      strippedContent: '请用语音回我一句晚安',
      state: {},
    });

    expect(tools.get('reply_compose_with_voice')?.authorization?.(clonedSession)).toBe(true);
  });

  it('reply_compose_with_voice returns structured failure without sending fallback text when preflight synthesis fails', async () => {
    const { ready, tools, bot } = createHarness();
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

    const session = createSession(bot, {
      content: '请发语音',
      strippedContent: '请发语音',
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: true,
            source: 'forced',
            refreshedAt: Date.now(),
            explicitVoiceRequest: true,
          },
        },
      },
    });

    const tool = createToolInstance(tools.get('reply_compose_with_voice')!);
    const result = await tool._call(
      {
        segments: [{ kind: 'voice', content: '晚安' }],
      },
      undefined,
      {
        configurable: { session, conversationId: 'conv-1' },
      },
    );

    expect(JSON.parse(result)).toEqual({
      status: 'unavailable',
      mode: 'voice',
      retry: 'text_only',
      reason: 'tts_preflight_failed',
    });
    expect(tool.returnDirect).not.toBe(true);
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(result).not.toContain('今天不想发语音');
  });

  it('reply_compose_with_voice sends text first and then one audio payload when synthesis succeeds', async () => {
    const { ready, tools, bot } = createHarness();
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

    const session = createSession(bot, {
      state: {
        qqReplyTransport: {
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: true,
            source: 'forced',
            refreshedAt: Date.now(),
            explicitVoiceRequest: true,
          },
        },
      },
    });

    const tool = createToolInstance(tools.get('reply_compose_with_voice')!);
    const result = await tool._call(
      {
        segments: [
          { kind: 'text', content: '这是补充文本。' },
          { kind: 'voice', content: '晚安' },
        ],
      },
      undefined,
      {
        configurable: { session, conversationId: 'conv-1' },
      },
    );

    expect(JSON.parse(result)).toEqual({ status: 'delivered' });
    expect(tool.returnDirect).not.toBe(true);
    const calls = bot.sendMessage.mock.calls as Array<any[]>;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toBe('这是补充文本。');
    expect(String(calls[1]?.[1] ?? '')).toContain('<audio src="data:audio/wav;base64,');
  });
});
