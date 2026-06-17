import { Context, Logger, Schema, type Session } from 'koishi';
import type { AffinityServiceLike } from '../../types/affinity.js';
import { AffinityService, getSessionAffinityResult, type AffinityDatabaseLike } from './service.js';
import { AffinityRandomPlanScheduler } from './scheduler.js';
export {
  AffinityService,
  affinityMutationResponse,
  createUnavailableAffinityState,
  getSessionAffinityResult,
  setSessionAffinityResult,
} from './service.js';
export {
  createRandomScheduleTimes,
  resolveAffinityEvent,
  resolveAnalysisModelConfig,
  selectRandomCount,
} from './public.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { CONTINUE: number };
};

export const name = 'affinity';
export const inject = { required: ['database'], optional: ['chatluna'] } as const;

const logger = new Logger(name);
const allowReplyResolverName = 'qqbot-affinity';

export interface Config {
  enabled?: boolean;
  proactiveEnabled?: boolean;
  pollIntervalMs?: number;
  randomWindowStartHour?: number;
  randomWindowEndHour?: number;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().description('是否启用关系事件系统。'),
  proactiveEnabled: Schema.boolean().description('是否启用主动随机事件。'),
  pollIntervalMs: Schema.natural().role('time').description('主动随机事件轮询周期（毫秒）。'),
  randomWindowStartHour: Schema.natural().description('主动随机事件每日开始小时。'),
  randomWindowEndHour: Schema.natural().description('主动随机事件每日结束小时。'),
});

type ChainHookBuilder = {
  after: (name: string) => ChainHookBuilder;
  before: (name: string) => ChainHookBuilder;
};

type ChatLunaLike = {
  registerAllowReplyResolver?: (
    name: string,
    resolver: (arg: { session: Session; context: unknown }) => boolean | void | Promise<boolean | void>,
  ) => () => void;
  chatChain?: {
    middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => ChainHookBuilder;
  };
};

type MiddlewareContextLike = {
  options?: {
    room?: {
      conversationId?: string;
    };
  };
};

type ContextWithAffinity = Context & {
  database: any;
  chatluna?: ChatLunaLike;
  bots?: Array<{
    selfId?: string;
    platform?: string;
    sendMessage: (...args: any[]) => Promise<unknown>;
  }>;
  affinity?: AffinityServiceLike;
};

function resolveChatLunaService(ctx: ContextWithAffinity): ChatLunaLike | undefined {
  const carrier = ctx as unknown as { get?: (name: string) => unknown; chatluna?: ChatLunaLike };
  const fromGetter = typeof carrier.get === 'function'
    ? carrier.get.call(ctx, 'chatluna') as ChatLunaLike | undefined
    : undefined;
  return fromGetter ?? carrier.chatluna;
}

