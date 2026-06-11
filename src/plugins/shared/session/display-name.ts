type SessionAuthorLike = {
  nick?: string;
  name?: string;
  avatar?: string | null;
};

type SessionLike = {
  author?: SessionAuthorLike;
  username?: string;
  userId?: string;
  platform?: string;
  event?: {
    user?: {
      avatar?: string | null;
    } | null;
  } | null;
};

const INVISIBLE_OR_CONTROL_RE = /[\p{Cf}\p{Cc}\p{Cs}]/gu;

function normalizeDisplayNameCandidate(value?: string): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';

  // Filter out zero-width / control-only names (e.g. U+2062 "⁢"),
  // then fall back to another identifier.
  const visibleText = trimmed.replace(INVISIBLE_OR_CONTROL_RE, '').trim();
  if (!visibleText) return '';
  return trimmed;
}

export function resolveSessionDisplayName(session: SessionLike): string {
  return (
    normalizeDisplayNameCandidate(session.author?.nick) ||
    normalizeDisplayNameCandidate(session.username) ||
    normalizeDisplayNameCandidate(session.author?.name) ||
    normalizeDisplayNameCandidate(session.userId) ||
    '用户'
  );
}

export function resolveSessionQqNick(session: SessionLike): string {
  return (
    normalizeDisplayNameCandidate(session.author?.name) ||
    normalizeDisplayNameCandidate(session.username) ||
    normalizeDisplayNameCandidate(session.userId) ||
    '用户'
  );
}

export function deriveOneBotAvatarUrl(userId?: string | null): string | null {
  const normalized = normalizeDisplayNameCandidate(userId ?? '');
  if (!/^\d+$/.test(normalized)) return null;
  return `https://q.qlogo.cn/headimg_dl?dst_uin=${normalized}&spec=100`;
}

export function resolveSessionAvatarUrl(session: SessionLike): string | null {
  const eventAvatar = normalizeDisplayNameCandidate(session.event?.user?.avatar ?? '');
  if (eventAvatar) return eventAvatar;
  const authorAvatar = normalizeDisplayNameCandidate(session.author?.avatar ?? '');
  if (authorAvatar) return authorAvatar;
  if ((session.platform ?? '').trim() === 'onebot') return deriveOneBotAvatarUrl(session.userId);
  return null;
}
