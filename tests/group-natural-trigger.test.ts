import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../src/plugins/group-natural-trigger.js';

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
    },
  };
});

type Middleware = (session: Record<string, any>, next: () => Promise<unknown>) => Promise<unknown>;

function createHarness(overrides: Record<string, unknown> = {}): Middleware {
  const middlewares: Middleware[] = [];
  const ctx = {
    middleware: vi.fn((handler: Middleware) => {
      middlewares.push(handler);
    }),
    on: vi.fn(),
  };

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

  return middlewares[0];
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
    ...overrides,
  };
}

async function runAndCapture(middleware: Middleware, session: Record<string, any>): Promise<string> {
  const result = await middleware(session, async () => session.content);
  return typeof result === 'string' ? result : '';
}

describe('group natural trigger middleware', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares focus within the same group and keeps other groups isolated', async () => {
    const middleware = createHarness({ replyIntervalMs: 0 });

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

    expect(sameGroup).toBe('祥子 我补充一下');
    expect(otherGroup).toBe('我也补充一下');
  });

  it('keeps reply interval isolated by group', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T12:00:00+08:00'));

    const middleware = createHarness({ replyIntervalMs: 2_000 });

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
    const pending = middleware(session, async () => {
      captured = session.content;
      return captured;
    });

    await Promise.resolve();

    expect(captured).toBe('祥子 祥子 帮我看下');
    await expect(pending).resolves.toBe('祥子 祥子 帮我看下');
  });

  it('waits for the same-group reply interval instead of dropping focused messages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T13:00:00+08:00'));

    const middleware = createHarness({ replyIntervalMs: 2_000 });
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

    const pending = middleware(secondSession, async () => {
      secondAt = Date.now();
      secondContent = secondSession.content;
      return secondContent;
    });

    await Promise.resolve();
    expect(secondContent).toBe('');

    await vi.advanceTimersByTimeAsync(1_999);
    expect(secondContent).toBe('');

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('祥子 继续说');
    expect(secondAt - firstAt).toBe(2_000);
  });
});
