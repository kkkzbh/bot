import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../src/plugins/chatluna-model-guard.js';

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

type Middleware = (session: Record<string, any>, next: () => Promise<unknown>) => Promise<unknown>;
type BeforeSendHandler = (session: Record<string, any>, options: Record<string, any>) => Promise<boolean | void>;

function createHarness(): {
  inbound: Middleware;
  beforeSend: BeforeSendHandler;
} {
  const middlewares: Middleware[] = [];
  const eventHandlers = new Map<string, Function[]>();
  const ctx = {
    middleware: vi.fn((handler: Middleware) => {
      middlewares.push(handler);
    }),
    on: vi.fn((event: string, handler: Function) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    }),
  };

  apply(ctx as never);

  const beforeSendHandlers = eventHandlers.get('before-send') ?? [];
  if (!middlewares[0] || !beforeSendHandlers[0]) {
    throw new Error('chatluna-model-guard did not register expected handlers');
  }

  return {
    inbound: middlewares[0],
    beforeSend: beforeSendHandlers[0] as BeforeSendHandler,
  };
}

function createSession(
  sent: string[],
  sentAt: number[],
  overrides: Record<string, unknown> = {},
): Record<string, any> {
  return {
    platform: 'onebot',
    isDirect: false,
    channelId: 'group-100',
    guildId: 'group-100',
    userId: 'u1',
    content: '',
    bot: {
      selfId: 'bot-1',
      sendMessage: vi.fn(async (_channelId: string, content: string) => {
        sent.push(content);
        sentAt.push(Date.now());
        return ['msg-id'];
      }),
    },
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('chatluna model guard multiline queue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets later same-group messages finish preprocessing while the prior multiline send is still draining', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T20:00:00+08:00'));

    const { inbound, beforeSend } = createHarness();
    const sent: string[] = [];
    const sentAt: number[] = [];

    const firstSession = createSession(sent, sentAt, {
      userId: 'u1',
      content: '第一句\n第二句',
    });
    let firstFinished = false;
    const firstPending = inbound(firstSession, async () => {
      const result = await beforeSend(firstSession, {});
      firstFinished = true;
      return result;
    });

    await flushMicrotasks();
    expect(firstFinished).toBe(true);
    expect(sent).toEqual(['第一句']);

    const secondSession = createSession(sent, sentAt, {
      userId: 'u2',
      content: '甲\n乙',
    });
    let secondStarted = false;
    let secondFinished = false;
    const secondPending = inbound(secondSession, async () => {
      secondStarted = true;
      const result = await beforeSend(secondSession, {});
      secondFinished = true;
      return result;
    });

    await flushMicrotasks();
    expect(secondStarted).toBe(true);
    expect(secondFinished).toBe(true);
    expect(sent).toEqual(['第一句']);
    expect(sent).not.toContain('第二句');

    await firstPending;
    await secondPending;

    await vi.runAllTimersAsync();

    expect(sent).toEqual(['第一句', '第二句', '甲', '乙']);
    expect(sentAt[1]).toBeGreaterThan(sentAt[0]);
    expect(sentAt[2]).toBeGreaterThanOrEqual(sentAt[1]);
  });

  it('keeps unmarked multiline sends on the original synchronous path', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T20:05:00+08:00'));

    const { beforeSend } = createHarness();
    const sent: string[] = [];
    const sentAt: number[] = [];
    const session = createSession(sent, sentAt, {
      userId: 'u3',
      content: '第一句\n第二句',
    });

    let finished = false;
    const pending = beforeSend(session, {}).then((result) => {
      finished = true;
      return result;
    });

    await flushMicrotasks();
    expect(finished).toBe(false);
    expect(sent).toEqual(['第一句']);

    await vi.runAllTimersAsync();
    await pending;

    expect(finished).toBe(true);
    expect(sent).toEqual(['第一句', '第二句']);
    expect(sentAt[1]).toBeGreaterThan(sentAt[0]);
  });
});
