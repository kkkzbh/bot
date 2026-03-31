import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  class MockLogger {
    info(): void {}
    warn(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
  };
});

import { apply, PRIVATE_DEFAULT_SCOPE_ID } from '../src/plugins/feature-policy/index.js';

type Row = Record<string, any>;

function matches(row: Row, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (value && typeof value === 'object' && '$in' in (value as Record<string, unknown>)) {
      return ((value as { $in: unknown[] }).$in ?? []).includes(row[key]);
    }
    return row[key] === value;
  });
}

function createDatabase(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(
    Object.entries(seed).map(([table, rows]) => [table, rows.map(row => ({ ...row }))]),
  );
  let nextOverrideId = 1;

  const ensure = (table: string): Row[] => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };

  return {
    tables,
    async get(table: string, query: Record<string, unknown>) {
      const rows = ensure(table);
      if (!query || Object.keys(query).length === 0) {
        return rows.map(row => ({ ...row }));
      }
      return rows.filter(row => matches(row, query)).map(row => ({ ...row }));
    },
    async set(table: string, query: Record<string, unknown>, data: Record<string, unknown>) {
      const rows = ensure(table);
      for (const row of rows) {
        if (matches(row, query)) Object.assign(row, data);
      }
    },
    async create(table: string, row: Record<string, unknown>) {
      const rows = ensure(table);
      const next = { ...row } as Row;
      if (table === 'feature_scope_override' && next.id == null) {
        next.id = nextOverrideId++;
      }
      rows.push(next);
      return { ...next };
    },
    async remove(table: string, query: Record<string, unknown>) {
      const rows = ensure(table);
      tables.set(table, rows.filter(row => !matches(row, query)));
    },
    async upsert(table: string, rows: Record<string, unknown>[]) {
      const current = ensure(table);
      const key = table === 'chathub_conversation' ? 'id' : 'roomId';
      for (const row of rows) {
        const existing = current.find(item => item[key] === row[key]);
        if (existing) {
          Object.assign(existing, row);
        } else {
          current.push({ ...row });
        }
      }
    },
  };
}

function createHarness(seed: Record<string, Row[]> = {}) {
  const database = createDatabase(seed);
  const extend = vi.fn();
  let clearAction: ((argv: { session?: Record<string, any> }) => Promise<string>) | null = null;
  const ctx: {
    database: ReturnType<typeof createDatabase>;
    model: { extend: ReturnType<typeof vi.fn> };
    command: ReturnType<typeof vi.fn>;
    featurePolicy: any;
  } = {
    database,
    model: { extend },
    command: vi.fn(() => ({
      action(fn: (argv: { session?: Record<string, any> }) => Promise<string>) {
        clearAction = fn;
        return this;
      },
    })),
    featurePolicy: undefined,
  };

  apply(ctx as any);

  return {
    ctx,
    database,
    extend,
    getClearAction() {
      if (!clearAction) throw new Error('clear action not registered');
      return clearAction;
    },
  };
}

