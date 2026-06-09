export interface ParsedMemoryV2Scope {
  scopeType: 'user' | 'user_group';
  scopeKey: string;
  platform: string;
  botSelfId: string;
  userId: string;
  groupId: string | null;
  userKey: string;
  contextKey: string;
}

export function parseMemoryV2Scope(scopeType: string, scopeKey: string): ParsedMemoryV2Scope | null {
  const parts = String(scopeKey ?? '').split(':');
  if (scopeType === 'user' && parts.length >= 4 && parts[2] === 'user') {
    const platform = parts[0] || 'unknown';
    const botSelfId = parts[1] || 'bot';
    const userId = parts[3];
    if (!userId) return null;
    return {
      scopeType: 'user',
      scopeKey,
      platform,
      botSelfId,
      userId,
      groupId: null,
      userKey: `${platform}:user:${userId}`,
      contextKey: `${platform}:bot:${botSelfId}:dm:${userId}`,
    };
  }

  if (scopeType === 'user_group' && parts.length >= 6 && parts[2] === 'group' && parts[4] === 'user') {
    const platform = parts[0] || 'unknown';
    const botSelfId = parts[1] || 'bot';
    const groupId = parts[3];
    const userId = parts[5];
    if (!groupId || !userId) return null;
    return {
      scopeType: 'user_group',
      scopeKey,
      platform,
      botSelfId,
      userId,
      groupId,
      userKey: `${platform}:user:${userId}`,
      contextKey: `${platform}:bot:${botSelfId}:group:${groupId}`,
    };
  }

  return null;
}
