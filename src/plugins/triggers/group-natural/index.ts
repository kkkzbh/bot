import { Context, Logger, Schema, Session } from 'koishi';
import type { MessageContent } from '@langchain/core/messages';
import type { FeaturePolicyServiceLike } from '../../../types/feature-policy.js';
import { normalizeGroupId, parseGroupSet } from '../../shared/group-id.js';
import {
  containsAlias,
  createEmptySpamState,
  DEFAULT_TRIGGER_ALIASES,
  parseAliasList,
  recordSpamMessage,
  shouldTriggerByRule,
  type SpamState,
} from './matcher.js';
import {
  getNaturalTriggerState,
  setNaturalTriggerState,
  type NaturalTriggerReason,
  type NaturalTriggerState,
} from './state.js';
import {
  buildGroupScopeKey,
  buildGroupRecentContextFallbackContent,
  capturePassiveGroupRecentContext,
  consumePassiveGroupRecentContext,
  groupRecentContextCache,
  toGroupRecentContextHistoryMessage,
} from './recent-context.js';

const logger = new Logger('group-natural-trigger');
const allowReplyResolverName = 'group-natural-trigger';
const CHAT_CHAIN_CONTINUE = 2;

export const name = 'group-natural-trigger';
export const inject = { required: ['chatluna'], optional: ['featurePolicy'] } as const;
export {
  getNaturalTriggerState,
  setNaturalTriggerState,
  type NaturalTriggerReason,
  type NaturalTriggerState,
} from './state.js';

export interface Config {
  enabled?: boolean;
  enabledGroups?: string[] | string;
  aliases?: string[] | string;
  directTriggerProbability?: number;
  focusWindowMs?: number;
  replyIntervalMs?: number;
  spamWindowMs?: number;
  spamThreshold?: number;
  spamMuteMs?: number;
  decisionEnabled?: boolean;
  decisionBaseUrl?: string;
  decisionApiKey?: string;
  decisionModel?: string;
  decisionTimeoutMs?: number;
  decisionMinConfidence?: number;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用群聊自然触发。'),
  enabledGroups: Schema.union([
    Schema.array(Schema.string()).role('table').description('启用自然触发的白名单群号列表。留空表示不在任何群自动触发。'),
    Schema.string().description('启用自然触发的白名单群号（逗号分隔，留空表示不在任何群自动触发）。'),
  ]),
  aliases: Schema.union([
    Schema.array(Schema.string()).role('table').description('可触发机器人对话的称呼列表。'),
    Schema.string().description('可触发机器人对话的称呼（逗号分隔）。'),
  ]),
  directTriggerProbability: Schema.number()
    .min(0)
    .max(1)
    .default(0.25)
    .description('任意消息直接触发回复的概率。'),
  focusWindowMs: Schema.natural().role('time').default(300000).description('会话焦点窗口（毫秒）。'),
  replyIntervalMs: Schema.natural().role('time').default(2000).description('机器人两次回复最小时间间隔（毫秒）。'),
  spamWindowMs: Schema.natural().role('time').default(10000).description('刷屏判定窗口（毫秒）。'),
  spamThreshold: Schema.natural().default(10).description('刷屏判定阈值（窗口内消息数）。'),
  spamMuteMs: Schema.natural().role('time').default(180000).description('刷屏后忽略时长（毫秒）。'),
  decisionEnabled: Schema.boolean().default(true).description('是否启用模型触发判定。'),
  decisionBaseUrl: Schema.string()
    .role('link')
    .description('触发判定模型 API Base URL（默认复用 OPENAI_BASE_URL）。'),
  decisionApiKey: Schema.string().role('secret').description('触发判定模型 API Key（默认复用 OPENAI_API_KEY）。'),
  decisionModel: Schema.string().description('触发判定模型名（默认复用 OPENAI_MODEL）。'),
  decisionTimeoutMs: Schema.natural().role('time').default(4000).description('触发判定模型超时（毫秒）。'),
  decisionMinConfidence: Schema.number().min(0).max(1).default(0.62).description('触发判定模型最小置信度。'),
});

interface RuntimeConfig {
  enabled: boolean;
  enabledGroups: Set<string>;
  aliases: string[];
  directTriggerProbability: number;
  focusWindowMs: number;
  replyIntervalMs: number;
  spamWindowMs: number;
  spamThreshold: number;
  spamMuteMs: number;
  decisionEnabled: boolean;
  decisionBaseUrl: string;
  decisionApiKey: string;
  decisionModel: string;
  decisionTimeoutMs: number;
  decisionMinConfidence: number;
}

