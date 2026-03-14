import { type Context, Logger, type Session } from 'koishi';
import {
  type LiveReplyConfig,
  type LiveReplyDatabaseLike,
  LiveReplyCoordinator,
  registerLiveReplyCoordinator,
  resolveLiveReplyRuntimeConfig,
} from './chatluna-live-reply.js';
import { injectUserStampedPrompt } from './chat-time-context.js';
import {
  createKeyedStrandRunner,
  createBotMessageDispatchers,
  dispatchOutboundMessagePlan,
  hasVoiceSegments,
  parseOutboundMessagePlan,
  resolveSessionStrandKey,
  shouldBypassLineSplit,
  type OutboundMessageSegment,
} from './message-send-utils.js';
import { inferPlatformFromBaseUrl, normalizeRawModelName, resolvePlatform } from './model-utils.js';
import { resolveSessionDisplayName } from './session-user-name.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
  checkConversationRoomAvailability: (ctx: Context, room: unknown) => Promise<boolean>;
  fixConversationRoomAvailability: (ctx: Context, config: unknown, room: unknown) => Promise<boolean>;
};
const ChatLunaPlatformTypes = require('koishi-plugin-chatluna/llm-core/platform/types') as {
  ModelType?: { llm?: number };
};

export const name = 'chatluna-model-guard';
export const inject = ['chatluna', 'database'];

export interface Config extends LiveReplyConfig {}

type ChainHookBuilder = {
  after: (name: string) => ChainHookBuilder;
  before: (name: string) => ChainHookBuilder;
};

type ChatLunaLike = {
  awaitLoadPlatform?: (platform: string, timeout?: number) => Promise<void>;
  clearCache?: (room: unknown) => Promise<boolean>;
  platform?: {
    listAllModels?: (type: number) => { value?: Array<{ toModelName?: () => string; platform?: string; name?: string }> };
  };
  contextManager?: {
    inject: (options: {
      name: string;
      value: unknown;
      once?: boolean;
      conversationId?: string;
      stage?: string;
    }) => void;
  };
  chatChain?: {
    middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => ChainHookBuilder;
  };
};

type ContextServices = { chatluna?: ChatLunaLike; database?: LiveReplyDatabaseLike };

type RoomLike = {
  roomId?: number | string;
  conversationId?: string;
  model?: string;
  [key: string]: unknown;
};

type MiddlewareContextLike = {
  command?: string;
  config: unknown;
  send?: (message: string) => Promise<void>;
  options?: {
    room?: RoomLike;
    messageId?: string;
    inputMessage?: {
      content?: unknown;
    };
  };
};

const logger = new Logger(name);
const LLM_MODEL_TYPE = ChatLunaPlatformTypes.ModelType?.llm ?? 1;
const deferredMultilineSendKeys = new Map<string, number>();

function markDeferredMultilineSendKeyActive(strandKey: string): () => void {
  deferredMultilineSendKeys.set(strandKey, (deferredMultilineSendKeys.get(strandKey) ?? 0) + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;

    const nextCount = (deferredMultilineSendKeys.get(strandKey) ?? 0) - 1;
    if (nextCount > 0) {
      deferredMultilineSendKeys.set(strandKey, nextCount);
      return;
    }

    deferredMultilineSendKeys.delete(strandKey);
  };
}

function isDeferredMultilineSendKeyActive(strandKey: string): boolean {
  return (deferredMultilineSendKeys.get(strandKey) ?? 0) > 0;
}

