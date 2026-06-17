import { afterEach, describe, expect, it, vi } from 'vitest';
import { AffinityService, type AffinityDatabaseLike } from '../src/plugins/affinity/service.js';
import { CHARACTER_ID, getShanghaiDayKey } from '../src/plugins/affinity/rules.js';
import {
  beginPromptAssemblyTurn,
  clearPromptAssemblyTurn,
  consumePromptEnvelope,
} from '../src/plugins/shared/prompt-context/index.js';
import type { AffinityEventRecord, AffinityRandomPlanRecord, AffinityScopeConfigRecord } from '../src/types/affinity.js';

vi.mock('koishi', () => {
  class MockLogger {
    info(): void {}
    warn(): void {}
  }

  const schemaChain = new Proxy(() => schemaChain, {
    get: () => schemaChain,
    apply: () => schemaChain,
  }) as any;
  const Schema = new Proxy({}, {
    get: () => schemaChain,
  }) as any;

  return {
    Context: class {},
    Logger: MockLogger,
    Schema,
    h: {
      text: (content: string) => ({
        type: 'text',
        attrs: { content },
        toString: () => content,
      }),
    },
  };
});

vi.mock('../src/plugins/realtime-message/index.js', () => ({
  buildGroupScopeKey: vi.fn((session: any) => {
    const platform = session.platform || 'default-platform';
    const botSelfId = session.bot?.selfId || 'default-bot';
    const groupId = session.guildId || session.channelId;
    return groupId ? `${platform}:${botSelfId}:group:${groupId}` : null;
  }),
  realtimeMessageCache: {
    get: vi.fn(() => []),
  },
}));

type Row = Record<string, any>;

class MemoryDatabase implements AffinityDatabaseLike {
  readonly tables: Record<string, Row[]>;
  private nextId = 1000;

  constructor(seed: Record<string, Row[]>) {
    this.tables = Object.fromEntries(Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]));
  }

  async get(table: string, query: Record<string, unknown>): Promise<Row[]> {
    return (this.tables[table] ?? []).filter((row) => {
      for (const [key, value] of Object.entries(query)) {
        if (row[key] !== value) return false;
      }
      return true;
    });
  }

  async set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<void> {
    for (const row of await this.get(table, query)) {
      Object.assign(row, data);
    }
  }

  async create(table: string, row: Record<string, unknown>): Promise<Row> {
    const record = { ...row };
    if (record.id == null) {
      record.id = this.nextId++;
    }
    const rows = this.tables[table] ?? [];
    rows.push(record);
    this.tables[table] = rows;
    return record;
  }

  async remove(table: string, query: Record<string, unknown>): Promise<void> {
    this.tables[table] = (this.tables[table] ?? []).filter((row) => {
      for (const [key, value] of Object.entries(query)) {
        if (row[key] !== value) return true;
      }
      return false;
    });
  }
}

const NOW = Date.UTC(2026, 5, 17, 1, 0, 0);
const RANDOM_MESSAGE = '前面你们提到的图论题，我还有一点没想明白。缩点以后，为什么路径关系就能直接看 DAG 呢？';

function createScope(overrides: Partial<AffinityScopeConfigRecord> = {}): AffinityScopeConfigRecord {
  return {
    id: 1,
    characterId: CHARACTER_ID,
    scopeKind: 'group',
    scopeId: '829573670',
    enabled: 1,
    proactiveEnabled: 1,
    label: 'test group',
    platform: 'onebot',
    botSelfId: 'bot-1',
    channelId: '829573670',
    guildId: '829573670',
    conversationId: 'conv-affinity',
    updatedAt: NOW,
    ...overrides,
  };
}

function createPlan(overrides: Partial<AffinityRandomPlanRecord> = {}): AffinityRandomPlanRecord {
  return {
    id: 2,
    planKey: `${CHARACTER_ID}:group:829573670:${getShanghaiDayKey(NOW)}:0`,
    characterId: CHARACTER_ID,
    scopeKind: 'group',
    scopeId: '829573670',
    platform: 'onebot',
    botSelfId: 'bot-1',
    channelId: '829573670',
    guildId: '829573670',
    conversationId: 'conv-affinity',
    triggerKind: 'scheduled',
    dayKey: getShanghaiDayKey(NOW),
    slotIndex: 0,
    direction: 'daily_greeting',
    scheduledAt: NOW - 1,
    status: 'pending',
    messageText: null,
    skipReason: null,
    sentAt: null,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...overrides,
  };
}