describe('feature policy service', () => {
  it('registers feature policy and chathub table models', () => {
    const { extend } = createHarness();
    const tables = extend.mock.calls.map((call) => call[0]);

    expect(tables).toEqual(
      expect.arrayContaining([
        'chathub_conversation',
        'chathub_message',
        'chathub_room',
        'chathub_room_group_member',
        'chathub_user',
        'feature_scope_override',
      ]),
    );
  });

  it('resolves defaults and scoped overrides', async () => {
    const { ctx } = createHarness();
    const service = ctx.featurePolicy as NonNullable<typeof ctx.featurePolicy>;

    await service.saveFeatureOverrides([
      {
        featureKey: 'QQ_VOICE_INPUT_ENABLED',
        scopeKind: 'private_default',
        scopeId: PRIVATE_DEFAULT_SCOPE_ID,
        enabled: false,
      },
      {
        featureKey: 'QQ_VOICE_INPUT_ENABLED',
        scopeKind: 'group',
        scopeId: '10001',
        enabled: false,
      },
    ]);

    await expect(
      service.resolveFeatureEnabled(
        { isDirect: true, userId: 'u1', channelId: 'p1' } as any,
        'QQ_VOICE_INPUT_ENABLED',
      ),
    ).resolves.toBe(false);

    await expect(
      service.resolveFeatureEnabled(
        { isDirect: false, userId: 'u1', guildId: '10001', channelId: '10001' } as any,
        'QQ_VOICE_INPUT_ENABLED',
      ),
    ).resolves.toBe(false);

    await expect(
      service.resolveFeatureEnabled(
        { isDirect: true, userId: 'u1', channelId: 'p1' } as any,
        'CHAT_NATURAL_TRIGGER_ENABLED',
      ),
    ).resolves.toBe(false);
  });

  it('lists console scopes and clears conversations by room target', async () => {
    const { ctx, database } = createHarness({
      chathub_room: [
        { roomId: 1, roomName: '私聊房间', conversationId: 'conv-private', visibility: 'private', updatedTime: 10 },
        { roomId: 2, roomName: '群房间', conversationId: 'conv-group', visibility: 'template_clone', updatedTime: 20 },
      ],
      chathub_room_group_member: [{ groupId: '20002', roomId: 2 }],
      chathub_conversation: [{ id: 'conv-group', latestId: 'msg-2', updatedAt: 1 }],
      chathub_message: [
        { id: 'msg-1', conversation: 'conv-group' },
        { id: 'msg-2', conversation: 'conv-group' },
      ],
    });
    const service = ctx.featurePolicy as NonNullable<typeof ctx.featurePolicy>;

    await expect(service.listConsoleFeatureScopes()).resolves.toEqual([
      expect.objectContaining({ scopeKind: 'private_default', scopeId: PRIVATE_DEFAULT_SCOPE_ID }),
      expect.objectContaining({ scopeKind: 'group', scopeId: '20002', roomId: 2 }),
    ]);

    const targets = await service.listConversationTargets();
    expect(targets).toEqual([
      expect.objectContaining({ scopeKind: 'private', roomId: 1 }),
      expect.objectContaining({ scopeKind: 'group', roomId: 2, scopeId: '20002' }),
    ]);

    const result = await service.clearConversationHistory({
      roomId: 2,
      conversationId: 'conv-group',
    });
    expect(result.deletedMessages).toBe(2);
    await expect(database.get('chathub_message', { conversation: 'conv-group' })).resolves.toEqual([]);
    await expect(database.get('chathub_conversation', { id: 'conv-group' })).resolves.toEqual([
      expect.objectContaining({ id: 'conv-group', latestId: null }),
    ]);
  });

  it('deletes private and group rooms with related records', async () => {
    const { ctx, database } = createHarness({
      feature_scope_override: [
        {
          id: 1,
          featureKey: 'QQ_VOICE_INPUT_ENABLED',
          scopeKind: 'group',
          scopeId: '20002',
          enabled: 1,
          updatedAt: 1,
        },
      ],
      chathub_user: [
        { userId: 'u1', defaultRoomId: 1, groupId: '0' },
        { userId: 'u2', defaultRoomId: 99, groupId: '0' },
      ],
      chathub_room: [
        { roomId: 1, roomName: '私聊房间', conversationId: 'conv-private', visibility: 'private', updatedTime: 10 },
        { roomId: 2, roomName: '群房间', conversationId: 'conv-group', visibility: 'template_clone', updatedTime: 20 },
      ],
      chathub_room_group_member: [{ groupId: '20002', roomId: 2 }],
      chathub_conversation: [
        { id: 'conv-private', latestId: 'msg-private', updatedAt: 1 },
        { id: 'conv-group', latestId: 'msg-group', updatedAt: 2 },
      ],
      chathub_message: [
        { id: 'msg-private', conversation: 'conv-private' },
        { id: 'msg-group', conversation: 'conv-group' },
      ],
    });
    const service = ctx.featurePolicy as NonNullable<typeof ctx.featurePolicy>;

    await expect(service.deleteConversationRoom({ roomId: 1, conversationId: 'conv-private' })).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        roomId: 1,
        conversationId: 'conv-private',
        deletedMessages: 1,
        deletedConversation: true,
        deletedRoom: true,
        clearedDefaultUsers: 1,
      }),
    );
    await expect(database.get('chathub_room', { roomId: 1 })).resolves.toEqual([]);
    await expect(database.get('chathub_message', { conversation: 'conv-private' })).resolves.toEqual([]);
    await expect(database.get('chathub_conversation', { id: 'conv-private' })).resolves.toEqual([]);
    await expect(database.get('chathub_user', { userId: 'u1' })).resolves.toEqual([
      expect.objectContaining({ userId: 'u1', defaultRoomId: null }),
    ]);

    await expect(service.deleteConversationRoom({ roomId: 2, conversationId: 'conv-group' })).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        roomId: 2,
        conversationId: 'conv-group',
        deletedMessages: 1,
        deletedConversation: true,
        deletedRoom: true,
        clearedDefaultUsers: 0,
      }),
    );
    await expect(database.get('chathub_room', { roomId: 2 })).resolves.toEqual([]);
    await expect(database.get('chathub_room_group_member', { roomId: 2 })).resolves.toEqual([]);
    await expect(database.get('chathub_message', { conversation: 'conv-group' })).resolves.toEqual([]);
    await expect(database.get('chathub_conversation', { id: 'conv-group' })).resolves.toEqual([]);
    await expect(database.get('feature_scope_override', { id: 1 })).resolves.toEqual([
      expect.objectContaining({ id: 1, scopeId: '20002' }),
    ]);
  });

  it('rejects invalid room delete targets', async () => {
    const { ctx } = createHarness({
      chathub_room: [{ roomId: 1, roomName: '私聊房间', conversationId: 'conv-private', visibility: 'private', updatedTime: 10 }],
    });
    const service = ctx.featurePolicy as NonNullable<typeof ctx.featurePolicy>;

    await expect(service.deleteConversationRoom({ roomId: 0, conversationId: 'conv-private' })).rejects.toThrow('房间删除目标不完整');
    await expect(service.deleteConversationRoom({ roomId: 99, conversationId: 'conv-private' })).rejects.toThrow('房间 #99 不存在');
    await expect(service.deleteConversationRoom({ roomId: 1, conversationId: 'conv-other' })).rejects.toThrow('会话标识不匹配');
  });

  it('registers a private-only /clear command', async () => {
    const { getClearAction } = createHarness({
      chathub_user: [{ userId: 'u1', defaultRoomId: 11, groupId: '0' }],
      chathub_room: [{ roomId: 11, roomName: '我的私聊', conversationId: 'conv-private', visibility: 'private', updatedTime: 100 }],
      chathub_conversation: [{ id: 'conv-private', latestId: 'msg-private', updatedAt: 1 }],
      chathub_message: [{ id: 'msg-private', conversation: 'conv-private' }],
    });

    const clear = getClearAction();
    await expect(clear({ session: { isDirect: false, userId: 'u1' } as any })).resolves.toContain('只能在私聊');
    await expect(clear({ session: { isDirect: true, userId: 'u1' } as any })).resolves.toContain('已清除当前私聊会话上下文');
  });
});
