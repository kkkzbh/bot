export type QqbotChatLunaRoomLike = {
  conversationId?: string;
  roomId?: number | string;
  model?: string;
  preset?: string;
  chatMode?: string;
  [key: string]: unknown;
};

type ChatLunaConversationRecordLike = {
  id?: unknown;
  legacyRoomId?: unknown;
  model?: unknown;
  preset?: unknown;
  chatMode?: unknown;
};

type ChatLunaConversationResolutionLike = {
  mode?: unknown;
  conversationId?: unknown;
  conversation?: ChatLunaConversationRecordLike | null;
  bindingKey?: unknown;
  presetLane?: unknown;
  effectiveModel?: unknown;
  effectivePreset?: unknown;
  effectiveChatMode?: unknown;
  constraint?: unknown;
};

export type QqbotChatLunaContextOptionsLike = {
  room?: QqbotChatLunaRoomLike;
  conversation?: ChatLunaConversationResolutionLike | null;
};

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function resolveChatLunaRoomLike(
  options: QqbotChatLunaContextOptionsLike | undefined,
): QqbotChatLunaRoomLike | undefined {
  const conversation = options?.conversation?.conversation;
  const conversationId =
    normalizeString(conversation?.id) ??
    normalizeString(options?.conversation?.conversationId);

  if (conversationId) {
    return {
      ...(options?.room ?? {}),
      conversationId,
      roomId: typeof conversation?.legacyRoomId === 'number' ? conversation.legacyRoomId : options?.room?.roomId,
      model: normalizeString(options?.conversation?.effectiveModel) ?? normalizeString(conversation?.model) ?? options?.room?.model,
      preset: normalizeString(options?.conversation?.effectivePreset) ?? normalizeString(conversation?.preset) ?? options?.room?.preset,
      chatMode: normalizeString(options?.conversation?.effectiveChatMode) ?? normalizeString(conversation?.chatMode) ?? options?.room?.chatMode,
    };
  }

  const roomConversationId = normalizeString(options?.room?.conversationId);
  if (!roomConversationId) return undefined;
  return {
    ...options?.room,
    conversationId: roomConversationId,
  };
}
