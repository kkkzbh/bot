import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi-plugin-chatluna/chains', () => ({
  ChainMiddlewareRunStatus: { STOP: 1, CONTINUE: 0 },
}));

vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
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
      string: () => createSchemaNode(),
    },
  };
});

const stickerCoreMocks = vi.hoisted(() => ({
  buildStickerCapabilityPolicy: vi.fn(),
  loadStickerCatalog: vi.fn(),
}));

vi.mock('../src/plugins/chatluna-sticker-core.js', () => ({
  buildStickerCapabilityPolicy: stickerCoreMocks.buildStickerCapabilityPolicy,
  loadStickerCatalog: stickerCoreMocks.loadStickerCatalog,
}));

import { apply, inject } from '../src/plugins/chatluna-sticker.js';

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

function createHarness() {
  const events = new Map<string, EventHandler[]>();
  const chainMiddlewares = new Map<string, ChainMiddleware>();
  const inject = vi.fn();

  const chatluna = {
    contextManager: { inject },
    chatChain: createChainBuilder(chainMiddlewares),
  };

  const ctx = {
    chatluna,
    get: vi.fn((name: string) => (name === 'chatluna' ? chatluna : undefined)),
    on: vi.fn((name: string, handler: EventHandler) => {
      const existing = events.get(name) ?? [];
      existing.push(handler);
      events.set(name, existing);
    }),
  };

  apply(ctx as never, { stickerDir: './data/chathub/stickers' });

  return {
    ready: (events.get('ready') ?? [])[0],
    getPolicy: () => chainMiddlewares.get('qqbot_sticker_policy'),
    inject,
  };
}

function createSession(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    platform: 'onebot',
    channelId: 'group-100',
    guildId: 'group-100',
    userId: 'u1',
    state: {},
    bot: { selfId: 'bot-1' },
    ...overrides,
  };
}

describe('chatluna sticker plugin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stickerCoreMocks.buildStickerCapabilityPolicy.mockReset();
    stickerCoreMocks.loadStickerCatalog.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('declares the chatluna service dependency', () => {
    expect(inject).toEqual(['chatluna']);
  });

  it('registers sticker policy middleware on ready', async () => {
    stickerCoreMocks.loadStickerCatalog.mockReturnValue({
      entries: [
        {
          id: 'bored',
          scopes: ['persona:sakiko'],
        },
      ],
    });
    stickerCoreMocks.buildStickerCapabilityPolicy.mockReturnValue('policy');

    const { ready, getPolicy } = createHarness();
    await ready?.();

    expect(getPolicy()).toBeTypeOf('function');
  });

  it('injects a sticker policy and stores sticker capability state on the session', async () => {
    const catalog = {
      version: 1,
      generatedAt: '2026-03-16T00:00:00.000Z',
      model: 'doubao-seed-2-0-mini-260215',
      entries: [
        {
          id: 'bored',
          file: 'images/personas/sakiko/bored.png',
          hash: 'hash-1',
          mime: 'image/png',
          scopes: ['persona:sakiko'],
          caption: '无语少女',
          keywords: ['无语'],
          moods: ['无语'],
          scenes: ['吐槽'],
          historyLabel: '无语少女',
          confidence: 0.95,
          buffer: Buffer.from('fake'),
        },
      ],
      byId: new Map(),
    };
    stickerCoreMocks.loadStickerCatalog.mockReturnValue(catalog);
    stickerCoreMocks.buildStickerCapabilityPolicy.mockReturnValue('sticker policy');

    const { ready, getPolicy, inject } = createHarness();
    await ready?.();

    const policy = getPolicy();
    const session = createSession();
    const context = {
      options: {
        room: {
          conversationId: 'conv-1',
          preset: 'sakiko',
        },
      },
    };

    const result = await policy?.(session, context);
    expect(typeof result).toBe('number');
    expect(session.state.qqSticker).toEqual({
      catalog,
      preset: 'sakiko',
      availableCount: 1,
    });
    expect(inject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'qqbot_sticker_policy',
        conversationId: 'conv-1',
        value: 'sticker policy',
      }),
    );
  });

  it('skips policy injection when no scoped sticker is available', async () => {
    const catalog = {
      version: 1,
      generatedAt: '2026-03-16T00:00:00.000Z',
      model: 'doubao-seed-2-0-mini-260215',
      entries: [
        {
          id: 'bored',
          file: 'images/personas/sakiko/bored.png',
          hash: 'hash-1',
          mime: 'image/png',
          scopes: ['persona:sakiko'],
          caption: '无语少女',
          keywords: ['无语'],
          moods: ['无语'],
          scenes: ['吐槽'],
          historyLabel: '无语少女',
          confidence: 0.95,
          buffer: Buffer.from('fake'),
        },
      ],
      byId: new Map(),
    };
    stickerCoreMocks.loadStickerCatalog.mockReturnValue(catalog);
    stickerCoreMocks.buildStickerCapabilityPolicy.mockReturnValue(null);

    const { ready, getPolicy, inject } = createHarness();
    await ready?.();

    const policy = getPolicy();
    const session = createSession();
    await policy?.(session, {
      options: {
        room: {
          conversationId: 'conv-2',
          preset: 'other',
        },
      },
    });

    expect(session.state.qqSticker).toEqual({
      catalog,
      preset: 'other',
      availableCount: 0,
    });
    expect(inject).not.toHaveBeenCalled();
  });
});
