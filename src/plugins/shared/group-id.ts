export function normalizeGroupId(input?: string | null): string | null {
  if (!input) return null;
  const value = String(input).trim();
  if (!value) return null;
  if (value.startsWith('group:')) return value.slice('group:'.length);
  if (value.startsWith('guild:')) return value.slice('guild:'.length);
  return value;
}

export type GroupScopeSessionLike = {
  platform?: string | null;
  bot?: { selfId?: string | null } | null;
  guildId?: string | null;
  channelId?: string | null;
  isDirect?: boolean;
};

export function buildGroupSessionScopeKey(session: GroupScopeSessionLike): string | null {
  if (session.isDirect) return null;

  const groupId = normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
  if (!groupId) return null;

  const platform = session.platform?.trim();
  if (!platform) return null;

  const botSelfId = session.bot?.selfId?.trim();
  if (!botSelfId) return null;

  return `${platform}:${botSelfId}:group:${groupId}`;
}

export function parseGroupSet(value?: string[] | string): Set<string> {
  if (!value) return new Set<string>();
  if (Array.isArray(value)) {
    return new Set(value.map((item) => normalizeGroupId(item)).filter((item): item is string => Boolean(item)));
  }
  return new Set(
    value
      .split(',')
      .map((item) => normalizeGroupId(item))
      .filter((item): item is string => Boolean(item)),
  );
}
