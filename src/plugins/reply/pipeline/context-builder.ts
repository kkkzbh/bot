import type { Session } from 'koishi';
import type { PromptFragment } from '../../shared/prompt-context/types.js';
import { resolveSessionDisplayName } from '../../shared/session/index.js';
import type { ReplyRuntimeRoomLike } from '../runtime/index.js';
import { classifyReplyRoute, type ReplyRoute, type TurnContext, type TurnInput } from './types.js';

type SessionWithContent = Session & {
  stripped?: { content?: string };
};

export interface BuildReplyTurnContextOptions {
  room?: ReplyRuntimeRoomLike | null;
  promptFragments?: PromptFragment[];
  capabilitySnapshot?: TurnContext['capabilitySnapshot'];
  continuationContext?: TurnContext['continuationContext'];
  routeHint?: ReplyRoute | null;
}

export function normalizeReplyRouteHint(chatMode: unknown): ReplyRoute | null {
  const value = String(chatMode ?? '').trim();
  if (!value) return null;
  if (value === 'agent') return 'agent';
  if (value === 'automation') return 'automation';
  return null;
}

export function buildReplyTurnInput(
  session: SessionWithContent,
  room?: Pick<ReplyRuntimeRoomLike, 'conversationId'> | null,
): TurnInput {
  const stripped = typeof session.stripped?.content === 'string' ? session.stripped.content : '';
  const rawText = stripped.trim() || String(session.content ?? '').trim();
  return {
    text: rawText,
    displayName: resolveSessionDisplayName(session),
    userId: session.userId?.trim() || '用户',
    isDirect: Boolean(session.isDirect),
    messageId: typeof session.messageId === 'string' && session.messageId.trim() ? session.messageId.trim() : null,
    channelId: typeof session.channelId === 'string' && session.channelId.trim() ? session.channelId.trim() : null,
    guildId: typeof session.guildId === 'string' && session.guildId.trim() ? session.guildId.trim() : null,
    conversationId: room?.conversationId?.trim() || null,
  };
}

export function buildReplyTurnContext(
  turnInput: TurnInput,
  options: BuildReplyTurnContextOptions = {},
): { route: ReplyRoute; turnContext: TurnContext } {
  const route = classifyReplyRoute(turnInput, options.routeHint ?? null);
  return {
    route,
    turnContext: {
      input: turnInput,
      promptFragments: [...(options.promptFragments ?? [])],
      capabilitySnapshot: options.capabilitySnapshot ?? null,
      policySnapshot: {
        route,
        toolRouteProfile: route === 'agent' ? route : null,
      },
      continuationContext: options.continuationContext ?? null,
    },
  };
}
