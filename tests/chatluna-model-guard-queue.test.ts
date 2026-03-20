import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi-plugin-chatluna/chains', () => ({
  ChainMiddlewareRunStatus: { STOP: 1, CONTINUE: 0 },
  checkConversationRoomAvailability: vi.fn(async () => true),
  fixConversationRoomAvailability: vi.fn(async () => true),
}));

const promptAssemblyMocks = vi.hoisted(() => ({
  beginPromptAssemblyTurn: vi.fn(),
  registerPromptFragment: vi.fn(),
}));

vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
    role: () => MockSchemaNode;
    min: () => MockSchemaNode;
    max: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
    role: () => createSchemaNode(),
    min: () => createSchemaNode(),
    max: () => createSchemaNode(),
  });

  class MockLogger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
  }

  return {
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
  };
});

vi.mock('../src/plugins/shared/prompt-context/index.js', () => ({
  beginPromptAssemblyTurn: promptAssemblyMocks.beginPromptAssemblyTurn,
  registerPromptFragment: promptAssemblyMocks.registerPromptFragment,
}));

import { apply } from '../src/plugins/model-guard/index.js';

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

function createHarness() {
  const middlewares: Array<(session: Record<string, any>, next: () => Promise<unknown>) => Promise<unknown>> = [];
  const events = new Map<string, Array<(...args: any[]) => unknown>>();
  const chainMiddlewares = new Map<string, ChainMiddleware>();
  const chatluna = {
    platform: {
      listAllModels: vi.fn(() => ({
        value: [{ toModelName: () => 'deepseek/deepseek-chat' }],
      })),
    },
    awaitLoadPlatform: vi.fn(async () => undefined),
    chatChain: createChainBuilder(chainMiddlewares),
  };

  const ctx = {
    chatluna,
    get: vi.fn((name: string) => (name === 'chatluna' ? chatluna : undefined)),
    middleware: vi.fn((handler: any) => {
      middlewares.push(handler);
    }),
    on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
      const existing = events.get(name) ?? [];
      existing.push(handler);
      events.set(name, existing);
    }),
  };

  apply(ctx as never, {});

  return {
    ctx,
    middlewares,
    events,
    chainMiddlewares,
    ready: (events.get('ready') ?? [])[0],
  };
}

describe('chatluna model guard runtime shape', () => {
  it('does not register legacy before-send transport interception', () => {
    const harness = createHarness();
    expect(harness.events.get('before-send') ?? []).toHaveLength(0);
    expect(harness.middlewares).toHaveLength(0);
  });

  it('registers only time-context and model-guard chain middlewares on ready', () => {
    const harness = createHarness();
    harness.ready?.();

    expect(harness.chainMiddlewares.has('chatluna_time_context')).toBe(true);
    expect(harness.chainMiddlewares.has('chatluna_model_guard')).toBe(true);
    expect(harness.chainMiddlewares.has('qqbot_live_replan_gate')).toBe(false);
  });
});