interface ModelDecisionResponse {
  trigger?: boolean;
  confidence?: number;
}

interface TriggerDecisionResult {
  trigger: boolean;
  confidence: number | null;
  rawContent: string | null;
}

type ContextWithFeaturePolicy = Context & {
  featurePolicy?: FeaturePolicyServiceLike;
  chatluna: {
    registerAllowReplyResolver: (
      name: string,
      resolver: (arg: { session: Session; context: unknown }) => boolean | void | Promise<boolean | void>,
    ) => () => void;
    chatChain?: {
      middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => ChainHookBuilder;
    };
    queryInterfaceWrapper?: (room: unknown, autoCreate?: boolean) => {
      query: (room: unknown, create?: boolean) => Promise<{
        chatHistory?: {
          addMessages?: (messages: unknown[]) => Promise<void>;
        };
      }>;
    } | undefined;
    messageTransformer?: {
      transform: (
        session: unknown,
        message: unknown[],
        model?: string,
        command?: unknown,
        options?: Record<string, unknown>,
      ) => Promise<{
        content?: unknown;
      }>;
    };
  };
};

type ChainHookBuilder = {
  after: (name: string) => ChainHookBuilder;
  before: (name: string) => ChainHookBuilder;
};

type MiddlewareContextLike = {
  options?: {
    room?: {
      conversationId?: string;
      roomId?: string | number;
      model?: string;
    };
  };
};