function requireBooleanConfig(config: Config, key: keyof Config): boolean {
  const value = config[key];
  if (typeof value !== 'boolean') {
    throw new Error(`关系事件配置缺失或非法：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return value;
}

function requireNaturalConfig(config: Config, key: keyof Config, min = 1): number {
  const value = Number(config[key]);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`关系事件配置缺失或非法：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return Math.floor(value);
}

function ensureAffinityTables(ctx: Context): void {
  ctx.model.extend(
    'affinity_config',
    {
      id: 'unsigned',
      key: 'string',
      value: 'text',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      unique: ['key'],
    },
  );

  ctx.model.extend(
    'affinity_scope_config',
    {
      id: 'unsigned',
      characterId: 'string',
      scopeKind: 'string',
      scopeId: 'string',
      enabled: 'unsigned',
      proactiveEnabled: 'unsigned',
      label: { type: 'text', nullable: true },
      platform: { type: 'string', nullable: true },
      botSelfId: { type: 'string', nullable: true },
      channelId: { type: 'string', nullable: true },
      guildId: { type: 'string', nullable: true },
      conversationId: { type: 'string', nullable: true },
      updatedAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['characterId', 'scopeKind', 'scopeId'], ['scopeKind', 'scopeId']],
    },
  );

  ctx.model.extend(
    'affinity_user_state',
    {
      id: 'unsigned',
      characterId: 'string',
      userKey: 'string',
      platform: 'string',
      userId: 'string',
      displayName: { type: 'text', nullable: true },
      trust: 'double',
      familiarity: 'double',
      comfort: 'double',
      tension: 'double',
      mood: 'string',
      attentionHeat: 'double',
      energy: 'double',
      stage: 'string',
      flags: { type: 'text', nullable: true },
      unlockedScenes: { type: 'text', nullable: true },
      dailyState: { type: 'text', nullable: true },
      weeklyState: { type: 'text', nullable: true },
      lastSeenAt: 'double',
      lastUpdatedAt: 'double',
      createdAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['characterId', 'userKey'], ['updatedAt']],
    },
  );

  ctx.model.extend(
    'affinity_event',
    {
      id: 'unsigned',
      characterId: 'string',
      userKey: { type: 'string', nullable: true },
      scopeKind: 'string',
      scopeId: 'string',
      platform: 'string',
      botSelfId: { type: 'string', nullable: true },
      channelId: { type: 'string', nullable: true },
      guildId: { type: 'string', nullable: true },
      conversationId: { type: 'string', nullable: true },
      messageId: { type: 'string', nullable: true },
      eventType: 'string',
      effectTier: 'string',
      route: 'string',
      confidence: 'double',
      reasonCode: 'string',
      deltaJson: { type: 'text', nullable: true },
      beforeJson: { type: 'text', nullable: true },
      afterJson: { type: 'text', nullable: true },
      evidence: { type: 'text', nullable: true },
      createdAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['characterId', 'userKey'], ['scopeKind', 'scopeId'], ['createdAt']],
    },
  );

  ctx.model.extend(
    'affinity_random_plan',
    {
      id: 'unsigned',
      planKey: 'string',
      characterId: 'string',
      triggerKind: 'string',
      scopeKind: 'string',
      scopeId: 'string',
      platform: { type: 'string', nullable: true },
      botSelfId: { type: 'string', nullable: true },
      channelId: { type: 'string', nullable: true },
      guildId: { type: 'string', nullable: true },
      conversationId: { type: 'string', nullable: true },
      dayKey: 'string',
      slotIndex: 'unsigned',
      direction: 'string',
      scheduledAt: 'double',
      status: 'string',
      messageText: { type: 'text', nullable: true },
      skipReason: { type: 'text', nullable: true },
      sentAt: { type: 'double', nullable: true },
      createdAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      unique: ['planKey'],
      indexes: [['characterId', 'scopeKind', 'scopeId', 'dayKey'], ['status', 'scheduledAt']],
    },
  );

  ctx.model.extend(
    'affinity_open_thread',
    {
      id: 'unsigned',
      characterId: 'string',
      scopeKind: 'string',
      scopeId: 'string',
      userKey: { type: 'string', nullable: true },
      threadType: 'string',
      title: 'text',
      summary: 'text',
      status: 'string',
      payloadJson: { type: 'text', nullable: true },
      expiresAt: 'double',
      createdAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['characterId', 'scopeKind', 'scopeId', 'status'], ['expiresAt']],
    },
  );

  ctx.model.extend(
    'affinity_random_memory',
    {
      id: 'unsigned',
      characterId: 'string',
      scopeKind: 'string',
      scopeId: 'string',
      direction: 'string',
      sourcePlanId: { type: 'unsigned', nullable: true },
      messageText: 'text',
      contextSummary: { type: 'text', nullable: true },
      materialJson: { type: 'text', nullable: true },
      responseSummary: { type: 'text', nullable: true },
      responderNames: { type: 'text', nullable: true },
      createdAt: 'double',
      lastResponseAt: { type: 'double', nullable: true },
      expiresAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['characterId', 'scopeKind', 'scopeId'], ['sourcePlanId'], ['expiresAt']],
    },
  );

  ctx.model.extend(
    'affinity_audit',
    {
      id: 'unsigned',
      eventType: 'string',
      characterId: 'string',
      userKey: { type: 'string', nullable: true },
      scopeKind: { type: 'string', nullable: true },
      scopeId: { type: 'string', nullable: true },
      detail: { type: 'text', nullable: true },
      createdAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['eventType'], ['createdAt']],
    },
  );
}

