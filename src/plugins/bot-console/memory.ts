import type {
  BotConsoleMemoryEpisodeItem,
  BotConsoleMemoryFactItem,
  BotConsoleMemoryJobItem,
  BotConsoleMemoryScopeSummary,
  BotConsoleMemoryState,
} from '../../types/bot-console.js';
import type {
  MemoryEpisodeRecord,
  MemoryFactRecord,
  MemoryJobRecord,
  MemoryScopeType,
} from '../../types/memory-v2.js';

type MemoryDatabaseLike = {
  get(table: string, query: Record<string, unknown>): Promise<any[]>;
};

type ScopeParts = {
  platform: string | null;
  botSelfId: string | null;
  groupId: string | null;
  userId: string | null;
};

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  } catch {
    return [];
  }
}

function parseScopeKey(scopeKey: string): ScopeParts {
  const parts = String(scopeKey ?? '').split(':');
  if (parts.length >= 4 && parts[2] === 'user') {
    return {
      platform: parts[0] || null,
      botSelfId: parts[1] || null,
      groupId: null,
      userId: parts[3] || null,
    };
  }

  if (parts.length >= 6 && parts[2] === 'group' && parts[4] === 'user') {
    return {
      platform: parts[0] || null,
      botSelfId: parts[1] || null,
      groupId: parts[3] || null,
      userId: parts[5] || null,
    };
  }

  return {
    platform: null,
    botSelfId: null,
    groupId: null,
    userId: null,
  };
}

function buildScopeLabel(scopeType: MemoryScopeType, scopeKey: string): string {
  const parsed = parseScopeKey(scopeKey);
  if (scopeType === 'user') {
    return parsed.userId ? `私聊用户 ${parsed.userId}` : scopeKey;
  }
  if (parsed.groupId && parsed.userId) {
    return `群 ${parsed.groupId} / 用户 ${parsed.userId}`;
  }
  return scopeKey;
}

function toFactItem(row: MemoryFactRecord): BotConsoleMemoryFactItem {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeKey: row.scopeKey,
    topicKey: row.topicKey,
    content: row.content,
    keywords: parseStringArray(row.keywords),
    importance: Number(row.importance ?? 0),
    confidence: Number(row.confidence ?? 0),
    firstSeenAt: Number(row.firstSeenAt ?? 0),
    lastSeenAt: Number(row.lastSeenAt ?? row.firstSeenAt ?? 0),
    hasEmbedding: Boolean(row.embedding),
    archived: Number(row.archived ?? 0) === 1,
  };
}

function toEpisodeItem(row: MemoryEpisodeRecord): BotConsoleMemoryEpisodeItem {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeKey: row.scopeKey,
    title: row.title,
    summary: row.summary,
    keywords: parseStringArray(row.keywords),
    importance: Number(row.importance ?? 0),
    confidence: Number(row.confidence ?? 0),
    periodStart: row.periodStart == null ? null : Number(row.periodStart),
    periodEnd: row.periodEnd == null ? null : Number(row.periodEnd),
    firstSeenAt: Number(row.firstSeenAt ?? 0),
    lastSeenAt: Number(row.lastSeenAt ?? row.firstSeenAt ?? 0),
    lastAccessedAt: row.lastAccessedAt == null ? null : Number(row.lastAccessedAt),
    hasEmbedding: Boolean(row.embedding),
    archived: Number(row.archived ?? 0) === 1,
  };
}

function toJobItem(row: MemoryJobRecord): BotConsoleMemoryJobItem {
  let scopeType: MemoryScopeType | null = null;
  let scopeKey: string | null = null;
  let conversationId: string | null = null;

  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    if (payload.scopeType === 'user' || payload.scopeType === 'user_group') {
      scopeType = payload.scopeType;
    }
    if (typeof payload.scopeKey === 'string' && payload.scopeKey.trim()) {
      scopeKey = payload.scopeKey.trim();
    }
    if (typeof payload.conversationId === 'string' && payload.conversationId.trim()) {
      conversationId = payload.conversationId.trim();
    }
  } catch {
    // Keep nullable fields empty for malformed payloads.
  }

  return {
    id: row.id,
    jobType: row.jobType,
    status: row.status,
    scopeType,
    scopeKey,
    conversationId,
    retryCount: Number(row.retryCount ?? 0),
    nextRunAt: Number(row.nextRunAt ?? 0),
    createdAt: Number(row.createdAt ?? 0),
    updatedAt: Number(row.updatedAt ?? 0),
    lastError: row.lastError ?? null,
  };
}