type PromotionRoom = {
  conversationId?: string;
  roomId?: string | number;
  model?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) ?? raw.match(/```\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return null;
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  const configuredAliases = parseAliasList(config.aliases ?? process.env.CHAT_NATURAL_TRIGGER_ALIASES);
  const configuredGroups = parseGroupSet(config.enabledGroups ?? process.env.CHAT_NATURAL_TRIGGER_GROUPS);
  const directTriggerProbability = Number(
    config.directTriggerProbability ?? process.env.CHAT_NATURAL_TRIGGER_DIRECT_PROBABILITY ?? 0.25,
  );
  const decisionBaseUrl = (
    config.decisionBaseUrl ??
    process.env.CHAT_NATURAL_TRIGGER_DECISION_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    ''
  ).replace(/\/+$/, '');

  return {
    enabled:
      config.enabled ??
      String(process.env.CHAT_NATURAL_TRIGGER_ENABLED ?? 'true').toLowerCase() !== 'false',
    enabledGroups: configuredGroups,
    aliases: configuredAliases.length ? configuredAliases : DEFAULT_TRIGGER_ALIASES.map((item) => item.toLowerCase()),
    directTriggerProbability: Number.isFinite(directTriggerProbability)
      ? Math.max(0, Math.min(1, directTriggerProbability))
      : 0.25,
    focusWindowMs: Number(config.focusWindowMs ?? process.env.CHAT_NATURAL_TRIGGER_FOCUS_WINDOW_MS ?? 300000),
    replyIntervalMs: Number(config.replyIntervalMs ?? process.env.CHAT_NATURAL_TRIGGER_REPLY_INTERVAL_MS ?? 2000),
    spamWindowMs: Number(config.spamWindowMs ?? process.env.CHAT_NATURAL_TRIGGER_SPAM_WINDOW_MS ?? 10000),
    spamThreshold: Number(config.spamThreshold ?? process.env.CHAT_NATURAL_TRIGGER_SPAM_THRESHOLD ?? 10),
    spamMuteMs: Number(config.spamMuteMs ?? process.env.CHAT_NATURAL_TRIGGER_SPAM_MUTE_MS ?? 180000),
    decisionEnabled:
      config.decisionEnabled ??
      String(process.env.CHAT_NATURAL_TRIGGER_DECISION_ENABLED ?? 'true').toLowerCase() !== 'false',
    decisionBaseUrl,
    decisionApiKey:
      config.decisionApiKey ?? process.env.CHAT_NATURAL_TRIGGER_DECISION_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    decisionModel:
      config.decisionModel ?? process.env.CHAT_NATURAL_TRIGGER_DECISION_MODEL ?? process.env.OPENAI_MODEL ?? '',
    decisionTimeoutMs: Number(
      config.decisionTimeoutMs ?? process.env.CHAT_NATURAL_TRIGGER_DECISION_TIMEOUT_MS ?? 4000,
    ),
    decisionMinConfidence: Number(
      config.decisionMinConfidence ?? process.env.CHAT_NATURAL_TRIGGER_DECISION_MIN_CONFIDENCE ?? 0.62,
    ),
  };
}

function normalizeMessageContent(session: Session): string {
  const stripped = session.stripped?.content?.trim();
  if (stripped) return stripped;
  return session.content?.trim() ?? '';
}

function hasImageInput(session: Session): boolean {
  const elements = Array.isArray(session.elements) ? session.elements : [];
  if (
    elements.some((element) => {
      const type = typeof element?.type === 'string' ? element.type.toLowerCase() : '';
      return type === 'img' || type === 'image';
    })
  ) {
    return true;
  }

  const rawContent = String(session.content ?? '');
  return /<img\b/i.test(rawContent) || /\[CQ:image,[^\]]+\]/i.test(rawContent);
}

function isQuotedToBot(session: Session): boolean {
  const quote = session.quote as { user?: { id?: string } } | undefined;
  return Boolean(quote?.user?.id && quote.user.id === session.bot?.selfId);
}

async function shouldTriggerByModel(content: string, runtime: RuntimeConfig): Promise<TriggerDecisionResult> {
  if (!runtime.decisionEnabled || !runtime.decisionBaseUrl || !runtime.decisionApiKey || !runtime.decisionModel) {
    return { trigger: false, confidence: null, rawContent: null };
  }

  const systemPrompt =
    '你是群聊机器人触发判定器。仅输出 JSON：{"trigger":true|false,"confidence":0~1}。' +
    '当用户在和机器人说话、向机器人提问、或明确希望机器人响应时 trigger=true；否则 false。';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.decisionTimeoutMs);

  try {
    const response = await fetch(`${runtime.decisionBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtime.decisionApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: runtime.decisionModel,
        max_tokens: 120,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `消息: ${content}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) return { trigger: false, confidence: null, rawContent: null };

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };

    const rawContent = payload.choices?.[0]?.message?.content;
    const contentText = Array.isArray(rawContent)
      ? rawContent
          .map((item) => (typeof item?.text === 'string' ? item.text : ''))
          .join('')
          .trim()
      : typeof rawContent === 'string'
        ? rawContent.trim()
        : '';

    if (!contentText) return { trigger: false, confidence: null, rawContent: null };

    const jsonText = extractJsonObject(contentText);
    if (!jsonText) return { trigger: false, confidence: null, rawContent: contentText };

    const parsed = JSON.parse(jsonText) as ModelDecisionResponse;
    const confidence = Number(parsed.confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < runtime.decisionMinConfidence) {
      return { trigger: false, confidence: Number.isFinite(confidence) ? confidence : null, rawContent: contentText };
    }

    return {
      trigger: Boolean(parsed.trigger),
      confidence,
      rawContent: contentText,
    };
  } catch {
    return { trigger: false, confidence: null, rawContent: null };
  } finally {
    clearTimeout(timer);
  }
}

function buildSpamKey(session: Session): string {
  return `${buildGroupScopeKey(session) ?? session.channelId ?? ''}:${session.userId ?? ''}`;
}

function resolveGroupId(session: Session): string | null {
  return normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
}

function shouldHandleGroup(session: Session, runtime: RuntimeConfig): boolean {
  if (session.isDirect) return false;
  const groupId = resolveGroupId(session);
  if (!groupId) return false;
  if (!runtime.enabledGroups.size) return false;
  return runtime.enabledGroups.has(groupId);
}

async function buildPromotedHistoryMessage(
  chatluna: ContextWithFeaturePolicy['chatluna'],
  room: PromotionRoom,
  entry: Parameters<typeof toGroupRecentContextHistoryMessage>[0],
) {
  if (entry.imageCount < 1) {
    return toGroupRecentContextHistoryMessage(entry);
  }

  const messageTransformer = chatluna.messageTransformer;
  const elements = Array.isArray(entry.sessionSnapshot.elements) ? entry.sessionSnapshot.elements : [];
  const model = typeof room.model === 'string' ? room.model : '';

  if (messageTransformer && elements.length > 0) {
    try {
      const transformed = await messageTransformer.transform(
        entry.sessionSnapshot as unknown as Session,
        elements,
        model,
        undefined,
        {
          quote: false,
          includeQuoteReply: false,
        },
      );
      if (transformed?.content !== undefined) {
        return toGroupRecentContextHistoryMessage(entry, {
          content: transformed.content as MessageContent,
        });
      }
    } catch (error) {
      logger.warn(
        'recent group context image promotion fell back to raw image urls for message %s: %s',
        entry.messageId ?? 'unknown',
        (error as Error).message,
      );
    }
  }

  const fallbackContent = buildGroupRecentContextFallbackContent(entry);
  if (fallbackContent != null) {
    return toGroupRecentContextHistoryMessage(entry, {
      content: fallbackContent,
    });
  }

  return toGroupRecentContextHistoryMessage(entry);
}

export function apply(ctx: Context, config: Config): void {
  const runtime = toRuntimeConfig(config);
  const serviceCtx = ctx as ContextWithFeaturePolicy;
  const featurePolicy = serviceCtx.featurePolicy;
  const focusExpires = new Map<string, number>();
  const spamStates = new Map<string, SpamState>();
  const nextReplyAt = new Map<string, number>();
  let disposeAllowReplyResolver: (() => void) | null = null;
  let recentContextPromotionRegistered = false;

  const ensureAllowReplyResolverRegistered = (): void => {
    if (disposeAllowReplyResolver) return;
    disposeAllowReplyResolver = serviceCtx.chatluna.registerAllowReplyResolver(allowReplyResolverName, ({ session }) => {
      const naturalTrigger = getNaturalTriggerState(session as unknown as Record<string, unknown>);
      if (!naturalTrigger) return;
      logger.info(
        'natural trigger allow resolver hit: channel=%s user=%s reason=%s explicit=%s',
        session.channelId,
        session.userId,
        naturalTrigger.reason,
        String(naturalTrigger.explicit),
      );
      return true;
    });
    logger.info('natural trigger allow resolver registered.');
  };

  const ensureRecentContextPromotionRegistered = (): void => {
    if (recentContextPromotionRegistered) return;

    const chain = serviceCtx.chatluna.chatChain;
    const queryInterfaceWrapper = serviceCtx.chatluna.queryInterfaceWrapper;
    if (!chain || typeof queryInterfaceWrapper !== 'function') {
      logger.warn('chatluna chat chain is unavailable, skip recent group context promotion middleware registration.');
      return;
    }

    chain
      .middleware('qqbot_group_recent_context_promotion', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MiddlewareContextLike;
        const naturalTrigger = getNaturalTriggerState(session as unknown as Record<string, unknown>);
        if (!naturalTrigger || session.isDirect) {
          return CHAT_CHAIN_CONTINUE;
        }

        const room = context.options?.room;
        const conversationId = typeof room?.conversationId === 'string' ? room.conversationId.trim() : '';
        if (!room || !conversationId) {
          return CHAT_CHAIN_CONTINUE;
        }

        const entries = consumePassiveGroupRecentContext(session);
        if (!entries.length) {
          return CHAT_CHAIN_CONTINUE;
        }

        const interfaceWrapper = queryInterfaceWrapper(room, true);
        const chatInterface = await interfaceWrapper?.query(room, true);
        const chatHistory = chatInterface?.chatHistory;
        if (typeof chatHistory?.addMessages !== 'function') {
          logger.warn(
            'recent group context promotion skipped: chat history is unavailable (conversationId=%s).',
            conversationId,
          );
          return CHAT_CHAIN_CONTINUE;
        }

        await chatHistory.addMessages(
          await Promise.all(entries.map((entry) => buildPromotedHistoryMessage(serviceCtx.chatluna, room, entry))),
        );
        logger.info(
          'promoted %d recent group context message(s) into conversation history (conversationId=%s).',
          entries.length,
          conversationId,
        );
        return CHAT_CHAIN_CONTINUE;
      })
      .after('chatluna_model_guard')
      .before('resolve_model');

    recentContextPromotionRegistered = true;
    logger.info('recent group context promotion middleware registered.');
  };

  ctx.middleware(async (session, next) => {
    const capturedRecentContextEntry = capturePassiveGroupRecentContext(session);

    if (!runtime.enabled) return next();
    if (featurePolicy && !(await featurePolicy.resolveFeatureEnabled(session, 'CHAT_NATURAL_TRIGGER_ENABLED'))) {
      return next();
    }
    if (!session.userId || session.userId === session.bot?.selfId) return next();
    if (!shouldHandleGroup(session, runtime)) return next();

    const content = normalizeMessageContent(session);
    const imageInput = hasImageInput(session);
    if (!content && !imageInput) return next();

    const now = Date.now();
    const spamKey = buildSpamKey(session);
    const groupScopeKey = buildGroupScopeKey(session);
    if (!groupScopeKey) return next();
    const spamState = spamStates.get(spamKey) ?? createEmptySpamState();
    const spamResult = recordSpamMessage(spamState, now, {
      windowMs: runtime.spamWindowMs,
      threshold: runtime.spamThreshold,
      muteMs: runtime.spamMuteMs,
    });
    spamStates.set(spamKey, spamResult.state);

    if (spamResult.muted) {
      if (spamResult.justMuted) {
        logger.info('mute spam user for %d ms: channel=%s user=%s', runtime.spamMuteMs, session.channelId, session.userId);
      }
      return;
    }

    const directHit = Math.random() < runtime.directTriggerProbability;
    const focusUntil = focusExpires.get(groupScopeKey) ?? 0;
    const inFocus = focusUntil > now;
    const quotedToBot = isQuotedToBot(session);
    const hasAlias = content ? containsAlias(content, runtime.aliases) : false;
    const ruleTriggered = content ? shouldTriggerByRule(content, runtime.aliases, quotedToBot) : quotedToBot && imageInput;
    let triggerReason: NaturalTriggerReason | null = directHit ? 'direct' : null;
    let explicitTrigger = false;
    let modelDecision: TriggerDecisionResult | null = null;

    let shouldTrigger = directHit;

    if (!shouldTrigger) {
      shouldTrigger = ruleTriggered;
      if (shouldTrigger) {
        if (quotedToBot) {
          triggerReason = 'quote';
        } else if (hasAlias) {
          triggerReason = 'alias';
        } else {
          triggerReason = 'rule';
        }
        explicitTrigger = true;
      }
    }

    if (!shouldTrigger && !inFocus && content) {
      modelDecision = await shouldTriggerByModel(content, runtime);
      shouldTrigger = modelDecision.trigger;
      if (shouldTrigger) {
        triggerReason = 'model';
        explicitTrigger = false;
      }
    } else if (!shouldTrigger && inFocus) {
      shouldTrigger = true;
      triggerReason = 'focus';
      explicitTrigger = false;
    }

    if (!shouldTrigger) return next();

    const naturalTrigger: NaturalTriggerState = {
      reason: triggerReason ?? 'direct',
      explicit: explicitTrigger,
    };

    if (capturedRecentContextEntry) {
      groupRecentContextCache.remove(groupScopeKey, capturedRecentContextEntry);
    }

    const replyReadyAt = nextReplyAt.get(groupScopeKey) ?? 0;
    if (replyReadyAt > now) {
      await sleep(replyReadyAt - now);
    }

    const handlingAt = Date.now();
    nextReplyAt.set(groupScopeKey, handlingAt + runtime.replyIntervalMs);
    focusExpires.set(groupScopeKey, handlingAt + runtime.focusWindowMs);

    try {
      setNaturalTriggerState(session as unknown as Record<string, unknown>, naturalTrigger);
      logger.info(
        'natural trigger decision hit: channel=%s user=%s reason=%s explicit=%s',
        session.channelId,
        session.userId,
        naturalTrigger.reason,
        String(naturalTrigger.explicit),
      );
      return await next();
    } finally {
      setNaturalTriggerState(session as unknown as Record<string, unknown>, null);
    }
  });

  ctx.on('ready', () => {
    ensureAllowReplyResolverRegistered();
    ensureRecentContextPromotionRegistered();
    logger.info(
      'group natural trigger loaded: groups=%d, aliases=%d, direct=%s, focusWindowMs=%d, replyIntervalMs=%d, spam=%d/%dms mute=%dms',
      runtime.enabledGroups.size,
      runtime.aliases.length,
      runtime.directTriggerProbability.toFixed(2),
      runtime.focusWindowMs,
      runtime.replyIntervalMs,
      runtime.spamThreshold,
      runtime.spamWindowMs,
      runtime.spamMuteMs,
    );
  });

  ctx.on('dispose', () => {
    if (disposeAllowReplyResolver) {
      disposeAllowReplyResolver();
      disposeAllowReplyResolver = null;
    }
  });
}
