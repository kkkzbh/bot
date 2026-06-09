import type { Session } from 'koishi';
import type { MemoryAddress } from '../../types/memory.js';

type RoomLike = {
  conversationId?: string;
};

export type MemoryMiddlewareContextLike = {
  options?: {
    room?: RoomLike;
    inputMessage?: {
      content?: unknown;
    };
  };
};

export function buildMemoryAddress(
  session: Session,
  context: MemoryMiddlewareContextLike,
  observedAt = Date.now(),
): MemoryAddress | null {
  const userId = session.userId?.trim();
  const botSelfId = session.bot?.selfId?.trim() || session.selfId?.trim();
  const platform = session.platform?.trim() || 'unknown';
  const conversationId = context.options?.room?.conversationId?.trim();
  if (!userId || !botSelfId || !conversationId) return null;

  if (session.isDirect) {
    return {
      userKey: `${platform}:user:${userId}`,
      contextKey: `${platform}:bot:${botSelfId}:dm:${userId}`,
      channelType: 'direct',
      platform,
      botSelfId,
      userId,
      groupId: null,
      channelId: session.channelId?.trim() || null,
      rawContextId: session.channelId?.trim() || userId,
      conversationId,
      observedAt,
    };
  }

  const groupKey = session.guildId?.trim() || session.channelId?.trim();
  if (!groupKey) return null;
  return {
    userKey: `${platform}:user:${userId}`,
    contextKey: `${platform}:bot:${botSelfId}:group:${groupKey}`,
    channelType: 'group',
    platform,
    botSelfId,
    userId,
    groupId: session.guildId?.trim() || null,
    channelId: session.channelId?.trim() || null,
    rawContextId: groupKey,
    conversationId,
    observedAt,
  };
}
