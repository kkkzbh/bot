import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../src/plugins/triggers/group-natural/index.js';
import type { NaturalTriggerState } from '../src/plugins/triggers/group-natural/state.js';

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

  class MockLogger {
    info(): void {}
    warn(): void {}
    debug(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      boolean: () => createSchemaNode(),
      number: () => createSchemaNode(),
      natural: () => createSchemaNode(),
      union: () => createSchemaNode(),
      array: () => createSchemaNode(),
      string: () => createSchemaNode(),
      const: () => createSchemaNode(),
    },
  };
});

type Middleware = (session: Record<string, any>, next: () => Promise<unknown>) => Promise<unknown>;
type EventListener = (...args: any[]) => unknown;
type AllowReplyResolver = (arg: { session: Record<string, any>; context: unknown }) => unknown;

function createHarness(
  overrides: Record<string, unknown> = {},
  options: { attachedChatlunaAvailable?: boolean; getterChatlunaAvailable?: boolean } = {},
): {
  middleware: Middleware;
  registerAllowReplyResolver: ReturnType<typeof vi.fn>;
  disposeAllowReplyResolver: ReturnType<typeof vi.fn>;
  runReady: () => Promise<void>;
  runDispose: () => Promise<void>;
  setAttachedChatLunaAvailable: (available: boolean) => void;
  setGetterChatLunaAvailable: (available: boolean) => void;
} {
  const middlewares: Middleware[] = [];
  const listeners = new Map<string, EventListener[]>();
  const disposeAllowReplyResolver = vi.fn();
  const registerAllowReplyResolver = vi.fn(function (this: any, _name: string, _resolver: AllowReplyResolver) {
    if (this !== chatlunaService) {
      throw new Error('registerAllowReplyResolver lost chatluna binding');
    }
    return disposeAllowReplyResolver;
  });
  const chatlunaService = { registerAllowReplyResolver };
  let attachedChatlunaService = options.attachedChatlunaAvailable === false ? undefined : chatlunaService;
  let getterChatlunaService = options.getterChatlunaAvailable ? chatlunaService : undefined;
  const ctx: Record<string, unknown> = {
    middleware: vi.fn((handler: Middleware) => {
      middlewares.push(handler);
    }),
    on: vi.fn((name: string, handler: EventListener) => {
      const bucket = listeners.get(name) ?? [];
      bucket.push(handler);
      listeners.set(name, bucket);
    }),
    get: vi.fn((name: string) => (name === 'chatluna' ? getterChatlunaService : undefined)),
  };

  ctx.chatluna = attachedChatlunaService;

  apply(ctx as never, {
    enabled: true,
    enabledGroups: '',
    aliases: '祥子',
    directTriggerProbability: 0,
    focusWindowMs: 300_000,
    replyIntervalMs: 2_000,
    spamWindowMs: 10_000,
    spamThreshold: 10,
    spamMuteMs: 180_000,
    decisionEnabled: false,
    ...overrides,
  });

  const runHook = async (name: string): Promise<void> => {
    for (const listener of listeners.get(name) ?? []) {
      await listener();
    }
  };

  return {
    middleware: middlewares[0],
    registerAllowReplyResolver,
    disposeAllowReplyResolver,
    runReady: () => runHook('ready'),
    runDispose: () => runHook('dispose'),
    setAttachedChatLunaAvailable: (available: boolean) => {
      attachedChatlunaService = available ? chatlunaService : undefined;
      ctx.chatluna = attachedChatlunaService;
    },
    setGetterChatLunaAvailable: (available: boolean) => {
      getterChatlunaService = available ? chatlunaService : undefined;
    },
  };
}

function createSession(overrides: Record<string, unknown> = {}): Record<string, any> {
  const content = String(overrides.content ?? '');
  return {
    platform: 'onebot',
    isDirect: false,
    channelId: '100',
    guildId: '100',
    userId: 'u1',
    content,
    stripped: { content },
    bot: { selfId: 'bot-1' },
    elements: [],
    ...overrides,
  };
}

async function runAndCapture(
  middleware: Middleware,
  session: Record<string, any>,
): Promise<{ content: string; naturalTrigger: NaturalTriggerState | null }> {
  let naturalTrigger: NaturalTriggerState | null = null;
  const result = await middleware(session, async () => {
    naturalTrigger = (session.qqNaturalTrigger as NaturalTriggerState | undefined) ?? null;
    return session.content;
  });
  return {
    content: typeof result === 'string' ? result : '',
    naturalTrigger,
  };
}

