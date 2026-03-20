import { type Context, Logger, type Session } from 'koishi';
import {
  buildProactiveOpeningState,
  buildUserContextReference,
  resolveUserTurnIntentState,
} from '../reply/index.js';
import { inferPlatformFromBaseUrl, normalizeRawModelName, resolvePlatform } from '../shared/llm/index.js';
import { beginPromptAssemblyTurn, registerPromptFragment } from '../shared/prompt-context/index.js';
import { resolveSessionDisplayName } from '../shared/session/index.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
  checkConversationRoomAvailability: (ctx: Context, room: unknown) => Promise<boolean>;
  fixConversationRoomAvailability: (ctx: Context, config: unknown, room: unknown) => Promise<boolean>;
};
const ChatLunaPlatformTypes = require('koishi-plugin-chatluna/llm-core/platform/types') as {
  ModelType?: { llm?: number };
};

export const name = 'chatluna-model-guard';
export const inject = ['chatluna'];

export interface Config {}

type ChainHookBuilder = {
  after: (name: string) => ChainHookBuilder;
  before: (name: string) => ChainHookBuilder;
};

type ChatLunaLike = {
  awaitLoadPlatform?: (platform: string, timeout?: number) => Promise<void>;
  platform?: {
    listAllModels?: (type: number) => { value?: Array<{ toModelName?: () => string; platform?: string; name?: string }> };
  };
  chatChain?: {
    middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => ChainHookBuilder;
  };
};

type ContextServices = { chatluna?: ChatLunaLike };

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

export function apply(ctx: Context, config: Config = {}): void {
  const services = ctx as unknown as ContextServices;
  void config;

  ctx.on('ready', () => {
    const chatluna = services.chatluna;
    const chain = chatluna?.chatChain;
    if (!chatluna || !chain) {
      logger.warn('chatluna service is not available, skip model guard middleware.');
      return;
    }

    chain
      .middleware('chatluna_time_context', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MiddlewareContextLike;
        const inputMessage = context.options?.inputMessage;
        if (!inputMessage) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        const conversationId = context.options?.room?.conversationId?.trim();
        if (conversationId) {
          beginPromptAssemblyTurn(conversationId);
        }
        const turnIntent = resolveUserTurnIntentState(session.stripped?.content, inputMessage.content);
        const userName = resolveSessionDisplayName(session);
        const contextReference = buildUserContextReference(userName);
        if (conversationId) {
          registerPromptFragment(conversationId, {
            source: 'chatluna_time_context',
            title: 'User Turn Metadata',
            authority: 'reference',
            trust: 'trusted',
            ttl: 'turn',
            payload: {
              kind: 'json',
              value: contextReference,
            },
          });
          if (turnIntent.mode === 'proactive_opening') {
            registerPromptFragment(conversationId, {
              source: 'qqbot_proactive_opening_mode',
              title: 'Proactive Opening State',
              authority: 'assistant_state',
              trust: 'trusted',
              ttl: 'turn',
              payload: {
                kind: 'json',
                value: buildProactiveOpeningState(turnIntent),
              },
            });
          }
        }
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
