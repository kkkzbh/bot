import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi-plugin-cron', () => ({}));

vi.mock('cron-parser', () => ({
  parseExpression: vi.fn(() => ({
    next: () => ({
      getTime: () => Date.now() + 60_000,
    }),
  })),
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
    Session: class {},
    h: {
      at: (id: string) => `@${id}`,
    },
  };
});

import { apply } from '../src/plugins/automation/index.js';

type Middleware = (session: Record<string, any>, next: () => Promise<unknown>) => Promise<unknown>;

function createHarness() {
  const middlewares: Middleware[] = [];
  const tasks: Record<string, any>[] = [];

  const database = {
    get: vi.fn(async (table: string, query: Record<string, any>) => {
      if (table !== 'automation_task') return [];

      return tasks.filter((task) =>
        Object.entries(query).every(([key, value]) => {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            return true;
          }
          return task[key] === value;
        }),
      );
    }),
    create: vi.fn(async (_table: string, record: Record<string, any>) => {
      const created = {
        id: tasks.length + 1,
        ...record,
      };
      tasks.push(created);
      return created;
    }),
    set: vi.fn(async () => undefined),
  };

  const ctx = {
    bots: [],
    database,
    model: {
      extend: vi.fn(),
    },
    middleware: vi.fn((handler: Middleware) => {
      middlewares.push(handler);
    }),
    command: vi.fn(() => ({
      action: vi.fn(() => undefined),
    })),
    on: vi.fn(() => undefined),
  };

  apply(ctx as never, {
    enabledGroups: '829573670',
    listenPrivate: true,
    permissionMode: 'all',
    intentEnabled: true,
    deliveryBaseUrl: '',
    deliveryApiKey: '',
    deliveryModel: 'deepseek-reasoner',
  });

  return {
    middleware: middlewares[0],
    database,
    tasks,
  };
}

describe('task automation middleware', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T08:00:00+08:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('intercepts stripped mention reminder text, creates a task, and does not fall through to chat', async () => {
    const { middleware, database, tasks } = createHarness();
    const next = vi.fn(async () => 'next');
    const session = {
      userId: 'u1',
      platform: 'onebot',
      guildId: '829573670',
      channelId: 'group:829573670',
      isDirect: false,
      content: '<at id="bot-1" name="小祥"/> 10s后提醒我关门',
      stripped: {
        content: '10s后提醒我关门',
      },
      bot: {
        selfId: 'bot-1',
      },
      send: vi.fn(async () => ['msg-id']),
    };

    const result = await middleware(session, next);

    expect(result).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    expect(database.create).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual(
      expect.objectContaining({
        kind: 'once',
        scope: 'group',
        channelId: 'group:829573670',
        guildId: '829573670',
        message: '关门',
        status: 'active',
      }),
    );
    expect(session.send).toHaveBeenCalledWith(
      '记住了，08:00提醒你关门',
      expect.any(Object),
    );
  });
});