export function apply(ctx: Context, config: Config): void {
  const runtime = {
    enabled: requireBooleanConfig(config, 'enabled'),
    proactiveEnabled: requireBooleanConfig(config, 'proactiveEnabled'),
    pollIntervalMs: requireNaturalConfig(config, 'pollIntervalMs', 1000),
    randomWindowStartHour: requireNaturalConfig(config, 'randomWindowStartHour', 0),
    randomWindowEndHour: requireNaturalConfig(config, 'randomWindowEndHour', 1),
  };
  void runtime.randomWindowStartHour;
  void runtime.randomWindowEndHour;

  const serviceCtx = ctx as ContextWithAffinity;
  ensureAffinityTables(ctx);
  const database = (ctx as unknown as { database: AffinityDatabaseLike }).database;
  const service = new AffinityService(
    database,
    () => (((ctx as unknown as { bots?: unknown[] }).bots ?? []) as any[]),
    Math.random,
    () => resolveChatLunaService(serviceCtx) as any,
  );
  service.setRuntimeGate(runtime.enabled, runtime.proactiveEnabled);
  const provider = ctx as unknown as {
    provide?: (name: string) => void;
    set?: (name: string, value: unknown) => void;
    affinity?: AffinityServiceLike;
  };
  if (typeof provider.provide === 'function' && typeof provider.set === 'function') {
    provider.provide('affinity');
    provider.set('affinity', service);
  } else {
    provider.affinity = service;
  }

  let disposeAllowReplyResolver: (() => void) | null = null;
  let randomScheduler: AffinityRandomPlanScheduler | null = null;
  let chatlunaRetryTimer: ReturnType<typeof setInterval> | null = null;
  let chatlunaHooksRegistered = false;
  service.setScheduleRefreshCallback(() => randomScheduler?.refreshSoon('service-change'));

  if (runtime.enabled) {
    ctx.middleware(async (session, next) => {
      try {
        await service.processIncomingSession(session);
      } catch (error) {
        logger.warn('affinity incoming processing skipped: %s', error instanceof Error ? error.message : String(error));
      }
      return next();
    });
  }

  ctx.command('祥子状态', '查看丰川祥子关系状态').action(async ({ session }) => {
    if (!session?.userId) return '无法识别当前用户。';
    const userKey = `${session.platform || 'unknown'}:${session.userId}`;
    const state = await service.getConsoleState();
    const user = state.users.find((item) => item.userKey === userKey);
    if (!user) return '祥子还没有留下关于你的关系记录。';
    return [
      `关系阶段：${user.stage}`,
      `心情：${user.mood}`,
      `状态：trust ${Math.round(user.trust)} / familiarity ${Math.round(user.familiarity)} / comfort ${Math.round(user.comfort)} / tension ${Math.round(user.tension)}`,
      '群聊里默认不会公开精确数值；这里只是调试视图。',
    ].join('\n');
  });

  const registerChatLunaHooks = (): boolean => {
    if (chatlunaHooksRegistered) return true;
    const chatluna = resolveChatLunaService(serviceCtx);
    if (!chatluna?.chatChain) return false;
    if (chatluna.registerAllowReplyResolver) {
      disposeAllowReplyResolver = chatluna.registerAllowReplyResolver(allowReplyResolverName, ({ session }) => {
        const result = getSessionAffinityResult(session);
        if (result?.shouldAllowReply) return true;
      });
      logger.info('affinity allow reply resolver registered.');
    }

    chatluna.chatChain
      .middleware('qqbot_affinity_prompt_context', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MiddlewareContextLike;
        const conversationId = context.options?.room?.conversationId?.trim();
        if (conversationId) {
          await service.injectPromptForTurn(conversationId, session);
        }
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('chatluna_time_context')
      .before('lifecycle-handle_command');
    chatlunaHooksRegistered = true;
    logger.info('affinity prompt middleware registered.');
    return true;
  };

  ctx.on('ready', () => {
    if (!registerChatLunaHooks()) {
      let attempts = 0;
      logger.warn('chatluna service is unavailable, retry affinity prompt registration.');
      chatlunaRetryTimer = setInterval(() => {
        attempts += 1;
        if (registerChatLunaHooks() || attempts >= 20) {
          if (chatlunaRetryTimer) clearInterval(chatlunaRetryTimer);
          chatlunaRetryTimer = null;
          if (!chatlunaHooksRegistered) {
            logger.warn('chatluna service is unavailable after retry, skip affinity prompt registration.');
          }
        }
      }, 1000);
    }

    if (runtime.enabled) {
      randomScheduler = new AffinityRandomPlanScheduler(service, {
        safetyIntervalMs: Math.max(60_000, runtime.pollIntervalMs),
        logger,
      });
      randomScheduler.start();
    }
    logger.info('affinity service registered.');
  });

  ctx.on('dispose', () => {
    disposeAllowReplyResolver?.();
    disposeAllowReplyResolver = null;
    if (chatlunaRetryTimer) {
      clearInterval(chatlunaRetryTimer);
      chatlunaRetryTimer = null;
    }
    randomScheduler?.dispose();
    randomScheduler = null;
  });
}