function createRoom(conversationId = 'conv-affinity'): Row {
  return {
    roomId: 11,
    roomName: 'affinity-test-room',
    conversationId,
    roomMasterId: 'owner-1',
    visibility: 'template_clone',
    preset: 'sakiko',
    model: 'openai/gpt-test',
    chatMode: 'chat',
    password: null,
    autoUpdate: false,
    updatedTime: new Date(NOW),
  };
}

function createHarness(options: {
  scope?: Partial<AffinityScopeConfigRecord>;
  plan?: Partial<AffinityRandomPlanRecord>;
  randomMemories?: Row[];
  conversations?: Row[];
  messages?: Row[];
  addMessages?: ReturnType<typeof vi.fn>;
  includeRoom?: boolean;
  chat?: ReturnType<typeof vi.fn>;
  chatResponse?: { content?: unknown; additional_kwargs?: Record<string, unknown> };
  config?: Row[];
} = {}) {
  const scope = createScope(options.scope);
  const plan = createPlan({
    scopeKind: scope.scopeKind,
    scopeId: scope.scopeId,
    platform: scope.platform,
    botSelfId: scope.botSelfId,
    channelId: scope.channelId,
    guildId: scope.guildId,
    conversationId: scope.conversationId,
    ...options.plan,
  });
  const db = new MemoryDatabase({
    affinity_config: options.config ?? [],
    affinity_scope_config: [scope],
    affinity_user_state: [],
    affinity_event: [],
    affinity_random_plan: [plan],
    affinity_open_thread: [],
    affinity_random_memory: options.randomMemories ?? [],
    affinity_audit: [],
    chathub_room: options.includeRoom === false || !scope.conversationId ? [] : [createRoom(scope.conversationId)],
    chathub_conversation: options.conversations ?? [],
    chathub_message: options.messages ?? [],
  });
  const bot = {
    selfId: 'bot-1',
    platform: 'onebot',
    sendMessage: vi.fn(async () => undefined),
  };
  const addMessages = options.addMessages ?? vi.fn(async () => undefined);
  const query = vi.fn(async () => ({
    chatHistory: {
      addMessages,
    },
  }));
  const chat = options.chat ?? vi.fn(async () => options.chatResponse ?? ({
    content: JSON.stringify({
      decision: 'reply',
      outbound_messages: [{ type: 'message', content: RANDOM_MESSAGE }],
    }),
    additional_kwargs: {},
  }));
  const contextManager = {
    inject: vi.fn(),
  };
  const chatluna = {
    queryInterfaceWrapper: vi.fn(() => ({ query })),
    chat,
    contextManager,
  };
  const service = new AffinityService(db, () => [bot], () => 0.5, () => chatluna as any);
  return { db, service, bot, addMessages, query, chatluna, chat, contextManager };
}

function parseAuditDetail(row: Row | undefined): Record<string, unknown> {
  return JSON.parse(String(row?.detail ?? '{}')) as Record<string, unknown>;
}

