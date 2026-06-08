import { type Context, Logger, type Session } from 'koishi';
import {
  buildNaturalTriggerReference,
  formatStructuredLogBlock,
  buildProactiveOpeningState,
  buildUserContextReference,
  resolveUserTurnIntentState,
} from '../reply/index.js';
import {
  resolvePlatform,
} from '../shared/llm/index.js';
import { beginPromptAssemblyTurn, registerPromptFragment } from '../shared/prompt-context/index.js';
import { resolveSessionDisplayName } from '../shared/session/index.js';
import { getNaturalTriggerState } from '../triggers/group-natural/index.js';
import { syncRoomModelToMainChatRuntime } from './hot-switch.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
  checkConversationRoomAvailability: (ctx: Context, room: unknown) => Promise<boolean>;
};

export const name = 'chatluna-model-guard';
export const inject = ['chatluna', 'database'];

export interface Config {}

type ChainHookBuilder = {
  after: (name: string) => ChainHookBuilder;
  before: (name: string) => ChainHookBuilder;
};

type ChatLunaLike = {
  awaitLoadPlatform?: (platform: string, timeout?: number) => Promise<void>;
  clearCache?: (room: RoomLike) => Promise<unknown>;
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

function trimOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
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
        const naturalTrigger = getNaturalTriggerState(session as unknown as Record<string, unknown>);
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
          if (naturalTrigger && !naturalTrigger.explicit) {
            registerPromptFragment(conversationId, {
              source: 'qqbot_natural_trigger',
              title: 'Natural Trigger Context',
              authority: 'reference',
              trust: 'trusted',
              ttl: 'turn',
              payload: {
                kind: 'json',
                value: buildNaturalTriggerReference(naturalTrigger),
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

          const syncResult = await syncRoomModelToMainChatRuntime({
            room,
            clearCache: chatluna.clearCache?.bind(chatluna),
            upsertRoom: (nextRoom) => (
              ctx.database as unknown as { upsert: (table: string, rows: unknown[]) => Promise<unknown> }
            ).upsert('chathub_room', [nextRoom]),
          });
          if (syncResult.changed) {
            logger.info(
              'hot-switched room model for guard (roomId=%s, model=%s, generation=%s, strategy=%s, requestMode=%s).',
              String(room.roomId ?? ''),
              syncResult.canonicalModel,
              String(syncResult.generation),
              syncResult.strategyId,
              syncResult.requestMode,
            );
          }
          logger.info(
            '%s',
            formatStructuredLogBlock('reply-plan-debug', {
              stage: 'model_guard_effective_model',
              roomId: room.roomId ?? null,
              conversationId: trimOptionalText(room.conversationId) ?? null,
              originalRoomModel: syncResult.originalModel,
              effectiveModel: syncResult.canonicalModel,
              effectiveTransportModel: syncResult.transportModel,
              effectiveStrategyId: syncResult.strategyId,
              effectiveRequestMode: syncResult.requestMode,
              effectiveOutputProtocol: syncResult.outputProtocol,
              preset: trimOptionalText(room.preset) ?? null,
            }),
          );
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
            const modelName = trimOptionalText(room.model) ?? 'unknown';
            logger.warn(
              'current main chat model is unavailable (roomId=%s, model=%s).',
              String(room.roomId ?? ''),
              modelName,
            );
            if (context.send) {
              await context.send(`当前主聊天模型不可用：${modelName}`);
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
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
