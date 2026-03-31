import { Context, Logger, type Session } from 'koishi';
import type {
  ClearConversationHistoryResult,
  ClearConversationHistoryTarget,
  ConsoleFeatureScope,
  ConversationTarget,
  DeleteConversationRoomResult,
  DeleteConversationRoomTarget,
  FeatureOverrideInput,
  FeaturePolicyServiceLike,
  FeatureScopeKind,
  FeatureScopeOverrideRecord,
  ScopedFeatureKey,
} from '../../types/feature-policy.js';

export const name = 'feature-policy';
export const inject = ['database'];

const logger = new Logger(name);

export const SCOPED_FEATURE_KEYS = [
  'QQ_VOICE_INPUT_ENABLED',
  'QQ_VOICE_OUTPUT_ENABLED',
  'CHAT_NATURAL_TRIGGER_ENABLED',
  'TASK_AUTOMATION_INTENT_ENABLED',
  'QQBOT_REPLY_INTERRUPT_ENABLED',
] as const satisfies readonly ScopedFeatureKey[];

export const PRIVATE_DEFAULT_SCOPE_ID = 'private-default';

function registerChatHubTableModels(model: { extend?: (...args: any[]) => unknown } | undefined): void {
  if (typeof model?.extend !== 'function') return;

  model.extend(
    'chathub_conversation',
    {
      id: { type: 'char', length: 255 },
      latestId: { type: 'char', length: 255, nullable: true },
      additional_kwargs: { type: 'text', nullable: true },
      updatedAt: { type: 'timestamp', nullable: false, initial: new Date() },
    },
    {
      autoInc: false,
      primary: 'id',
      unique: ['id'],
    },
  );

  model.extend(
    'chathub_message',
    {
      id: { type: 'char', length: 255 },
      text: { type: 'text', nullable: true },
      content: { type: 'binary', nullable: true },
      parent: { type: 'char', length: 255, nullable: true },
      role: { type: 'char', length: 20 },
      conversation: { type: 'char', length: 255 },
      additional_kwargs: { type: 'text', nullable: true },
      additional_kwargs_binary: { type: 'binary', nullable: true },
      tool_call_id: 'string',
      tool_calls: 'json',
      name: { type: 'char', length: 255, nullable: true },
      rawId: { type: 'char', length: 255, nullable: true },
    },
    {
      autoInc: false,
      primary: 'id',
      unique: ['id'],
    },
  );

  model.extend(
    'chathub_room',
    {
      roomId: { type: 'integer' },
      roomName: 'string',
      conversationId: { type: 'char', length: 255, nullable: true },
      roomMasterId: { type: 'char', length: 255 },
      visibility: { type: 'char', length: 20 },
      preset: { type: 'char', length: 255 },
      model: { type: 'char', length: 100 },
      chatMode: { type: 'char', length: 20 },
      password: { type: 'char', length: 100 },
      autoUpdate: { type: 'boolean', initial: false },
      updatedTime: { type: 'timestamp', nullable: false, initial: new Date() },
    },
    {
      autoInc: false,
      primary: 'roomId',
      unique: ['roomId'],
    },
  );

  model.extend(
    'chathub_room_group_member',
    {
      groupId: { type: 'char', length: 255 },
      roomId: { type: 'integer' },
      roomVisibility: { type: 'char', length: 20 },
    },
    {
      autoInc: false,
      primary: ['groupId', 'roomId'],
    },
  );

  model.extend(
    'chathub_user',
    {
      userId: { type: 'char', length: 255 },
      defaultRoomId: { type: 'integer' },
      groupId: { type: 'char', length: 255, nullable: true },
    },
    {
      autoInc: false,
      primary: ['userId', 'groupId'],
    },
  );
}

type RoomRow = {
  roomId?: number | string | null;
  roomName?: string | null;
  conversationId?: string | null;
  visibility?: string | null;
  updatedTime?: number | string | null;
};

type RoomGroupMemberRow = {
  groupId?: string | null;
  roomId?: number | string | null;
};

type ChathubUserRow = {
  userId?: string | null;
  defaultRoomId?: number | string | null;
  groupId?: string | null;
};

type ChathubConversationRow = {
  id?: string | null;
  latestId?: string | null;
  additional_kwargs?: string | null;
  updatedAt?: number | string | null;
};

