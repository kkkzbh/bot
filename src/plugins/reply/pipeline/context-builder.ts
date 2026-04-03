import type { Session } from 'koishi';
import type { PromptFragment } from '../../shared/prompt-context/types.js';
import { resolveSessionDisplayName } from '../../shared/session/index.js';
import { normalizeMentionLikeText } from '../../shared/mention-text.js';
import type { ReplyRuntimeRoomLike } from '../runtime/index.js';
import { classifyReplyRoute, type ReplyRoute, type TurnContext, type TurnInput } from './types.js';

type SessionWithContent = Session & {
  stripped?: { content?: string };
};

type InputMessageLike = {
  content?: unknown;
} | null | undefined;

type ContentPart = {
  type?: unknown;
  text?: unknown;
};

function sanitizeInputText(text: string): string {
  return text
    .replace(/\[CQ:reply,[^\]]+\]/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/\[CQ:image,[^\]]+\]/gi, ' ')
}

function normalizeInputText(text: string): string {
  return sanitizeInputText(normalizeMentionLikeText(text))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

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

function collectInputContentInfo(content: unknown): { text: string; imageCount: number } {
  if (typeof content === 'string') {
    return { text: normalizeInputText(content), imageCount: 0 };
  }

  if (!Array.isArray(content)) {
    return { text: '', imageCount: 0 };
  }

  let text = '';
  let imageCount = 0;

  for (const part of content as ContentPart[]) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      text += part.text;
      continue;
    }
    if (part.type === 'image_url') {
      imageCount += 1;
    }
  }

  return { text: normalizeInputText(text), imageCount };
}

export function buildReplyTurnInput(
  session: SessionWithContent,
  room?: Pick<ReplyRuntimeRoomLike, 'conversationId'> | null,
  inputMessage?: InputMessageLike,
): TurnInput {
  const stripped = typeof session.stripped?.content === 'string' ? session.stripped.content : '';
  const { text: inputMessageText, imageCount } = collectInputContentInfo(inputMessage?.content);
  const rawText = inputMessageText.trim() || normalizeInputText(stripped) || normalizeInputText(String(session.content ?? ''));
  return {
    text: rawText,
    hasImageInput: imageCount > 0,
    imageCount,
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
