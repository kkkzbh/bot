import { Context, Logger, Schema, type Session } from 'koishi';
import type { FeaturePolicyServiceLike } from '../../types/feature-policy.js';
import { createVoiceRuntimeConfigFromEnv } from '../reply/index.js';
import {
  buildGroupScopeKey,
  buildRealtimeModalities,
  buildSessionSnapshot,
  collectImageUrls,
  normalizeMessageText,
  realtimeMessageCache,
  resolveSessionVoiceTranscript,
  resolveSpeakerName,
  selectRealtimeMessageWindow,
} from './cache.js';
import {
  buildRealtimeHistoryContent,
  buildRealtimeMessageFallbackContent,
  toRealtimeHistoryMessage,
} from './media.js';
import { registerRealtimeMessageTools } from './tool.js';
import type { RealtimeMessageEntry, RealtimeMessageSessionLike } from './types.js';
import {
  downloadIncomingAudio,
  extractFirstIncomingVoice,
  isVoiceInputRuntimeAvailable,
  transcribeAudio,
  type OneBotVoiceBotLike,
} from '../shared/voice/index.js';

const logger = new Logger('realtime-message');
const CHAT_CHAIN_CONTINUE = 2;

export const name = 'realtime-message';
export const inject = { required: ['chatluna'], optional: ['featurePolicy'] } as const;

export interface Config {
  maxInjectCount?: number;
}

export const Config: Schema<Config> = Schema.object({
  maxInjectCount: Schema.natural().description('每轮最多注入多少条实时消息。'),
});

interface RuntimeConfig {
  maxInjectCount: number;
}

type ChainHookBuilder = {
  after: (name: string) => ChainHookBuilder;
  before: (name: string) => ChainHookBuilder;
};

type PromotionRoom = {
  conversationId?: string;
  roomId?: string | number;
  model?: string;
};

type MiddlewareContextLike = {
  options?: {
    room?: PromotionRoom;
  };
};

type ContextWithRealtime = Context & {
  featurePolicy?: FeaturePolicyServiceLike;
  chatluna: {
    platform?: {
      registerTool?: (...args: any[]) => () => void;
    };
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
      ) => Promise<{ content?: unknown }>;
    };
  };
};

function requireBooleanEnv(key: string): boolean {
  const value = process.env[key];
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) {
    throw new Error(`${key} 未配置。默认值必须由 env/koishi.yml 显式提供。`);
  }
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`${key} 必须是 true 或 false。`);
  }
  return raw === 'true';
}

