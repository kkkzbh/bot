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
  pluginConfig?: Record<string, unknown>;
} = {}) {
  const middlewares: Middleware[] = [];
  const events = new Map<string, EventHandler[]>();
  const chainMiddlewares = new Map<string, ChainMiddleware>();
  const inject = vi.fn();
  const bot = {
    platform: 'onebot',
    selfId: 'bot-1',
    internal: {
      _request: vi.fn(async () => ({ retcode: 0, data: { yes: true } })),
      canSendRecord: vi.fn(async () => {
        if (overrides.canSendRecordImpl) return overrides.canSendRecordImpl();
        return overrides.canSendRecord ?? true;
      }),
      getRecord: vi.fn(async (file: string) => ({ file })),
      sendPrivateMsg: vi.fn(async () => 'msg-id'),
      sendGroupMsg: vi.fn(async () => 'msg-id'),
    },
    sendMessage: vi.fn(async () => ['msg-id']),
  };

  const ctx = {
    bots: [bot],
    get: vi.fn((name: string) => {
      if (name !== 'chatluna') return undefined;
      return {
        contextManager: { inject },
        chatChain: createChainBuilder(chainMiddlewares),
      };
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
    outputMaxChars: 120,
    transcribeTimeoutMs: 30_000,
    synthTimeoutMs: 90_000,
    ...overrides.pluginConfig,
  });

  return {
    inbound: middlewares[0],
    beforeSend: (events.get('before-send') ?? [])[0],
    ready: (events.get('ready') ?? [])[0],
    getOutputHint: () => chainMiddlewares.get('qqbot_voice_output_hint'),
    inject,
    bot,
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
    stripped: { content: String(overrides.strippedContent ?? '') },
    state: {},
    bot,
    send: vi.fn(async () => ['msg-id']),
    ...overrides,
  };
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
    expect(session.stripped.content).toBe('补充说明\n转写内容');
    expect(session.state.qqVoice).toEqual({
      transcript: '转写内容',
      durationMs: 1_500,
      source: 'src',
      voiceReplyRequested: false,
    });
  });

  it('replies with persona failure text when ASR returns empty text', async () => {
    vi.useFakeTimers();
    const { inbound, bot } = createHarness();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://example.com/input.amr') {
        return new Response(Uint8Array.from([1, 2, 3]), { status: 200 });
      }
      if (url === 'http://127.0.0.1:8081/transcribe' && init?.method === 'POST') {
        return Response.json({ text: '', language: 'zh', durationMs: 1_500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = createSession(bot, {
      content: '<audio src="https://example.com/input.amr"/>',
      strippedContent: '',
    });

    const pending = inbound(session, async () => 'should-not-run');
    await vi.runAllTimersAsync();
    await pending;
    const calls = bot.sendMessage.mock.calls as Array<any[]>;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((call) => String(call[1] ?? '')).join('\n')).toContain('几乎什么都没有');
  });

  it('sends normalized text first and then one audio payload for qqbot voice replies', async () => {
    const { beforeSend, bot } = createHarness();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8082/healthz' && (init?.method === 'GET' || !init?.method)) {
        return new Response('ok', { status: 200 });
      }
      if (url === 'http://127.0.0.1:8082/synthesize' && init?.method === 'POST') {
        return new Response(Uint8Array.from([82, 73, 70, 70]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = createSession(bot, {
      content: '普通文本\n<qqbot-voice>\n附带语音\n</qqbot-voice>',
    });

    const result = await beforeSend(session, {});
    const calls = bot.sendMessage.mock.calls as Array<any[]>;
    expect(result).toBe(true);
    expect(bot.internal.canSendRecord).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toBe('普通文本');
    expect(String(calls[1]?.[1] ?? '')).toContain('<audio src="data:audio/wav;base64,');
  });

  it('extracts qqbot voice replies from structured rich-text outbound content', async () => {
    const { beforeSend, bot } = createHarness();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8082/healthz' && (init?.method === 'GET' || !init?.method)) {
        return new Response('ok', { status: 200 });
      }
      if (url === 'http://127.0.0.1:8082/synthesize' && init?.method === 'POST') {
        return new Response(Uint8Array.from([82, 73, 70, 70]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = createSession(bot, {
      content: [
        '晚安\n\n',
        {
          type: 'p',
          attrs: {},
          children: [
            { type: 'text', attrs: { content: '<qqbot-voice>' }, children: [] },
            { type: 'text', attrs: { content: '\n' }, children: [] },
            { type: 'text', attrs: { content: '晚安' }, children: [] },
            { type: 'text', attrs: { content: '\n' }, children: [] },
            { type: 'text', attrs: { content: '</qqbot-voice>' }, children: [] },
          ],
        },
      ],
    });

    const result = await beforeSend(session, {});
    const calls = bot.sendMessage.mock.calls as Array<any[]>;
    expect(result).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toBe('晚安');
    expect(String(calls[1]?.[1] ?? '')).toContain('<audio src="data:audio/wav;base64,');
  });

  it('injects unavailable hint when explicit voice request is made but TTS is unreachable', async () => {
    const { ready, getOutputHint, inject, bot } = createHarness();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8082/healthz') {
        throw new Error('connect timeout');
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await ready();
    const outputHint = getOutputHint();
    expect(outputHint).toBeTypeOf('function');

    const session = createSession(bot, {
      content: '请发一条语音给我听',
      strippedContent: '请发一条语音给我听',
    });
    const context = {
      options: {
        room: {
          conversationId: 'conv-1',
        },
      },
    };

    await outputHint?.(session, context);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]?.[0]).toMatchObject({
      name: 'qqbot_voice_output_unavailable',
      conversationId: 'conv-1',
      once: true,
      stage: 'after_scratchpad',
    });
  });

  it('caches optimistic record support after early ready-time probe failure', async () => {
    let attempt = 0;
    const { ready, beforeSend, bot } = createHarness({
      canSendRecordImpl: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('this._request is not a function');
        }
        return true;
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8082/healthz' && (init?.method === 'GET' || !init?.method)) {
        return new Response('ok', { status: 200 });
      }
      if (url === 'http://127.0.0.1:8082/synthesize' && init?.method === 'POST') {
        return new Response(Uint8Array.from([82, 73, 70, 70]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await ready();
    const session = createSession(bot, {
      content: '普通文本\n<qqbot-voice>\n附带语音\n</qqbot-voice>',
    });

    await beforeSend(session, {});
    const calls = bot.sendMessage.mock.calls as Array<any[]>;
    expect(bot.internal.canSendRecord).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toBe('普通文本');
    expect(String(calls[1]?.[1] ?? '')).toContain('<audio src="data:audio/wav;base64,');
  });

  it('falls back to optimistic record support when onebot canSendRecord probe is broken', async () => {
    const { beforeSend, bot } = createHarness({
      canSendRecordImpl: async () => {
        throw new Error('this._request is not a function');
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8082/healthz' && (init?.method === 'GET' || !init?.method)) {
        return new Response('ok', { status: 200 });
      }
      if (url === 'http://127.0.0.1:8082/synthesize' && init?.method === 'POST') {
        return new Response(Uint8Array.from([82, 73, 70, 70]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = createSession(bot, {
      content: '普通文本\n<qqbot-voice>\n附带语音\n</qqbot-voice>',
    });

    await beforeSend(session, {});
    const calls = bot.sendMessage.mock.calls as Array<any[]>;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toBe('普通文本');
    expect(String(calls[1]?.[1] ?? '')).toContain('<audio src="data:audio/wav;base64,');
  });

  it('degrades to text-only when record sending is unavailable', async () => {
    const { beforeSend, bot } = createHarness({ canSendRecord: false });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const session = createSession(bot, {
      content: '普通文本\n<qqbot-voice>\n附带语音\n</qqbot-voice>',
    });

    await beforeSend(session, {});
    const calls = bot.sendMessage.mock.calls as Array<any[]>;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe('普通文本');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps distinct text outside the voice tag and sends one extra audio payload', async () => {
    const { beforeSend, bot } = createHarness();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8082/healthz' && (init?.method === 'GET' || !init?.method)) {
        return new Response('ok', { status: 200 });
      }
      if (url === 'http://127.0.0.1:8082/synthesize' && init?.method === 'POST') {
        return new Response(Uint8Array.from([82, 73, 70, 70]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = createSession(bot, {
      content: '这是补充文本。\n<qqbot-voice>\n晚安\n</qqbot-voice>',
    });

    await beforeSend(session, {});
    const calls = bot.sendMessage.mock.calls as Array<any[]>;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toBe('这是补充文本。');
    expect(String(calls[1]?.[1] ?? '')).toContain('<audio src="data:audio/wav;base64,');
  });

  it('respects original segment order for local multiline and voice blocks', async () => {
    const { beforeSend, bot } = createHarness();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:8082/healthz' && (init?.method === 'GET' || !init?.method)) {
        return new Response('ok', { status: 200 });
      }
      if (url === 'http://127.0.0.1:8082/synthesize' && init?.method === 'POST') {
        return new Response(Uint8Array.from([82, 73, 70, 70]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = createSession(bot, {
      content: 'x\ny\n<qqbot-multiline>\n哈哈\n你好\n</qqbot-multiline>\n我\n<qqbot-voice>\n我说话\n</qqbot-voice>\n你',
    });

    await beforeSend(session, {});
    const calls = bot.sendMessage.mock.calls as Array<any[]>;
    expect(calls.map((call) => String(call[1] ?? ''))).toEqual([
      'x',
      'y',
      '哈哈\n你好',
      '我',
      expect.stringContaining('<audio src="data:audio/wav;base64,'),
      '你',
    ]);
  });
});