function buildScopeSummaries(
  facts: BotConsoleMemoryFactItem[],
  episodes: BotConsoleMemoryEpisodeItem[],
): BotConsoleMemoryScopeSummary[] {
  const scopeMap = new Map<string, BotConsoleMemoryScopeSummary>();

  const ensureScope = (scopeType: MemoryScopeType, scopeKey: string): BotConsoleMemoryScopeSummary => {
    const existing = scopeMap.get(scopeKey);
    if (existing) return existing;
    const parsed = parseScopeKey(scopeKey);
    const created: BotConsoleMemoryScopeSummary = {
      scopeType,
      scopeKey,
      platform: parsed.platform,
      botSelfId: parsed.botSelfId,
      userId: parsed.userId,
      groupId: parsed.groupId,
      label: buildScopeLabel(scopeType, scopeKey),
      factCount: 0,
      episodeCount: 0,
      latestSeenAt: null,
    };
    scopeMap.set(scopeKey, created);
    return created;
  };

  for (const fact of facts) {
    const scope = ensureScope(fact.scopeType, fact.scopeKey);
    scope.factCount += 1;
    scope.latestSeenAt = Math.max(scope.latestSeenAt ?? 0, fact.lastSeenAt || 0);
  }

  for (const episode of episodes) {
    const scope = ensureScope(episode.scopeType, episode.scopeKey);
    scope.episodeCount += 1;
    scope.latestSeenAt = Math.max(scope.latestSeenAt ?? 0, episode.lastSeenAt || 0);
  }

  return [...scopeMap.values()].sort((left, right) => {
    const leftTotal = left.factCount + left.episodeCount;
    const rightTotal = right.factCount + right.episodeCount;
    if (rightTotal !== leftTotal) return rightTotal - leftTotal;
    return (right.latestSeenAt ?? 0) - (left.latestSeenAt ?? 0);
  });
}

export function createUnavailableMemoryState(): BotConsoleMemoryState {
  return {
    available: false,
    summary: {
      scopeCount: 0,
      userScopeCount: 0,
      userGroupScopeCount: 0,
      factCount: 0,
      episodeCount: 0,
      pendingJobs: 0,
      processingJobs: 0,
    },
    scopes: [],
    facts: [],
    episodes: [],
    jobs: [],
  };
}

export async function buildMemoryState(database?: MemoryDatabaseLike | null): Promise<BotConsoleMemoryState> {
  if (!database?.get) {
    return createUnavailableMemoryState();
  }

  const [factRows, episodeRows, jobRows] = await Promise.all([
    database.get('memory_fact', {} as Record<string, never>) as Promise<MemoryFactRecord[]>,
    database.get('memory_episode', {} as Record<string, never>) as Promise<MemoryEpisodeRecord[]>,
    database.get('memory_job', {} as Record<string, never>) as Promise<MemoryJobRecord[]>,
  ]);

  const facts = factRows.map(toFactItem).sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  const episodes = episodeRows.map(toEpisodeItem).sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  const jobs = jobRows.map(toJobItem).sort((left, right) => right.updatedAt - left.updatedAt);
  const scopes = buildScopeSummaries(facts, episodes);

  return {
    available: true,
    summary: {
      scopeCount: scopes.length,
      userScopeCount: scopes.filter((item) => item.scopeType === 'user').length,
      userGroupScopeCount: scopes.filter((item) => item.scopeType === 'user_group').length,
      factCount: facts.length,
      episodeCount: episodes.length,
      pendingJobs: jobs.filter((item) => item.status === 'pending').length,
      processingJobs: jobs.filter((item) => item.status === 'processing').length,
    },
    scopes,
    facts,
    episodes,
    jobs,
  };
}