function requireNaturalConfig(config: Config, key: keyof Config): number {
  const value = config[key];
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`实时消息配置缺失或非法：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return Math.floor(parsed);
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  return {
    maxInjectCount: requireNaturalConfig(config, 'maxInjectCount'),
  };
}

function resolveMessageId(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function resolveRealtimeEnabledFallback(session: Session): boolean {
  if (session.isDirect) return false;
  return requireBooleanEnv('QQBOT_REALTIME_MESSAGE_ENABLED');
}

async function resolveRealtimeFeatureEnabled(
  featurePolicy: FeaturePolicyServiceLike | undefined,
  session: Session,
): Promise<boolean> {
  if (session.isDirect) return false;
  if (!featurePolicy) return resolveRealtimeEnabledFallback(session);
  return featurePolicy.resolveFeatureEnabled(session, 'QQBOT_REALTIME_MESSAGE_ENABLED');
}

async function resolveVoiceInputFeatureEnabled(
  featurePolicy: FeaturePolicyServiceLike | undefined,
  session: Session,
): Promise<boolean> {
  if (!featurePolicy) {
    return requireBooleanEnv('QQ_VOICE_INPUT_ENABLED');
  }
  return featurePolicy.resolveFeatureEnabled(session, 'QQ_VOICE_INPUT_ENABLED');
}

async function captureRealtimeEntry(
  session: Session & RealtimeMessageSessionLike,
  featurePolicy: FeaturePolicyServiceLike | undefined,
): Promise<RealtimeMessageEntry | null> {
  const groupScopeKey = buildGroupScopeKey(session);
  if (!groupScopeKey) return null;

  const userId = typeof session.userId === 'string' ? session.userId.trim() : '';
  if (!userId || userId === session.bot?.selfId) return null;

  const text = normalizeMessageText(session);
  const imageUrls = collectImageUrls(session);
  const cachedTranscript = resolveSessionVoiceTranscript(session);
  const hasVoiceInput = Boolean(cachedTranscript || extractFirstIncomingVoice(String(session.content ?? '')));
  let voiceTranscript = cachedTranscript || '';

  if (hasVoiceInput && !voiceTranscript) {
    const voiceRuntime = createVoiceRuntimeConfigFromEnv();
    const voiceFeatureEnabled = await resolveVoiceInputFeatureEnabled(featurePolicy, session);
    if (!voiceFeatureEnabled || !isVoiceInputRuntimeAvailable(voiceRuntime)) {
      return null;
    }

    try {
      const downloaded = await downloadIncomingAudio(session, voiceRuntime, session.bot as OneBotVoiceBotLike);
      const transcript = await transcribeAudio(voiceRuntime, downloaded);
      if (!transcript.text) return null;
      if (transcript.durationMs > voiceRuntime.inputMaxSeconds * 1000) {
        return null;
      }
      voiceTranscript = transcript.text;
    } catch (error) {
      logger.warn(
        'skip realtime voice capture for message %s: %s',
        resolveMessageId(session.messageId) ?? 'unknown',
        (error as Error).message,
      );
      return null;
    }
  }

  const modalities = buildRealtimeModalities({
    text,
    imageUrls,
    voiceTranscript,
  });
  if (!modalities.length) return null;

  return {
    messageId: resolveMessageId(session.messageId),
    groupScopeKey,
    userId,
    speakerName: resolveSpeakerName(session, userId),
    capturedAt: Date.now(),
    modalities,
    text,
    imageUrls,
    voiceTranscript: voiceTranscript || null,
    sessionSnapshot: buildSessionSnapshot(session),
  };
}

export function apply(ctx: Context, config: Config = {}): void {
  const runtime = toRuntimeConfig(config);
  const serviceCtx = ctx as ContextWithRealtime;
  const featurePolicy = serviceCtx.featurePolicy;
  let promotionRegistered = false;
  let toolDisposers: Array<() => void> = [];

  const ensurePromotionRegistered = (): void => {
    if (promotionRegistered) return;

    const chain = serviceCtx.chatluna.chatChain;
    const queryInterfaceWrapper = serviceCtx.chatluna.queryInterfaceWrapper?.bind(serviceCtx.chatluna);
    if (!chain || typeof queryInterfaceWrapper !== 'function') {
      logger.warn('chatluna chat chain is unavailable, skip realtime message promotion middleware registration.');
      return;
    }

    chain
      .middleware('qqbot_realtime_message_promotion', async (rawSession, rawContext) => {
        const session = rawSession as Session & RealtimeMessageSessionLike;
        const context = rawContext as MiddlewareContextLike;
        const groupScopeKey = buildGroupScopeKey(session);
        if (!groupScopeKey || session.isDirect) {
          return CHAT_CHAIN_CONTINUE;
        }

        const room = context.options?.room;
        const conversationId = typeof room?.conversationId === 'string' ? room.conversationId.trim() : '';
        if (!room || !conversationId) {
          return CHAT_CHAIN_CONTINUE;
        }

        const featureEnabled = await resolveRealtimeFeatureEnabled(featurePolicy, session);
        const cachedEntries = realtimeMessageCache.get(groupScopeKey);
        if (!featureEnabled) {
          realtimeMessageCache.clearGroup(groupScopeKey);
          return CHAT_CHAIN_CONTINUE;
        }
        if (!cachedEntries.length) {
          return CHAT_CHAIN_CONTINUE;
        }

        const entries = selectRealtimeMessageWindow(cachedEntries, session, runtime.maxInjectCount);
        realtimeMessageCache.clearGroup(groupScopeKey);
        if (!entries.length) {
          return CHAT_CHAIN_CONTINUE;
        }

        const interfaceWrapper = queryInterfaceWrapper(room, true);
        const chatInterface = await interfaceWrapper?.query(room, true);
        const chatHistory = chatInterface?.chatHistory;
        if (typeof chatHistory?.addMessages !== 'function') {
          logger.warn('realtime message promotion skipped: chat history is unavailable (conversationId=%s).', conversationId);
          return CHAT_CHAIN_CONTINUE;
        }

        const messages = await Promise.all(
          entries.map(async (entry) => {
            const transformed = await buildRealtimeHistoryContent(serviceCtx.chatluna, room, entry);
            const fallbackContent = buildRealtimeMessageFallbackContent(entry);
            if (transformed !== undefined) {
              return toRealtimeHistoryMessage(entry, { content: transformed });
            }
            if (fallbackContent != null) {
              return toRealtimeHistoryMessage(entry, { content: fallbackContent });
            }
            return toRealtimeHistoryMessage(entry);
          }),
        );

        await chatHistory.addMessages(messages);
        logger.info(
          'promoted %d realtime message(s) into conversation history (conversationId=%s).',
          messages.length,
          conversationId,
        );
        return CHAT_CHAIN_CONTINUE;
      })
      .after('chatluna_model_guard')
      .before('resolve_model');

    promotionRegistered = true;
    logger.info('realtime message promotion middleware registered.');
  };

  ctx.middleware(async (rawSession, next) => {
    const session = rawSession as Session & RealtimeMessageSessionLike;
    const groupScopeKey = buildGroupScopeKey(session);
    if (!groupScopeKey) return next();
    if (!session.userId || session.userId === session.bot?.selfId) return next();

    const featureEnabled = await resolveRealtimeFeatureEnabled(featurePolicy, session);
    if (!featureEnabled) {
      realtimeMessageCache.clearGroup(groupScopeKey);
      return next();
    }

    const entry = await captureRealtimeEntry(session, featurePolicy);
    if (entry) {
      realtimeMessageCache.append(groupScopeKey, entry);
    }

    return next();
  });

  ctx.on('ready', () => {
    ensurePromotionRegistered();
    toolDisposers = registerRealtimeMessageTools(serviceCtx, {
      resolveRealtimeEnabled: (session) => resolveRealtimeFeatureEnabled(featurePolicy, session),
    });
    logger.info('realtime message loaded: maxInjectCount=%d', runtime.maxInjectCount);
  });

  ctx.on('dispose', () => {
    for (const dispose of toolDisposers) {
      dispose();
    }
    toolDisposers = [];
    realtimeMessageCache.clear();
  });
}