function listAllLlmModels(chatluna: ChatLunaLike): string[] {
  try {
    const models = chatluna.platform?.listAllModels?.(LLM_MODEL_TYPE).value ?? [];
    return models
      .map((model) => {
        if (typeof model.toModelName === 'function') return model.toModelName().trim();
        if (model.platform && model.name) return `${model.platform}/${model.name}`.trim();
        return '';
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolveDefaultModelForGuard(): string | null {
  return process.env.CHATLUNA_DEFAULT_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || null;
}

function resolvePreferredPlatformForGuard(defaultModel: string | null): string | null {
  return (
    resolvePlatform(defaultModel ?? undefined) ??
    inferPlatformFromBaseUrl(process.env.OPENAI_BASE_URL) ??
    null
  );
}

function shouldEnableDeferredReplyDrain(session: Session, liveReplyEnabled: boolean): boolean {
  if (session.platform !== 'onebot') return false;
  if (!session.userId || session.userId === session.bot?.selfId) return false;
  if (!session.isDirect) return true;
  return liveReplyEnabled;
}

export function apply(ctx: Context, config: Config = {}): void {
  const services = ctx as unknown as ContextServices;
  const database = services.database;
  const chatlunaService = services.chatluna;
  const inboundStrand = createKeyedStrandRunner();
  const sendStrand = createKeyedStrandRunner();
  const liveReplyRuntime = resolveLiveReplyRuntimeConfig(config);
  const liveReplyCoordinator =
    liveReplyRuntime.enabled && database
      ? new LiveReplyCoordinator({
          runtime: liveReplyRuntime,
          database: database as LiveReplyDatabaseLike,
          clearCache: async (room) => {
            await chatlunaService?.clearCache?.(room as never);
          },
          inject: ({ conversationId, instruction }) => {
            chatlunaService?.contextManager?.inject({
              name: 'qqbot_live_reply_continuation',
              value: instruction,
              once: true,
              conversationId,
              stage: 'after_scratchpad',
            });
          },
          logger,
        })
      : null;
  registerLiveReplyCoordinator(ctx as object, liveReplyCoordinator);

  if (liveReplyRuntime.enabled && !liveReplyCoordinator) {
    logger.warn('live reply is enabled but database service is unavailable, falling back to queue-only behavior.');
  }

  const runWithDeferredKey = async <T>(session: Session, next: () => Promise<T>): Promise<T> => {
    if (!shouldEnableDeferredReplyDrain(session, liveReplyRuntime.enabled)) {
      return next();
    }

    const strandKey = resolveSessionStrandKey(session);
    if (!strandKey) return next();

    const releaseDeferredKey = markDeferredMultilineSendKeyActive(strandKey);
    try {
      return await next();
    } finally {
      releaseDeferredKey();
    }
  };

  ctx.middleware(
    async (session, next) => {
      if (session.platform !== 'onebot') return next();
      if (!session.userId || session.userId === session.bot?.selfId) return next();

      const strandKey = resolveSessionStrandKey(session);
      if (!strandKey) return next();

      if (liveReplyCoordinator?.shouldIntercept(strandKey)) {
        return runWithDeferredKey(session, next);
      }

      return inboundStrand.run(strandKey, async () => {
        return runWithDeferredKey(session, next);
      });
    },
    true,
  );

  ctx.on('before-send', async (session, options) => {
    if (shouldBypassLineSplit(options)) return;
    if (session.platform !== 'onebot') return;
    if (!session.channelId || !session.content) return;
    const plan = parseOutboundMessagePlan(session.content);
    if (hasVoiceSegments(plan)) return;
    if (!plan.segments.length) return;

    const channelId = session.channelId;
    const shouldIntercept =
      plan.segments.length > 1 || plan.segments.some((segment) => segment.kind === 'multiline-block');
    if (!shouldIntercept) return;

    const strandKey = resolveSessionStrandKey(session);
    const { sendWhole, sendLine } = createBotMessageDispatchers(session.bot, channelId, session);
    const sendSegment = async (segment: OutboundMessageSegment) => {
      if (segment.kind === 'multiline-block') {
        await sendWhole(segment.content);
        return;
      }

      await sendLine(segment.content);
    };

    const sendTask = async () => {
      if (strandKey && liveReplyCoordinator && liveReplyRuntime.enabled) {
        await liveReplyCoordinator.drainDraftPlan(strandKey, plan, sendSegment);
        return;
      }

      await dispatchOutboundMessagePlan(plan, sendSegment);
    };

    const queuedSendTask = async () => {
      if (strandKey) {
        await sendStrand.run(strandKey, sendTask);
      } else {
        await sendTask();
      }
    };

    const shouldDeferSend =
      !!strandKey &&
      isDeferredMultilineSendKeyActive(strandKey) &&
      (shouldIntercept || plan.segments.length > 1);

    if (shouldDeferSend) {
      void queuedSendTask().catch((error) => {
        logger.warn('deferred multiline send failed for %s: %s', strandKey, (error as Error).message);
      });
      return true;
    }

    await queuedSendTask();
    return true;
  });

  ctx.on('ready', () => {
    const chatluna = services.chatluna;
    const chain = chatluna?.chatChain;
    if (!chatluna || !chain) {
      logger.warn('chatluna service is not available, skip model guard middleware.');
      return;
    }

    if (liveReplyCoordinator && liveReplyRuntime.enabled) {
      chain
        .middleware('qqbot_live_replan_gate', async (rawSession, rawContext) => {
          const session = rawSession as Session;
          const context = rawContext as MiddlewareContextLike;
          if (session.platform !== 'onebot') return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
          if (!session.userId || session.userId === session.bot?.selfId) {
            return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
          }

          const room = context.options?.room;
          const strandKey = resolveSessionStrandKey(session);
          if (!room || !strandKey) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;

          if (!liveReplyCoordinator.shouldIntercept(strandKey, room)) {
            liveReplyCoordinator.bindScope(strandKey, room, context.options?.messageId);
            return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
          }

          const decision = await liveReplyCoordinator.waitForInterrupt(
            strandKey,
            session,
            room,
            context.options?.messageId,
          );

          return decision === 'stop'
            ? ChatLunaChains.ChainMiddlewareRunStatus.STOP
            : ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        })
        .after('chatluna_time_context')
        .after('read_chat_message')
        .before('message_delay');
    }

    chain
      .middleware('chatluna_time_context', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MiddlewareContextLike;
        const inputMessage = context.options?.inputMessage;
        if (!inputMessage) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        const userName = resolveSessionDisplayName(session);
        inputMessage.content = injectUserStampedPrompt(inputMessage.content, userName);
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('read_chat_message')
      .before('lifecycle-handle_command');

    chain
      .middleware('chatluna_model_guard', async (rawSession, rawContext) => {
        const context = rawContext as MiddlewareContextLike;
        try {
          if ((context.command?.length ?? 0) > 1) {
            return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
          }

          const room = context.options?.room;
          if (!room) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;

          const defaultModel = resolveDefaultModelForGuard();
          const preferredPlatform = resolvePreferredPlatformForGuard(defaultModel);
          const normalizedModel = normalizeRawModelName(room.model, {
            availableModels: listAllLlmModels(chatluna),
            preferredPlatform,
            defaultModel,
          });
          if (normalizedModel && normalizedModel !== room.model?.trim()) {
            room.model = normalizedModel;
            logger.info(
              'normalized room model for guard (roomId=%s, model=%s).',
              String(room.roomId ?? ''),
              normalizedModel,
            );
          }
          if (!room.model) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;

          const platform = resolvePlatform(room.model);
          if (platform && chatluna.awaitLoadPlatform) {
            try {
              await chatluna.awaitLoadPlatform(platform, 15000);
            } catch (error) {
              logger.warn(
                'awaitLoadPlatform failed for %s (roomId=%s): %s',
                platform,
                String(room.roomId ?? ''),
                (error as Error).message,
              );
            }
          }

          let available = false;
          try {
            available = await ChatLunaChains.checkConversationRoomAvailability(ctx, room as never);
          } catch (error) {
            logger.warn(
              'model guard check failed (roomId=%s): %s',
              String(room.roomId ?? ''),
              (error as Error).message,
            );
          }

          if (!available) {
            let fixed = false;
            try {
              fixed = await ChatLunaChains.fixConversationRoomAvailability(
                ctx,
                context.config as never,
                room as never,
              );
            } catch (error) {
              logger.warn(
                'auto-fix unavailable room failed (roomId=%s): %s',
                String(room.roomId ?? ''),
                (error as Error).message,
              );
            }

            if (fixed) {
              logger.info(
                'auto-fixed unavailable room model (roomId=%s, model=%s).',
                String(room.roomId ?? ''),
                String(room.model ?? ''),
              );
            } else {
              logger.warn(
                'room still unavailable after model guard fix (roomId=%s, model=%s), continue to builtin resolver.',
                String(room.roomId ?? ''),
                String(room.model ?? ''),
              );
            }
          }
        } catch (error) {
          logger.warn('model guard middleware failed: %s', (error as Error).message);
        }

        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('resolve_room')
      .before('resolve_model');
  });
}
