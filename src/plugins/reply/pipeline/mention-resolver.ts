import type { Session } from 'koishi';
import { normalizeGroupId } from '../../shared/group-id.js';
import type { ReplyMessagePart } from '../../shared/outbound/index.js';
import type { TurnContext } from './types.js';

const INLINE_MENTION_TOKEN_PATTERN =
  /(^|[\s\u3000,，。.!！？?;；:：([{<《【“"'`])([@＠])([^\s@＠]+)(?=[ \t\u3000])/gu;
const MEMBER_CACHE_TTL_MS = 5 * 60 * 1000;

type OneBotGroupMember = {
  user_id?: string | number;
  card?: string;
  nickname?: string;
};

type MentionCandidate = {
  userId: string;
  label: string;
};

type MemberIndex = {
  createdAt: number;
  labels: Map<string, MentionCandidate[]>;
};

type OneBotInternalLike = {
  getGroupMemberList?: (groupId: string | number, noCache?: boolean) => Promise<OneBotGroupMember[]>;
  _request?: (action: string, params: Record<string, unknown>) => Promise<{ data?: OneBotGroupMember[] } | OneBotGroupMember[]>;
};

type MentionSessionLike = Session & {
  bot?: {
    selfId?: string;
    platform?: string;
    internal?: OneBotInternalLike;
  };
};

function normalizeLabel(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function normalizeUserId(value: unknown): string {
  const normalized = normalizeLabel(value);
  return /^\d+$/u.test(normalized) ? normalized : '';
}

function collectMemberLabels(member: OneBotGroupMember): string[] {
  return [
    normalizeUserId(member.user_id),
    normalizeLabel(member.card),
    normalizeLabel(member.nickname),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function buildMemberIndex(members: OneBotGroupMember[]): MemberIndex {
  const labels = new Map<string, MentionCandidate[]>();

  for (const member of members) {
    const userId = normalizeUserId(member.user_id);
    if (!userId) continue;

    for (const label of collectMemberLabels(member)) {
      const candidates = labels.get(label) ?? [];
      if (!candidates.some((candidate) => candidate.userId === userId)) {
        candidates.push({ userId, label });
      }
      labels.set(label, candidates);
    }
  }

  return {
    createdAt: Date.now(),
    labels,
  };
}

function resolveCurrentGroupId(turnContext: TurnContext, session: MentionSessionLike): string | null {
  return normalizeGroupId(turnContext.input.guildId)
    ?? normalizeGroupId(session.guildId)
    ?? normalizeGroupId(turnContext.input.channelId)
    ?? normalizeGroupId(session.channelId);
}

async function requestGroupMembers(
  internal: OneBotInternalLike,
  groupId: string,
  noCache: boolean,
): Promise<OneBotGroupMember[]> {
  if (typeof internal.getGroupMemberList === 'function') {
    return await internal.getGroupMemberList(groupId, noCache);
  }

  if (typeof internal._request === 'function') {
    const response = await internal._request('get_group_member_list', {
      group_id: Number.isFinite(Number(groupId)) ? Number(groupId) : groupId,
      no_cache: noCache,
    });
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.data)) return response.data;
  }

  return [];
}

export class GroupMemberMentionResolver {
  private readonly cache = new Map<string, MemberIndex>();

  async resolveInlineMentions(
    content: string,
    turnContext: TurnContext,
    session: MentionSessionLike,
  ): Promise<ReplyMessagePart[]> {
    if (turnContext.input.isDirect || session.isDirect || turnContext.capabilitySnapshot?.canMention === false) {
      return [{ kind: 'text', content }];
    }

    const groupId = resolveCurrentGroupId(turnContext, session);
    const internal = session.bot?.internal;
    if (!groupId || !internal) {
      return [{ kind: 'text', content }];
    }
    INLINE_MENTION_TOKEN_PATTERN.lastIndex = 0;
    if (!INLINE_MENTION_TOKEN_PATTERN.test(content)) {
      return [{ kind: 'text', content }];
    }
    INLINE_MENTION_TOKEN_PATTERN.lastIndex = 0;

    const cacheKey = `${session.bot?.platform ?? session.platform ?? 'onebot'}:${session.bot?.selfId ?? 'default'}:${groupId}`;
    const cached = await this.getMemberIndex(cacheKey, internal, groupId, false);
    const initial = this.parseContent(content, cached);
    if (!initial.hasUnresolvedMention) return initial.parts;

    const refreshed = await this.getMemberIndex(cacheKey, internal, groupId, true);
    return this.parseContent(content, refreshed).parts;
  }

  private async getMemberIndex(
    cacheKey: string,
    internal: OneBotInternalLike,
    groupId: string,
    refresh: boolean,
  ): Promise<MemberIndex | null> {
    const cached = this.cache.get(cacheKey);
    if (!refresh && cached && Date.now() - cached.createdAt < MEMBER_CACHE_TTL_MS) {
      return cached;
    }

    try {
      const members = await requestGroupMembers(internal, groupId, refresh);
      const index = buildMemberIndex(members);
      this.cache.set(cacheKey, index);
      return index;
    } catch (error) {
      console.warn(`reply-mention-resolver failed to load group member list for group ${groupId}: ${(error as Error).message}`);
      return cached ?? null;
    }
  }

  private resolveLabel(index: MemberIndex | null, label: string): MentionCandidate | null {
    const normalized = normalizeLabel(label);
    if (!normalized || !index) return null;
    const candidates = index.labels.get(normalized) ?? [];
    return candidates.length === 1 ? candidates[0]! : null;
  }

  private parseContent(content: string, index: MemberIndex | null): { parts: ReplyMessagePart[]; hasUnresolvedMention: boolean } {
    const parts: ReplyMessagePart[] = [];
    let cursor = 0;
    let hasUnresolvedMention = false;
    INLINE_MENTION_TOKEN_PATTERN.lastIndex = 0;

    for (const match of content.matchAll(INLINE_MENTION_TOKEN_PATTERN)) {
      const fullMatch = match[0] ?? '';
      const prefix = match[1] ?? '';
      const label = match[3] ?? '';
      const start = match.index ?? 0;
      const mentionStart = start + prefix.length;

      if (mentionStart > cursor) {
        parts.push({ kind: 'text', content: content.slice(cursor, mentionStart) });
      }

      const candidate = this.resolveLabel(index, label);
      if (candidate) {
        parts.push({ kind: 'at', userId: candidate.userId, label: candidate.label });
      } else {
        hasUnresolvedMention = true;
        parts.push({ kind: 'text', content: content.slice(mentionStart, start + fullMatch.length) });
      }

      cursor = start + fullMatch.length;
    }

    if (cursor < content.length) {
      parts.push({ kind: 'text', content: content.slice(cursor) });
    }

    return {
      parts: parts.length ? parts : [{ kind: 'text', content }],
      hasUnresolvedMention,
    };
  }
}