describe('affinity service panel view', () => {
  it('builds an initial panel for a new user without writing relationship state or events', async () => {
    const { db, service } = createHarness();
    db.tables.affinity_user_state = [];
    db.tables.affinity_event = [];
    const session = {
      platform: 'onebot',
      userId: 'new-user',
      bot: { selfId: 'bot-1' },
    } as any;

    const view = await service.buildPanelView(session, NOW);

    expect(view.userKey).toBe('onebot:new-user');
    expect(view.stage).toBe('stranger');
    expect(view.recentEvents[0]).toEqual(expect.objectContaining({
      title: '尚未留下有效变化',
    }));
    expect(db.tables.affinity_user_state).toHaveLength(0);
    expect(db.tables.affinity_event).toHaveLength(0);
  });

  it('writes a successful panel command into the matching ChatLuna history as an AI message', async () => {
    const { db, service, addMessages, chatluna } = createHarness();
    const userKey = 'onebot:u-1';
    db.tables.affinity_user_state.push({
      id: 10,
      characterId: CHARACTER_ID,
      userKey,
      platform: 'onebot',
      userId: 'u-1',
      displayName: 'Alice',
      trust: 43,
      familiarity: 58,
      comfort: 36,
      tension: 18,
      mood: 'focused',
      attentionHeat: 30,
      energy: 72,
      stage: 'remembered',
      flags: null,
      unlockedScenes: null,
      dailyState: null,
      weeklyState: null,
      lastSeenAt: NOW,
      lastUpdatedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.tables.affinity_event.push({
      id: 20,
      characterId: CHARACTER_ID,
      userKey,
      scopeKind: 'group',
      scopeId: '829573670',
      platform: 'onebot',
      botSelfId: 'bot-1',
      channelId: '829573670',
      guildId: '829573670',
      conversationId: 'conv-affinity',
      messageId: 'msg-event',
      eventType: 'contest_discussion',
      effectTier: 'progress',
      route: 'affinity_candidate',
      confidence: 0.9,
      reasonCode: 'accepted',
      deltaJson: JSON.stringify({ trust: 1, familiarity: 1 }),
      beforeJson: null,
      afterJson: null,
      evidence: '不应进入面板 history 的原文',
      createdAt: NOW - 12 * 60_000,
    } satisfies AffinityEventRecord);
    const session = {
      platform: 'onebot',
      userId: 'u-1',
      guildId: '829573670',
      channelId: '829573670',
      messageId: 'msg-panel-1',
      bot: { selfId: 'bot-1' },
    } as any;

    const view = await service.buildPanelView(session, NOW);
    const result = await service.syncPanelCommandToChatHistory(session, view);

    expect(result).toEqual({ synced: true, conversationId: 'conv-affinity' });
    expect(addMessages).toHaveBeenCalledTimes(1);
    expect(chatluna.queryInterfaceWrapper).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-affinity', roomId: 11 }),
      true,
    );
    const [messages] = addMessages.mock.calls[0];
    const [message] = messages;
    expect(message.getType()).toBe('ai');
    expect(message.id).toBe('affinity-panel-command:msg-panel-1');
    expect(message.content).toContain('发送了一张好感面板');
    expect(message.content).toContain('阶段「被记住的人」');
    expect(message.content).toContain(view.fixedLine);
    expect(message.content).not.toContain('不应进入面板 history 的原文');
    expect(message.additional_kwargs.qqbot_affinity_panel_command).toEqual(expect.objectContaining({
      version: 'v1',
      characterId: CHARACTER_ID,
      userKey,
      scopeKind: 'group',
      scopeId: '829573670',
      conversationId: 'conv-affinity',
      triggerMessageId: 'msg-panel-1',
      fixedLine: view.fixedLine,
      imageAlt: '好感面板',
    }));
    const syncAudit = db.tables.affinity_audit.find((row) => row.eventType === 'panel_history_synced');
    expect(parseAuditDetail(syncAudit)).toEqual(expect.objectContaining({
      conversationId: 'conv-affinity',
      userKey,
      fixedLine: view.fixedLine,
    }));
  });

  it('records why a panel command cannot be synced when the current scope has no conversation id', async () => {
    const { db, service, addMessages } = createHarness({
      scope: { conversationId: null },
      includeRoom: false,
    });
    const session = {
      platform: 'onebot',
      userId: 'u-1',
      guildId: '829573670',
      channelId: '829573670',
      messageId: 'msg-panel-missing-conv',
      bot: { selfId: 'bot-1' },
    } as any;
    const view = await service.buildPanelView(session, NOW);

    const result = await service.syncPanelCommandToChatHistory(session, view);

    expect(result).toEqual({ synced: false, reason: 'missing_conversation_id' });
    expect(addMessages).not.toHaveBeenCalled();
    const skippedAudit = db.tables.affinity_audit.find((row) => row.eventType === 'panel_history_sync_skipped');
    expect(parseAuditDetail(skippedAudit)).toEqual(expect.objectContaining({
      reason: 'missing_conversation_id',
      fixedLine: view.fixedLine,
      triggerMessageId: 'msg-panel-missing-conv',
    }));
  });

  it('builds panel recent changes from abstract event records without evidence text', async () => {
    const { db, service } = createHarness();
    const userKey = 'onebot:u-1';
    db.tables.affinity_user_state.push({
      id: 10,
      characterId: CHARACTER_ID,
      userKey,
      platform: 'onebot',
      userId: 'u-1',
      displayName: 'Alice',
      trust: 43,
      familiarity: 58,
      comfort: 36,
      tension: 18,
      mood: 'focused',
      attentionHeat: 30,
      energy: 72,
      stage: 'remembered',
      flags: null,
      unlockedScenes: null,
      dailyState: null,
      weeklyState: null,
      lastSeenAt: NOW,
      lastUpdatedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.tables.affinity_event.push({
      id: 20,
      characterId: CHARACTER_ID,
      userKey,
      scopeKind: 'private',
      scopeId: 'u-1',
      platform: 'onebot',
      botSelfId: 'bot-1',
      channelId: 'u-1',
      guildId: null,
      conversationId: 'private-conv',
      messageId: 'msg-private',
      eventType: 'boundary_respect',
      effectTier: 'progress',
      route: 'affinity_candidate',
      confidence: 0.9,
      reasonCode: 'accepted',
      deltaJson: JSON.stringify({ comfort: 1, tension: -1 }),
      beforeJson: null,
      afterJson: null,
      evidence: '私聊原文不能出现在面板',
      createdAt: NOW - 12 * 60_000,
    } satisfies AffinityEventRecord);

    const view = await service.buildPanelView({
      platform: 'onebot',
      userId: 'u-1',
      bot: { selfId: 'bot-1' },
    } as any, NOW);

    expect(JSON.stringify(view)).not.toContain('私聊原文');
    expect(view.recentEvents[0]).toEqual(expect.objectContaining({
      time: '12分钟前',
      title: '尊重了她没有继续说的部分',
      effects: [
        { name: '安心', sign: '+' },
        { name: '紧张', sign: '-' },
      ],
    }));
  });
});

describe('affinity service random history sync', () => {
  afterEach(() => {
    clearPromptAssemblyTurn('conv-affinity');
  });

  it('sends a manual random plan for a non-whitelisted group through a temporary ChatLuna room', async () => {
    const db = new MemoryDatabase({
      affinity_config: [{
        id: 1,
        key: 'enabledDirections',
        value: JSON.stringify(['daily_greeting']),
        updatedAt: NOW,
      }],
      affinity_scope_config: [],
      affinity_user_state: [],
      affinity_event: [],
      affinity_random_plan: [],
      affinity_open_thread: [],
      affinity_random_memory: [],
      affinity_audit: [],
      chathub_room: [],
      chathub_conversation: [],
      chathub_message: [],
    });
    const bot = {
      selfId: 'bot-1',
      platform: 'onebot',
      sendMessage: vi.fn(async () => undefined),
    };
    const addMessages = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({
      chatHistory: {
        addMessages,
      },
    }));
    const chat = vi.fn(async () => ({
      content: JSON.stringify({
        decision: 'reply',
        outbound_messages: [{ type: 'message', content: RANDOM_MESSAGE }],
      }),
      additional_kwargs: {},
    }));
    const contextManager = {
      inject: vi.fn(),
    };
    const chatluna = {
      queryInterfaceWrapper: vi.fn(() => ({ query })),
      chat,
      contextManager,
    };
    const service = new AffinityService(db, () => [bot], () => 0.5, () => chatluna as any);

    const result = await service.createManualRandomPlan({
      scopeKind: 'group',
      scopeId: '1012912433',
      delayMs: 5000,
      platform: 'onebot',
      botSelfId: 'bot-1',
      channelId: '1012912433',
      guildId: '1012912433',
    }, NOW);

    expect(result).toEqual({
      ok: true,
      planId: expect.any(Number),
      scheduledAt: NOW + 5000,
      triggerKind: 'manual',
    });
    expect(db.tables.affinity_scope_config).toHaveLength(0);
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      triggerKind: 'manual',
      scopeKind: 'group',
      scopeId: '1012912433',
      status: 'pending',
      scheduledAt: NOW + 5000,
      conversationId: null,
    }));
    await expect(service.getNextPendingRandomPlanAt(NOW)).resolves.toBe(NOW + 5000);

    await service.runDueRandomPlans(NOW + 5000);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(contextManager.inject).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect((bot.sendMessage as any).mock.calls[0]?.[0]).toBe('1012912433');
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'sent',
      skipReason: null,
      messageText: RANDOM_MESSAGE,
    }));
    expect(db.tables.affinity_random_memory).toHaveLength(1);
    expect(addMessages).not.toHaveBeenCalled();
    expect(chatluna.queryInterfaceWrapper).not.toHaveBeenCalled();
    const historySkipAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_history_sync_skipped');
    expect(parseAuditDetail(historySkipAudit)).toEqual(expect.objectContaining({
      planId: result.planId,
      reason: 'missing_conversation_id',
    }));
    const sentAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_plan_sent');
    expect(parseAuditDetail(sentAudit)).toEqual(expect.objectContaining({
      planId: result.planId,
      historySynced: false,
      historySkipReason: 'missing_conversation_id',
    }));
  });

  it('lets manual plans bypass scope proactive off while scheduled plans stay blocked', async () => {
    const { db, service, bot, chat } = createHarness({
      scope: { enabled: 1, proactiveEnabled: 0 },
      config: [{
        id: 1,
        key: 'enabledDirections',
        value: JSON.stringify(['daily_greeting']),
        updatedAt: NOW,
      }],
    });

    const result = await service.createManualRandomPlan({
      scopeKind: 'group',
      scopeId: '829573670',
      delayMs: 0,
    }, NOW);

    await service.runDueRandomPlans(NOW);

    const scheduled = db.tables.affinity_random_plan.find((row) => row.id === 2);
    const manual = db.tables.affinity_random_plan.find((row) => row.id === result.planId);
    expect(scheduled).toEqual(expect.objectContaining({
      triggerKind: 'scheduled',
      status: 'skipped',
      skipReason: 'scope_disabled',
    }));
    expect(manual).toEqual(expect.objectContaining({
      triggerKind: 'manual',
      status: 'sent',
      messageText: RANDOM_MESSAGE,
    }));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('writes a sent proactive random event into the matching ChatLuna history as an AI message', async () => {
    const { db, service, bot, addMessages, chatluna, chat } = createHarness();

    await service.runDueRandomPlans(NOW);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.tables.affinity_random_plan[0].status).toBe('sent');
    expect(db.tables.affinity_random_plan[0].messageText).toBe(RANDOM_MESSAGE);
    expect(db.tables.affinity_random_memory).toHaveLength(1);
    expect(db.tables.affinity_random_memory[0]).toEqual(expect.objectContaining({
      sourcePlanId: 2,
      direction: 'daily_greeting',
      messageText: RANDOM_MESSAGE,
      contextSummary: '最近没有可用群聊上下文。',
    }));
    expect(addMessages).toHaveBeenCalledTimes(1);
    expect(chatluna.queryInterfaceWrapper).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-affinity', roomId: 11 }),
      true,
    );

    const [messages] = addMessages.mock.calls[0];
    const [message] = messages;
    expect(message.getType()).toBe('ai');
    expect(message.content).toContain('"decision":"reply"');
    expect(message.content).toContain(RANDOM_MESSAGE);
    expect(message.id).toBe('affinity-random-plan:2');
    expect(message.additional_kwargs.qqbot_affinity_random_event).toEqual(expect.objectContaining({
      version: 'v1',
      characterId: CHARACTER_ID,
      planId: 2,
      direction: 'daily_greeting',
      scopeKind: 'group',
      scopeId: '829573670',
      contextSeedSummary: '最近没有可用群聊上下文。',
      eventTypeHint: 'greeting_contextual',
    }));

    const syncAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_history_synced');
    expect(parseAuditDetail(syncAudit)).toEqual(expect.objectContaining({
      planId: 2,
      direction: 'daily_greeting',
      conversationId: 'conv-affinity',
    }));
    const sentAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_plan_sent');
    expect(parseAuditDetail(sentAudit)).toEqual(expect.objectContaining({
      historySynced: true,
      conversationId: 'conv-affinity',
    }));
  });

  it('keeps the random plan sent when ChatLuna history writing fails', async () => {
    const addMessages = vi.fn(async () => {
      throw new Error('history down');
    });
    const { db, service, bot } = createHarness({ addMessages });

    await service.runDueRandomPlans(NOW);

    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.tables.affinity_random_plan[0].status).toBe('sent');
    expect(db.tables.affinity_random_plan[0].skipReason).toBeNull();
    const skippedAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_history_sync_skipped');
    expect(parseAuditDetail(skippedAudit)).toEqual(expect.objectContaining({
      reason: 'write_failed',
      error: 'history down',
      conversationId: 'conv-affinity',
    }));
    const sentAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_plan_sent');
    expect(parseAuditDetail(sentAudit)).toEqual(expect.objectContaining({
      historySynced: false,
      historySkipReason: 'write_failed',
    }));
  });

  it('skips proactive generation instead of text fallback when the scope has no conversation id', async () => {
    const { db, service, bot, addMessages, chatluna } = createHarness({
      scope: { conversationId: null },
      plan: { conversationId: null },
    });

    await service.runDueRandomPlans(NOW);

    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'skipped',
      skipReason: 'missing_conversation_id',
      messageText: null,
    }));
    expect(addMessages).not.toHaveBeenCalled();
    expect(chatluna.queryInterfaceWrapper).not.toHaveBeenCalled();
    const skippedAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_message_generation_skipped');
    expect(parseAuditDetail(skippedAudit)).toEqual(expect.objectContaining({
      reason: 'missing_conversation_id',
      planId: 2,
    }));
  });

  it('skips the proactive plan instead of falling back to a fixed sentence when generation declines', async () => {
    const { db, service, bot, addMessages, chat } = createHarness({
      chatResponse: {
        content: JSON.stringify({
          decision: 'no_reply',
          outbound_messages: null,
        }),
        additional_kwargs: {},
      },
    });

    await service.runDueRandomPlans(NOW);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(addMessages).not.toHaveBeenCalled();
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'skipped',
      skipReason: 'provider_no_reply',
    }));
    expect(db.tables.affinity_random_memory).toHaveLength(0);
    const audit = db.tables.affinity_audit.find((row) => row.eventType === 'random_message_generation_skipped');
    expect(parseAuditDetail(audit)).toEqual(expect.objectContaining({
      planId: 2,
      reason: 'provider_no_reply',
    }));
  });

  it('passes timestamped local random memories and reply summaries into the proactive task prompt', async () => {
    const memoryCreatedAt = NOW - 24 * 60 * 60 * 1000;
    const replyAt = NOW - 10 * 60 * 1000;
    const { service, contextManager } = createHarness({
      randomMemories: [
        {
          id: 77,
          characterId: CHARACTER_ID,
          scopeKind: 'group',
          scopeId: '829573670',
          direction: 'contest_discussion',
          sourcePlanId: 55,
          messageText: '昨天那道缩点题，我还是有一点在意。',
          contextSummary: 'SCC 缩点讨论',
          materialJson: null,
          responseSummary: JSON.stringify([
            {
              at: replyAt,
              speaker: 'Alice',
              summary: '说可以先画出 SCC 缩点后的 DAG。',
            },
          ]),
          responderNames: JSON.stringify(['Alice']),
          createdAt: memoryCreatedAt,
          lastResponseAt: replyAt,
          expiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
          updatedAt: replyAt,
        },
      ],
    });

    await service.runDueRandomPlans(NOW);

    const injectedMessages = contextManager.inject.mock.calls[0]?.[0]?.value as Array<{ content: string }>;
    const injectedText = injectedMessages.map((message) => message.content).join('\n\n');
    expect(injectedText).toContain('昨天那道缩点题，我还是有一点在意。');
    expect(injectedText).toContain('2026-06-16 09:00:00 +08:00，1天前');
    expect(injectedText).toContain('2026-06-17 08:50:00 +08:00，10分钟前');
    expect(injectedText).toContain('Alice（2026-06-17 08:50:00 +08:00，10分钟前）：说可以先画出 SCC 缩点后的 DAG。');
    expect(injectedText).not.toContain(String(memoryCreatedAt));
    expect(injectedText).not.toContain(String(replyAt));
  });

  it('uses real ChatLuna history context through the main reply chain to generate a declarative proactive continuation', async () => {
    const declarativeMessage = '前面那道缩点题，我想了一下。只要缩完以后还能绕回去，那几个点原本就应该属于同一个强连通分量。';
    const { db, service, bot, addMessages, chat, contextManager } = createHarness({
      plan: { direction: 'local_thread' },
      chatResponse: {
        content: JSON.stringify({
          decision: 'reply',
          outbound_messages: [
            {
              type: 'message',
              content: declarativeMessage,
            },
          ],
        }),
        additional_kwargs: {},
      },
      conversations: [{ id: 'conv-affinity', latestId: 'msg-bob', updatedAt: NOW }],
      messages: [
        {
          id: 'msg-alice',
          role: 'human',
          conversation: 'conv-affinity',
          parent: null,
          text: '[speaker_id=u1 speaker_name="Alice"] SCC 缩点以后为什么一定没有环？',
          content: null,
        },
        {
          id: 'msg-bob',
          role: 'human',
          conversation: 'conv-affinity',
          parent: 'msg-alice',
          text: '[speaker_id=u2 speaker_name="Bob"] 因为有环会被缩在一个点里吧，但我不确定。',
          content: null,
        },
      ],
    });

    await service.runDueRandomPlans(NOW);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(contextManager.inject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'qqbot_affinity_proactive_prompt_envelope',
      stage: 'after_scratchpad',
      value: expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('qqbot_affinity_proactive_task'),
        }),
      ]),
    }));
    const injectedMessages = contextManager.inject.mock.calls[0]?.[0]?.value as Array<{ content: string }>;
    const injectedText = injectedMessages.map((message) => message.content).join('\n\n');
    expect(injectedText).toContain('# 主动发言任务：承接未完话题');
    expect(injectedText).toContain('Alice');
    expect(injectedText).toContain('SCC 缩点以后为什么一定没有环？');
    expect(injectedText).toContain('Bob');
    expect(injectedText).toContain('因为有环会被缩在一个点里吧，但我不确定。');
    expect(injectedText).not.toContain('你是丰川祥子');
    expect(injectedText).not.toContain('"shouldSend"');
    expect(declarativeMessage).not.toMatch(/[?？]/u);
    expect(bot.sendMessage).toHaveBeenCalledWith(
      '829573670',
      expect.objectContaining({ attrs: { content: declarativeMessage } }),
      undefined,
      expect.objectContaining({
        session: expect.objectContaining({
          guildId: '829573670',
          channelId: '829573670',
        }),
      }),
    );
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'sent',
      messageText: declarativeMessage,
    }));
    expect(db.tables.affinity_open_thread[0]).toEqual(expect.objectContaining({
      title: 'random:local_thread',
      summary: declarativeMessage,
    }));
    const [messages] = addMessages.mock.calls[0];
    expect(messages[0].content).toContain('"decision":"reply"');
    expect(messages[0].content).toContain(declarativeMessage);
    expect(messages[0].additional_kwargs.qqbot_affinity_random_event).toEqual(expect.objectContaining({
      visibleText: declarativeMessage,
      eventTypeHint: 'answer_random_prompt',
    }));
  });

  it('skips a local_thread plan when the main reply chain returns no_reply', async () => {
    const { db, service, bot, chat } = createHarness({
      plan: { direction: 'local_thread' },
      chatResponse: {
        content: JSON.stringify({
          decision: 'no_reply',
          outbound_messages: null,
        }),
        additional_kwargs: {},
      },
      conversations: [{ id: 'conv-affinity', latestId: 'msg-alice', updatedAt: NOW }],
      messages: [
        {
          id: 'msg-alice',
          role: 'human',
          conversation: 'conv-affinity',
          parent: null,
          text: '[speaker_id=u1 speaker_name="Alice"] 我去吃饭了，晚点再说。',
          content: null,
        },
      ],
    });

    await service.runDueRandomPlans(NOW);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(db.tables.affinity_random_plan[0]).toEqual(expect.objectContaining({
      status: 'skipped',
      skipReason: 'provider_no_reply',
      messageText: null,
    }));
    expect(db.tables.affinity_open_thread).toHaveLength(0);
    expect(db.tables.affinity_random_memory).toHaveLength(0);
    const skipAudit = db.tables.affinity_audit.find((row) => row.eventType === 'random_message_generation_skipped');
    expect(parseAuditDetail(skipAudit)).toEqual(expect.objectContaining({
      direction: 'local_thread',
      reason: 'provider_no_reply',
    }));
  });

  it('records user replies to an open random event into local random memory', async () => {
    const { db, service } = createHarness();
    await service.runDueRandomPlans(NOW);
    db.tables.affinity_open_thread[0].expiresAt = Date.now() + 3_600_000;

    const result = await service.processIncomingSession({
      isDirect: false,
      platform: 'onebot',
      guildId: '829573670',
      channelId: '829573670',
      userId: 'u-1',
      messageId: 'reply-1',
      content: '这个算法是不是缩点以后再拓扑排序？',
      stripped: { content: '这个算法是不是缩点以后再拓扑排序？' },
      author: { nick: 'Alice' },
      bot: { selfId: 'bot-1' },
    } as any);

    expect(result?.analysis).toEqual(expect.objectContaining({
      route: 'random_event_reply',
      eventType: 'answer_random_prompt',
    }));

    const memory = db.tables.affinity_random_memory[0];
    expect(JSON.parse(memory.responderNames)).toContain('Alice');
    const responses = JSON.parse(memory.responseSummary);
    expect(responses[0]).toEqual(expect.objectContaining({
      at: expect.any(Number),
      speaker: 'Alice',
      summary: expect.stringContaining('缩点'),
    }));
    expect(memory.lastResponseAt).toEqual(responses[0].at);
    const audit = db.tables.affinity_audit.find((row) => row.eventType === 'random_memory_updated');
    expect(parseAuditDetail(audit)).toEqual(expect.objectContaining({
      planId: 2,
      speaker: 'Alice',
      eventType: 'answer_random_prompt',
    }));
  });

  it('injects active proactive thread context into the next ChatLuna turn after a user reply', async () => {
    const { db, service } = createHarness();
    await service.runDueRandomPlans(NOW);
    db.tables.affinity_open_thread[0].expiresAt = Date.now() + 3_600_000;
    const session = {
      isDirect: false,
      platform: 'onebot',
      guildId: '829573670',
      channelId: '829573670',
      userId: 'u-1',
      messageId: 'reply-1',
      content: '这个算法是不是缩点以后再拓扑排序？',
      stripped: { content: '这个算法是不是缩点以后再拓扑排序？' },
      author: { nick: 'Alice' },
      bot: { selfId: 'bot-1' },
    } as any;
    await service.processIncomingSession(session);

    beginPromptAssemblyTurn('conv-affinity');
    await service.injectPromptForTurn('conv-affinity', session);
    const envelope = consumePromptEnvelope('conv-affinity');
    const content = envelope?.fragments
      .find((fragment) => fragment.source === 'qqbot_affinity')
      ?.content ?? '';

    expect(content).toContain('activeRandomThreads');
    expect(content).toContain('random:daily_greeting');
    expect(content).toContain(RANDOM_MESSAGE);
    expect(content).toContain('contextSeedSummary');
    expect(content).toContain('answer_random_prompt');
    expect(content).toContain('eventResult');
  });
});
