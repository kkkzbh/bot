import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, inject } from '../src/plugins/triggers/group-natural/index.js';
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
type ChatChainMiddleware = (session: Record<string, any>, context: Record<string, any>) => Promise<number>;
type EventListener = (...args: any[]) => unknown;
type AllowReplyResolver = (arg: { session: Record<string, any>; context: unknown }) => unknown;

function createHarness(
  overrides: Record<string, unknown> = {},
): {
  middleware: Middleware;
  chatChainMiddlewares: Map<string, ChatChainMiddleware>;
  messageTransformer: { transform: ReturnType<typeof vi.fn> };
  registerAllowReplyResolver: ReturnType<typeof vi.fn>;
  disposeAllowReplyResolver: ReturnType<typeof vi.fn>;
  runReady: () => Promise<void>;
  runDispose: () => Promise<void>;
} {
  const middlewares: Middleware[] = [];
  const chatChainMiddlewares = new Map<string, ChatChainMiddleware>();
  const listeners = new Map<string, EventListener[]>();
  const disposeAllowReplyResolver = vi.fn();
  const messageTransformer = {
    transform: vi.fn(),
  };
  const registerAllowReplyResolver = vi.fn(function (this: any, _name: string, _resolver: AllowReplyResolver) {
    if (this !== chatlunaService) {
      throw new Error('registerAllowReplyResolver lost chatluna binding');
    }
    return disposeAllowReplyResolver;
  });
  const chatChain = {
    middleware: vi.fn((name: string, middleware: ChatChainMiddleware) => {
      chatChainMiddlewares.set(name, middleware);
      const builder = {
        after: () => builder,
        before: () => builder,
      };
      return builder;
    }),
  };
  const chatlunaService = { registerAllowReplyResolver, chatChain, messageTransformer };
  const featurePolicy = {
    resolveFeatureEnabled: vi.fn(async () => true),
  };
  const ctx: Record<string, unknown> = {
    middleware: vi.fn((handler: Middleware) => {
      middlewares.push(handler);
    }),
    on: vi.fn((name: string, handler: EventListener) => {
      const bucket = listeners.get(name) ?? [];
      bucket.push(handler);
      listeners.set(name, bucket);
    }),
    chatluna: chatlunaService,
    featurePolicy,
  };

  apply(ctx as never, {
    enabled: true,
    enabledGroups: '100,200',
    aliases: '祥子',
    directTriggerProbability: 0,
    focusWindowMs: 300_000,
    replyIntervalMs: 2_000,
    spamWindowMs: 10_000,
    spamThreshold: 10,
    spamMuteMs: 180_000,
    decisionEnabled: false,
    decisionBaseUrl: 'https://decision.example/v1',
    decisionApiKey: '',
    decisionModel: '',
    decisionTimeoutMs: 4_000,
    decisionMinConfidence: 0.62,
    ...overrides,
  });

  const runHook = async (name: string): Promise<void> => {
    for (const listener of listeners.get(name) ?? []) {
      await listener();
    }
  };

  return {
    middleware: middlewares[0],
    chatChainMiddlewares,
    messageTransformer,
    registerAllowReplyResolver,
    disposeAllowReplyResolver,
    runReady: () => runHook('ready'),
    runDispose: () => runHook('dispose'),
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
    vi.unstubAllEnvs();
  });

  it('declares runtime services as required injections', () => {
    expect(inject).toEqual({ required: ['chatluna', 'featurePolicy'] });
  });

  it('fails fast without the required feature policy service', () => {
    const ctx = {
      middleware: vi.fn(),
      on: vi.fn(),
      chatluna: {
        registerAllowReplyResolver: vi.fn(),
      },
    };

    expect(() =>
      apply(ctx as never, {
        enabled: true,
        enabledGroups: '100',
        aliases: '祥子',
        directTriggerProbability: 0,
        focusWindowMs: 300_000,
        replyIntervalMs: 2_000,
        spamWindowMs: 10_000,
        spamThreshold: 10,
        spamMuteMs: 180_000,
        decisionEnabled: false,
        decisionBaseUrl: 'https://decision.example/v1',
        decisionApiKey: '',
        decisionModel: '',
        decisionTimeoutMs: 4_000,
        decisionMinConfidence: 0.62,
      }),
    ).toThrow('group-natural-trigger requires featurePolicy service.');
  });

  it('fails fast when the enabled config is missing', () => {
    expect(() => createHarness({ enabled: undefined })).toThrow('群聊自然触发配置缺失：enabled');
  });

  it('keeps natural trigger disabled when the enabled config is false', async () => {
    const { middleware } = createHarness({ enabled: false, replyIntervalMs: 0 });

    const result = await runAndCapture(
      middleware,
      createSession({
        content: '祥子 在吗',
      }),
    );

    expect(result.naturalTrigger).toBeNull();
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

  it('requires an explicit whitelist group before natural trigger can fire', async () => {
    const { middleware } = createHarness({ enabledGroups: '', replyIntervalMs: 0 });

    const result = await runAndCapture(
      middleware,
      createSession({
        channelId: '100',
        guildId: '100',
        content: '祥子 在吗',
      }),
    );

    expect(result.naturalTrigger).toBeNull();
  });

  it('does not trigger without complete group session identity', async () => {
    const { middleware } = createHarness({ replyIntervalMs: 0 });

    await expect(runAndCapture(
      middleware,
      createSession({
        platform: '',
        content: '祥子 在吗',
      }),
    )).resolves.toEqual(expect.objectContaining({ naturalTrigger: null }));
    await expect(runAndCapture(
      middleware,
      createSession({
        bot: { selfId: '' },
        content: '祥子 在吗',
      }),
    )).resolves.toEqual(expect.objectContaining({ naturalTrigger: null }));
  });

  it('does not register realtime promotion or media middleware on ready', async () => {
    const { runReady, chatChainMiddlewares, messageTransformer } = createHarness();

    await runReady();

    expect(chatChainMiddlewares.size).toBe(0);
    expect(messageTransformer.transform).not.toHaveBeenCalled();
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
    const firstCall = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined] | undefined;
    const requestInit = firstCall?.[1];
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
    const { middleware, registerAllowReplyResolver, runReady, runDispose, disposeAllowReplyResolver } = createHarness({
      replyIntervalMs: 0,
    });

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

    await runDispose();
    expect(disposeAllowReplyResolver).toHaveBeenCalledTimes(1);
  });
});