type ChathubMessageRow = {
  id?: string | null;
};

type DatabaseLike = {
  get(table: string, query: Record<string, unknown>): Promise<any[]>;
  set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown>;
  create(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
  upsert(table: string, rows: Record<string, unknown>[], keys?: string[]): Promise<unknown>;
};

function isScopedFeatureKey(value: string): value is ScopedFeatureKey {
  return (SCOPED_FEATURE_KEYS as readonly string[]).includes(value);
}

function toNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositiveInteger(value: unknown): number | null {
  const parsed = toNumber(value);
  if (parsed == null || parsed < 1) return null;
  return Math.floor(parsed);
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeBoolean(value: unknown, fallback = true): boolean {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return fallback;
  return raw !== 'false';
}

function defaultFeatureEnabled(featureKey: ScopedFeatureKey): boolean {
  switch (featureKey) {
    case 'QQBOT_REPLY_INTERRUPT_ENABLED':
      return normalizeBoolean(process.env.QQBOT_REPLY_INTERRUPT_ENABLED, false);
    case 'QQ_VOICE_INPUT_ENABLED':
      return normalizeBoolean(process.env.QQ_VOICE_INPUT_ENABLED, true);
    case 'QQ_VOICE_OUTPUT_ENABLED':
      return normalizeBoolean(process.env.QQ_VOICE_OUTPUT_ENABLED, true);
    case 'CHAT_NATURAL_TRIGGER_ENABLED':
      return normalizeBoolean(process.env.CHAT_NATURAL_TRIGGER_ENABLED, true);
    case 'TASK_AUTOMATION_INTENT_ENABLED':
      return normalizeBoolean(process.env.TASK_AUTOMATION_INTENT_ENABLED, true);
    default:
      return true;
  }
}

function normalizeGroupScopeId(session: Session): string | null {
  const groupId = normalizeText(session.guildId) || normalizeText(session.channelId);
  return groupId || null;
}

function formatRoomName(room: Pick<RoomRow, 'roomName' | 'roomId' | 'visibility'>, fallbackPrefix: string): string {
  const name = normalizeText(room.roomName);
  if (name) return name;
  const roomId = toPositiveInteger(room.roomId);
  return roomId ? `${fallbackPrefix} #${roomId}` : fallbackPrefix;
}

function validateScopeKind(value: string): asserts value is FeatureScopeKind {
  if (value !== 'private_default' && value !== 'group') {
    throw new Error(`不支持这个作用域类型：${value}`);
  }
}

function validateOverrideInput(input: FeatureOverrideInput): FeatureOverrideInput {
  const featureKey = normalizeText(input.featureKey);
  const scopeKind = normalizeText(input.scopeKind);
  const scopeId = normalizeText(input.scopeId);
  if (!isScopedFeatureKey(featureKey)) {
    throw new Error(`不支持这个功能项：${featureKey}`);
  }
  validateScopeKind(scopeKind);
  if (!scopeId) {
    throw new Error('作用域标识不能为空。');
  }
  if (scopeKind === 'private_default' && featureKey === 'CHAT_NATURAL_TRIGGER_ENABLED') {
    throw new Error('群聊自然触发不支持私聊默认作用域。');
  }

  return {
    featureKey,
    scopeKind,
    scopeId,
    enabled: Boolean(input.enabled),
  };
}

class FeaturePolicyService implements FeaturePolicyServiceLike {
  constructor(private readonly database: DatabaseLike) {}

  async resolveFeatureEnabled(session: Session, featureKey: ScopedFeatureKey): Promise<boolean> {
    if (!isScopedFeatureKey(featureKey)) {
      throw new Error(`不支持这个功能项：${featureKey}`);
    }

    const defaultEnabled = defaultFeatureEnabled(featureKey);
    if (session.isDirect) {
      if (featureKey === 'CHAT_NATURAL_TRIGGER_ENABLED') return false;
      const override = await this.getOverride(featureKey, 'private_default', PRIVATE_DEFAULT_SCOPE_ID);
      return override ?? defaultEnabled;
    }

    const groupScopeId = normalizeGroupScopeId(session);
    if (!groupScopeId) return defaultEnabled;
    const override = await this.getOverride(featureKey, 'group', groupScopeId);
    return override ?? defaultEnabled;
  }

  async listConsoleFeatureScopes(): Promise<ConsoleFeatureScope[]> {
    const [rooms, groupMembers] = await Promise.all([
      this.database.get('chathub_room', {} as Record<string, never>) as Promise<RoomRow[]>,
      this.database.get('chathub_room_group_member', {} as Record<string, never>) as Promise<RoomGroupMemberRow[]>,
    ]);

    const roomById = new Map<number, RoomRow>();
    for (const room of rooms) {
      const roomId = toPositiveInteger(room.roomId);
      if (roomId == null) continue;
      roomById.set(roomId, room);
    }

    const groupScopes = new Map<string, ConsoleFeatureScope>();
    for (const member of groupMembers) {
      const groupId = normalizeText(member.groupId);
      const roomId = toPositiveInteger(member.roomId);
      if (!groupId || roomId == null) continue;
      const room = roomById.get(roomId);
      if (!room) continue;

      const candidate: ConsoleFeatureScope = {
        scopeKind: 'group',
        scopeId: groupId,
        roomId,
        roomName: formatRoomName(room, '群房间'),
        groupId,
        conversationId: normalizeText(room.conversationId) || null,
        visibility: normalizeText(room.visibility) || null,
        updatedAt: toNumber(room.updatedTime),
      };
      const existing = groupScopes.get(groupId);
      if (!existing || (candidate.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        groupScopes.set(groupId, candidate);
      }
    }

    return [
      {
        scopeKind: 'private_default',
        scopeId: PRIVATE_DEFAULT_SCOPE_ID,
        roomId: null,
        roomName: '所有私聊',
        groupId: null,
        conversationId: null,
        visibility: 'private',
        updatedAt: null,
      },
      ...[...groupScopes.values()].sort((left, right) => {
        const timeDelta = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
        if (timeDelta !== 0) return timeDelta;
        return left.scopeId.localeCompare(right.scopeId, 'zh-CN');
      }),
    ];
  }

  async listConversationTargets(): Promise<ConversationTarget[]> {
    const [rooms, groupMembers] = await Promise.all([
      this.database.get('chathub_room', {} as Record<string, never>) as Promise<RoomRow[]>,
      this.database.get('chathub_room_group_member', {} as Record<string, never>) as Promise<RoomGroupMemberRow[]>,
    ]);

    const roomById = new Map<number, RoomRow>();
    for (const room of rooms) {
      const roomId = toPositiveInteger(room.roomId);
      if (roomId == null) continue;
      roomById.set(roomId, room);
    }

    const privateTargets: ConversationTarget[] = [];
    for (const room of rooms) {
      const roomId = toPositiveInteger(room.roomId);
      const conversationId = normalizeText(room.conversationId);
      if (roomId == null || !conversationId || normalizeText(room.visibility) !== 'private') continue;
      privateTargets.push({
        roomId,
        roomName: formatRoomName(room, '私聊房间'),
        scopeKind: 'private',
        scopeId: String(roomId),
        groupId: null,
        conversationId,
        updatedAt: toNumber(room.updatedTime),
      });
    }

    const groupTargets = new Map<string, ConversationTarget>();
    for (const member of groupMembers) {
      const groupId = normalizeText(member.groupId);
      const roomId = toPositiveInteger(member.roomId);
      if (!groupId || roomId == null) continue;
      const room = roomById.get(roomId);
      if (!room) continue;
      const conversationId = normalizeText(room.conversationId);
      if (!conversationId) continue;

      const candidate: ConversationTarget = {
        roomId,
        roomName: formatRoomName(room, '群房间'),
        scopeKind: 'group',
        scopeId: groupId,
        groupId,
        conversationId,
        updatedAt: toNumber(room.updatedTime),
      };
      const existing = groupTargets.get(groupId);
      if (!existing || (candidate.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        groupTargets.set(groupId, candidate);
      }
    }

    return [
      ...privateTargets.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)),
      ...[...groupTargets.values()].sort((left, right) => {
        const timeDelta = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
        if (timeDelta !== 0) return timeDelta;
        return left.scopeId.localeCompare(right.scopeId, 'zh-CN');
      }),
    ];
  }

  async getFeatureOverrides(): Promise<FeatureScopeOverrideRecord[]> {
    const rows = (await this.database.get('feature_scope_override', {} as Record<string, never>)) as FeatureScopeOverrideRecord[];
    return rows
      .filter((row) => isScopedFeatureKey(normalizeText(row.featureKey)))
      .sort((left, right) => {
        const scopeDelta = `${left.scopeKind}:${left.scopeId}`.localeCompare(`${right.scopeKind}:${right.scopeId}`, 'zh-CN');
        if (scopeDelta !== 0) return scopeDelta;
        return left.featureKey.localeCompare(right.featureKey, 'zh-CN');
      });
  }

  async saveFeatureOverrides(overrides: FeatureOverrideInput[]): Promise<FeatureScopeOverrideRecord[]> {
    const normalized = overrides.map(validateOverrideInput);
    const desired = new Map<string, FeatureOverrideInput>();
    for (const item of normalized) {
      desired.set(this.buildKey(item.featureKey, item.scopeKind, item.scopeId), item);
    }

    const existing = await this.getFeatureOverrides();
    const existingByKey = new Map(existing.map((row) => [this.buildKey(row.featureKey, row.scopeKind, row.scopeId), row]));
    const now = Date.now();

    for (const row of existing) {
      const key = this.buildKey(row.featureKey, row.scopeKind, row.scopeId);
      if (!desired.has(key)) {
        await this.database.remove('feature_scope_override', { id: row.id });
      }
    }

    for (const item of desired.values()) {
      const key = this.buildKey(item.featureKey, item.scopeKind, item.scopeId);
      const row = existingByKey.get(key);
      const patch = {
        featureKey: item.featureKey,
        scopeKind: item.scopeKind,
        scopeId: item.scopeId,
        enabled: item.enabled ? 1 : 0,
        updatedAt: now,
      };
      if (row?.id) {
        await this.database.set('feature_scope_override', { id: row.id }, patch);
      } else {
        await this.database.create('feature_scope_override', patch);
      }
    }

    return this.getFeatureOverrides();
  }

  async clearConversationHistory(target: ClearConversationHistoryTarget): Promise<ClearConversationHistoryResult> {
    const roomId = toPositiveInteger(target.roomId);
    const conversationId = normalizeText(target.conversationId);
    if (roomId == null || !conversationId) {
      throw new Error('会话清理目标不完整。');
    }

    const [messages, conversations] = await Promise.all([
      this.database.get('chathub_message', { conversation: conversationId }) as Promise<ChathubMessageRow[]>,
      this.database.get('chathub_conversation', { id: conversationId }) as Promise<ChathubConversationRow[]>,
    ]);

    const updatedAt = Date.now();
    await this.database.remove('chathub_message', { conversation: conversationId });
    await this.database.upsert('chathub_conversation', [
      {
        ...(conversations[0] ?? { id: conversationId }),
        id: conversationId,
        latestId: null,
        updatedAt,
      },
    ]);

    return {
      ok: true,
      roomId,
      conversationId,
      deletedMessages: messages.length,
      updatedAt,
    };
  }

  async deleteConversationRoom(target: DeleteConversationRoomTarget): Promise<DeleteConversationRoomResult> {
    const roomId = toPositiveInteger(target.roomId);
    const conversationId = normalizeText(target.conversationId);
    if (roomId == null || !conversationId) {
      throw new Error('房间删除目标不完整。');
    }

    const [rooms, messages, conversations, users] = await Promise.all([
      this.database.get('chathub_room', { roomId }) as Promise<RoomRow[]>,
      this.database.get('chathub_message', { conversation: conversationId }) as Promise<ChathubMessageRow[]>,
      this.database.get('chathub_conversation', { id: conversationId }) as Promise<ChathubConversationRow[]>,
      this.database.get('chathub_user', { defaultRoomId: roomId }) as Promise<ChathubUserRow[]>,
    ]);

    const room = rooms[0];
    if (!room) {
      throw new Error(`房间 #${roomId} 不存在。`);
    }

    const roomConversationId = normalizeText(room.conversationId);
    if (!roomConversationId || roomConversationId !== conversationId) {
      throw new Error(`房间 #${roomId} 的会话标识不匹配。`);
    }

    const isPrivateRoom = normalizeText(room.visibility) === 'private';
    const updatedAt = Date.now();

    await Promise.all([
      this.database.remove('chathub_room_group_member', { roomId }),
      this.database.remove('chathub_message', { conversation: conversationId }),
      this.database.remove('chathub_conversation', { id: conversationId }),
      this.database.remove('chathub_room', { roomId }),
      isPrivateRoom && users.length > 0
        ? this.database.set('chathub_user', { defaultRoomId: roomId }, { defaultRoomId: null, updatedAt })
        : Promise.resolve(undefined),
    ]);

    return {
      ok: true,
      roomId,
      conversationId,
      deletedMessages: messages.length,
      deletedConversation: conversations.length > 0,
      deletedRoom: true,
      clearedDefaultUsers: isPrivateRoom ? users.length : 0,
      updatedAt,
    };
  }

  async resolvePrivateConversationTarget(session: Session): Promise<ConversationTarget | null> {
    if (!session.isDirect) return null;
    const userId = normalizeText(session.userId);
    if (!userId) return null;

    const rows = (await this.database.get('chathub_user', {
      userId,
      groupId: '0',
    })) as ChathubUserRow[];
    const defaultRoomId = toPositiveInteger(rows[0]?.defaultRoomId);
    if (defaultRoomId == null) return null;

    const rooms = (await this.database.get('chathub_room', { roomId: defaultRoomId })) as RoomRow[];
    const room = rooms[0];
    if (!room) return null;
    const conversationId = normalizeText(room.conversationId);
    if (!conversationId) return null;

    return {
      roomId: defaultRoomId,
      roomName: formatRoomName(room, '私聊房间'),
      scopeKind: 'private',
      scopeId: String(defaultRoomId),
      groupId: null,
      conversationId,
      updatedAt: toNumber(room.updatedTime),
    };
  }

  private async getOverride(
    featureKey: ScopedFeatureKey,
    scopeKind: FeatureScopeKind,
    scopeId: string,
  ): Promise<boolean | null> {
    const rows = (await this.database.get('feature_scope_override', {
      featureKey,
      scopeKind,
      scopeId,
    })) as FeatureScopeOverrideRecord[];
    const row = rows[0];
    if (!row?.id) return null;
    return Number(row.enabled ?? 0) === 1;
  }

  private buildKey(featureKey: ScopedFeatureKey, scopeKind: FeatureScopeKind, scopeId: string): string {
    return `${featureKey}:${scopeKind}:${scopeId}`;
  }
}

export function apply(ctx: Context): void {
  const database = (ctx as { database?: DatabaseLike }).database;
  if (!database) {
    logger.warn('database service is unavailable, skip feature policy setup.');
    return;
  }

  const model = (ctx as { model?: { extend?: (...args: any[]) => unknown } }).model;
  if (typeof model?.extend === 'function') {
    registerChatHubTableModels(model);
    model.extend(
      'feature_scope_override',
      {
        id: 'unsigned',
        featureKey: 'string',
        scopeKind: 'string',
        scopeId: 'string',
        enabled: 'unsigned',
        updatedAt: 'double',
      },
      {
        autoInc: true,
        indexes: [['featureKey', 'scopeKind', 'scopeId'], ['scopeKind', 'scopeId']],
      },
    );
  }

  const service = new FeaturePolicyService(database);
  const serviceCtx = ctx as Context & {
    provide?: (name: string) => void;
    set?: (name: string, value: unknown) => void;
    featurePolicy?: FeaturePolicyServiceLike;
  };
  if (typeof serviceCtx.provide === 'function' && typeof serviceCtx.set === 'function') {
    serviceCtx.provide('featurePolicy');
    serviceCtx.set('featurePolicy', service);
  } else {
    serviceCtx.featurePolicy = service;
  }

  ctx.command('clear', '清除当前私聊会话上下文').action(async ({ session }) => {
    if (!session?.isDirect) {
      return '这个命令只能在私聊里使用。';
    }

    const target = await service.resolvePrivateConversationTarget(session);
    if (!target) {
      return '当前没有可清除的私聊会话上下文。';
    }

    const result = await service.clearConversationHistory({
      roomId: target.roomId,
      conversationId: target.conversationId,
    });
    return `已清除当前私聊会话上下文，共删除 ${result.deletedMessages} 条消息。`;
  });

  logger.info('feature policy service registered.');
}