describe('group natural trigger middleware', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shares focus within the same group and keeps other groups isolated', async () => {
    const { middleware } = createHarness({ replyIntervalMs: 0 });

    await runAndCapture(
      middleware,
      createSession({
        channelId: '100',
        guildId: '100',
        userId: 'u1',
        content: '祥子 在吗',
      }),
    );

    const sameGroup = await runAndCapture(
      middleware,
      createSession({
        channelId: '100',
        guildId: '100',
        userId: 'u2',
        content: '我补充一下',
      }),
    );
    const otherGroup = await runAndCapture(
      middleware,
      createSession({
        channelId: '200',
        guildId: '200',
        userId: 'u3',
        content: '我也补充一下',
      }),
    );

    expect(sameGroup.content).toBe('我补充一下');
    expect(sameGroup.naturalTrigger).toEqual({ reason: 'focus', explicit: false });
    expect(otherGroup.content).toBe('我也补充一下');
    expect(otherGroup.naturalTrigger).toBeNull();
  });

  it('keeps reply interval isolated by group', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T12:00:00+08:00'));

    const { middleware } = createHarness({ replyIntervalMs: 2_000 });

    await runAndCapture(
      middleware,
      createSession({
        channelId: '100',
        guildId: '100',
        userId: 'u1',
        content: '祥子 在吗',
      }),
    );

    const session = createSession({
      channelId: '200',
      guildId: '200',
      userId: 'u2',
      content: '祥子 帮我看下',
    });
    let captured = '';
    let naturalTrigger: NaturalTriggerState | null = null;
    const pending = middleware(session, async () => {
      captured = session.content;
      naturalTrigger = (session.qqNaturalTrigger as NaturalTriggerState | undefined) ?? null;
      return captured;
    });

    await Promise.resolve();

    expect(captured).toBe('祥子 帮我看下');
    expect(naturalTrigger).toEqual({ reason: 'alias', explicit: true });
    await expect(pending).resolves.toBe('祥子 帮我看下');
  });

  it('allows quoted image-only messages to enter the main chain', async () => {
    const { middleware } = createHarness({ replyIntervalMs: 0 });

    const result = await runAndCapture(
      middleware,
      createSession({
        content: '',
        stripped: { content: '' },
        elements: [{ type: 'img', attrs: { src: 'https://example.com/1.png' }, children: [] }],
        quote: { user: { id: 'bot-1' } },
      }),
    );

    expect(result.content).toBe('');
    expect(result.naturalTrigger).toEqual({ reason: 'quote', explicit: true });
  });

  it('sends only the user message content to the decision model', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"trigger":true,"confidence":0.9}',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { middleware } = createHarness({
      replyIntervalMs: 0,
      decisionEnabled: true,
      decisionBaseUrl: 'https://decision.example/v1',
      decisionApiKey: 'test-key',
      decisionModel: 'test-model',
    });

    const result = await runAndCapture(
      middleware,
      createSession({
        content: '普通闲聊一下',
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const requestBody = JSON.parse(String(requestInit?.body ?? '{}')) as {
      messages?: Array<{ role?: string; content?: string }>;
    };

    expect(requestBody.messages?.[1]?.role).toBe('user');
    expect(requestBody.messages?.[1]?.content).toBe('消息: 普通闲聊一下');
    expect(result.naturalTrigger).toEqual({ reason: 'model', explicit: false });
  });

  it('does not trigger image-only group messages without an existing trigger condition', async () => {
    const { middleware } = createHarness({ replyIntervalMs: 0 });

    const result = await runAndCapture(
      middleware,
      createSession({
        content: '',
        stripped: { content: '' },
        elements: [{ type: 'img', attrs: { src: 'https://example.com/1.png' }, children: [] }],
      }),
    );

    expect(result.content).toBe('');
    expect(result.naturalTrigger).toBeNull();
  });

  it('waits for the same-group reply interval instead of dropping focused messages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T13:00:00+08:00'));

    const { middleware } = createHarness({ replyIntervalMs: 2_000 });
    let firstAt = 0;

    const firstSession = createSession({
      channelId: '100',
      guildId: '100',
      userId: 'u1',
      content: '祥子 在吗',
    });

    await middleware(firstSession, async () => {
      firstAt = Date.now();
      return firstSession.content;
    });

    const secondSession = createSession({
      channelId: '100',
      guildId: '100',
      userId: 'u2',
      content: '继续说',
    });
    let secondAt = 0;
    let secondContent = '';
    let secondTrigger: NaturalTriggerState | null = null;

    const pending = middleware(secondSession, async () => {
      secondAt = Date.now();
      secondContent = secondSession.content;
      secondTrigger = (secondSession.qqNaturalTrigger as NaturalTriggerState | undefined) ?? null;
      return secondContent;
    });

    await Promise.resolve();
    expect(secondContent).toBe('');

    await vi.advanceTimersByTimeAsync(1_999);
    expect(secondContent).toBe('');

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('继续说');
    expect(secondAt - firstAt).toBe(2_000);
    expect(secondTrigger).toEqual({ reason: 'focus', explicit: false });
  });

  it('keeps quoted follow-ups as original text and marks them explicit', async () => {
    const { middleware } = createHarness({ replyIntervalMs: 0 });
    const session = createSession({
      content: '这啥东西',
      quote: {
        user: {
          id: 'bot-1',
        },
      },
    });

    const captured = await runAndCapture(middleware, session);

    expect(captured.content).toBe('这啥东西');
    expect(captured.naturalTrigger).toEqual({ reason: 'quote', explicit: true });
  });

  it('registers an allow-reply resolver that only allows active natural triggers', async () => {
    const { middleware, registerAllowReplyResolver, runReady } = createHarness({ replyIntervalMs: 0 });

    await runReady();

    expect(registerAllowReplyResolver).toHaveBeenCalledTimes(1);
    const resolver = registerAllowReplyResolver.mock.calls[0]?.[1] as AllowReplyResolver;
    expect(resolver).toBeTypeOf('function');

    const session = createSession({
      content: '祥子 在吗',
    });

    let allowResult: unknown;
    await middleware(session, async () => {
      allowResult = await resolver({ session, context: {} });
      return session.content;
    });

    expect(allowResult).toBe(true);
    await expect(Promise.resolve(resolver({ session: createSession({ content: '普通闲聊' }), context: {} }))).resolves.toBeUndefined();
  });

  it('retries allow-reply resolver registration until chatluna becomes available', async () => {
    vi.useFakeTimers();

    const {
      registerAllowReplyResolver,
      runReady,
      setAttachedChatLunaAvailable,
      runDispose,
      disposeAllowReplyResolver,
    } = createHarness({}, { attachedChatlunaAvailable: false });

    await runReady();
    expect(registerAllowReplyResolver).not.toHaveBeenCalled();

    setAttachedChatLunaAvailable(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(registerAllowReplyResolver).toHaveBeenCalledTimes(1);

    await runDispose();
    expect(disposeAllowReplyResolver).toHaveBeenCalledTimes(1);
  });

  it('registers the allow-reply resolver on demand via ctx.get when ready-time discovery misses chatluna', async () => {
    const { middleware, registerAllowReplyResolver, runReady, setGetterChatLunaAvailable } = createHarness(
      { replyIntervalMs: 0 },
      { attachedChatlunaAvailable: false, getterChatlunaAvailable: false },
    );

    await runReady();
    expect(registerAllowReplyResolver).not.toHaveBeenCalled();

    setGetterChatLunaAvailable(true);

    const first = await runAndCapture(
      middleware,
      createSession({
        content: '请帮我总结一下',
      }),
    );
    const second = await runAndCapture(
      middleware,
      createSession({
        userId: 'u2',
        content: '请告诉我今天要做什么',
      }),
    );

    expect(registerAllowReplyResolver).toHaveBeenCalledTimes(1);
    expect(first.naturalTrigger).toEqual({ reason: 'rule', explicit: true });
    expect(second.naturalTrigger).toEqual({ reason: 'rule', explicit: true });
  });

  it('does not mark a message as naturally triggered when the allow-reply bridge is still unavailable', async () => {
    const { middleware, registerAllowReplyResolver, runReady } = createHarness(
      { replyIntervalMs: 0 },
      { attachedChatlunaAvailable: false, getterChatlunaAvailable: false },
    );

    await runReady();

    const captured = await runAndCapture(
      middleware,
      createSession({
        content: '请帮我看一下这个问题',
      }),
    );

    expect(registerAllowReplyResolver).not.toHaveBeenCalled();
    expect(captured.content).toBe('请帮我看一下这个问题');
    expect(captured.naturalTrigger).toBeNull();
  });
});
