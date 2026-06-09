import type {
  BotConsoleMemoryAuditItem,
  BotConsoleMemoryEpisodeItem,
  BotConsoleMemoryFactItem,
  BotConsoleMemoryJobItem,
  BotConsoleMemoryPendingReviewItem,
  BotConsoleMemoryState,
  BotConsoleMemoryUserItem,
} from '../../types/bot-console.js';
import type {
  MemoryAuditEventRecord,
  MemoryCandidateV3Record,
  MemoryContextRecord,
  MemoryEpisodeV3Record,
  MemoryFactV3Record,
  MemoryJobV3Record,
  MemoryProvenanceRecord,
  MemoryUserRecord,
  MemoryV3StatusSnapshot,
} from '../../types/memory-v3.js';

type MemoryDatabaseLike = {
  get(table: string, query: Record<string, unknown>): Promise<any[]>;
};

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  } catch {
    return [];
  }
}

function userLabel(row: Pick<MemoryUserRecord, 'userKey' | 'userId'>): string {
  return row.userId ? `用户 ${row.userId}` : row.userKey;
}

function toFactItem(row: MemoryFactV3Record): BotConsoleMemoryFactItem {
  return {
    id: row.id,
    userKey: row.userKey,
    sourceContextKey: row.sourceContextKey,
    kind: row.kind,
    topicKey: row.topicKey,
    content: row.content,
    keywords: parseJsonArray(row.keywords),
    importance: Number(row.importance ?? 0),
    confidence: Number(row.confidence ?? 0),
    sensitivity: row.sensitivity,
    visibility: row.visibility,
    firstSeenAt: Number(row.firstSeenAt ?? 0),
    lastSeenAt: Number(row.lastSeenAt ?? row.firstSeenAt ?? 0),
    lastAccessedAt: row.lastAccessedAt == null ? null : Number(row.lastAccessedAt),
    hasEmbedding: Boolean(row.embedding),
    archived: Number(row.archived ?? 0) === 1,
    conflictSetId: row.conflictSetId ?? null,
  };
}

function toEpisodeItem(row: MemoryEpisodeV3Record): BotConsoleMemoryEpisodeItem {
  return {
    id: row.id,
    userKey: row.userKey,
    sourceContextKey: row.sourceContextKey,
    title: row.title,
    summary: row.summary,
    keywords: parseJsonArray(row.keywords),
    importance: Number(row.importance ?? 0),
    confidence: Number(row.confidence ?? 0),
    sensitivity: row.sensitivity,
    visibility: row.visibility,
    periodStart: row.periodStart == null ? null : Number(row.periodStart),
    periodEnd: row.periodEnd == null ? null : Number(row.periodEnd),
    firstSeenAt: Number(row.firstSeenAt ?? 0),
    lastSeenAt: Number(row.lastSeenAt ?? row.firstSeenAt ?? 0),
    lastAccessedAt: row.lastAccessedAt == null ? null : Number(row.lastAccessedAt),
    hasEmbedding: Boolean(row.embedding),
    archived: Number(row.archived ?? 0) === 1,
    conflictSetId: row.conflictSetId ?? null,
  };
}

function toPendingReviewItem(row: MemoryCandidateV3Record): BotConsoleMemoryPendingReviewItem {
  return {
    id: row.id,
    batchId: row.batchId,
    candidateType: row.candidateType,
    userKey: row.userKey,
    contextKey: row.contextKey,
    conversationId: row.conversationId,
    payload: row.payload,
    sensitivity: row.sensitivity,
    suggestedVisibility: row.suggestedVisibility,
    finalVisibility: row.finalVisibility,
    dropReason: row.dropReason,
    providerRoute: row.providerRoute,
    createdAt: Number(row.createdAt ?? 0),
  };
}

function toJobItem(row: MemoryJobV3Record): BotConsoleMemoryJobItem {
  let userKey: string | null = null;
  let contextKey: string | null = null;
  let conversationId: string | null = null;
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const address = payload.address && typeof payload.address === 'object'
      ? payload.address as Record<string, unknown>
      : null;
    userKey = typeof address?.userKey === 'string' ? address.userKey : null;
    contextKey = typeof address?.contextKey === 'string' ? address.contextKey : null;
    conversationId = typeof address?.conversationId === 'string' ? address.conversationId : null;
  } catch {
    // Keep nullable metadata empty for malformed payloads.
  }
  return {
    id: row.id,
    jobType: row.jobType,
    status: row.status,
    userKey,
    contextKey,
    conversationId,
    retryCount: Number(row.retryCount ?? 0),
    nextRunAt: Number(row.nextRunAt ?? 0),
    lockedAt: row.lockedAt == null ? null : Number(row.lockedAt),
    createdAt: Number(row.createdAt ?? 0),
    updatedAt: Number(row.updatedAt ?? 0),
    lastError: row.lastError ?? null,
  };
}

function toAuditItem(row: MemoryAuditEventRecord): BotConsoleMemoryAuditItem {
  return {
    id: row.id,
    userKey: row.userKey,
    contextKey: row.contextKey,
    eventType: row.eventType,
    memoryType: row.memoryType,
    memoryId: row.memoryId,
    candidateId: row.candidateId,
    turnId: row.turnId,
    detail: row.detail,
    createdAt: Number(row.createdAt ?? 0),
  };
}

function buildUserItems(input: {
  users: MemoryUserRecord[];
  facts: BotConsoleMemoryFactItem[];
  episodes: BotConsoleMemoryEpisodeItem[];
  pendingReview: BotConsoleMemoryPendingReviewItem[];
}): BotConsoleMemoryUserItem[] {
  const byUser = new Map<string, BotConsoleMemoryUserItem>();
  for (const user of input.users) {
    byUser.set(user.userKey, {
      userKey: user.userKey,
      platform: user.platform ?? null,
      userId: user.userId ?? null,
      label: userLabel(user),
      factCount: 0,
      episodeCount: 0,
      pendingReviewCount: 0,
      readEnabled: Number(user.readEnabled ?? 1) === 1,
      writeEnabled: Number(user.writeEnabled ?? 1) === 1,
      latestSeenAt: Number(user.lastSeenAt ?? user.firstSeenAt ?? 0) || null,
    });
  }

  const ensure = (userKey: string): BotConsoleMemoryUserItem => {
    const existing = byUser.get(userKey);
    if (existing) return existing;
    const created: BotConsoleMemoryUserItem = {
      userKey,
      platform: userKey.split(':')[0] || null,
      userId: userKey.split(':').at(-1) ?? null,
      label: userKey,
      factCount: 0,
      episodeCount: 0,
      pendingReviewCount: 0,
      readEnabled: true,
      writeEnabled: true,
      latestSeenAt: null,
    };
    byUser.set(userKey, created);
    return created;
  };

  for (const fact of input.facts) {
    const user = ensure(fact.userKey);
    user.factCount += 1;
    user.latestSeenAt = Math.max(user.latestSeenAt ?? 0, fact.lastSeenAt || 0);
  }
  for (const episode of input.episodes) {
    const user = ensure(episode.userKey);
    user.episodeCount += 1;
    user.latestSeenAt = Math.max(user.latestSeenAt ?? 0, episode.lastSeenAt || 0);
  }
  for (const pending of input.pendingReview) {
    ensure(pending.userKey).pendingReviewCount += 1;
  }

  return [...byUser.values()].sort((left, right) => {
    const totalDelta = right.factCount + right.episodeCount + right.pendingReviewCount - (left.factCount + left.episodeCount + left.pendingReviewCount);
    if (totalDelta !== 0) return totalDelta;
    return (right.latestSeenAt ?? 0) - (left.latestSeenAt ?? 0);
  });
}

export function createUnavailableMemoryState(status: MemoryV3StatusSnapshot | null = null): BotConsoleMemoryState {
  return {
    available: false,
    summary: {
      userCount: 0,
      factCount: 0,
      episodeCount: 0,
      pendingReviewCount: 0,
      pendingJobs: 0,
      processingJobs: 0,
      deadLetterJobs: 0,
    },
    users: [],
    selectedUser: null,
    facts: [],
    episodes: [],
    pendingReview: [],
    jobs: [],
    audit: [],
    provenanceCount: 0,
    status,
    providerRoutes: status?.providerRoutes ?? [],
    recentFailures: [],
  };
}

export async function buildMemoryState(
  database?: MemoryDatabaseLike | null,
  status: MemoryV3StatusSnapshot | null = null,
): Promise<BotConsoleMemoryState> {
  if (!database?.get) return createUnavailableMemoryState(status);

  const [
    userRows,
    contextRows,
    factRows,
    episodeRows,
    candidateRows,
    jobRows,
    auditRows,
    provenanceRows,
  ] = await Promise.all([
    database.get('memory_user', {} as Record<string, never>) as Promise<MemoryUserRecord[]>,
    database.get('memory_context', {} as Record<string, never>) as Promise<MemoryContextRecord[]>,
    database.get('memory_fact_v3', {} as Record<string, never>) as Promise<MemoryFactV3Record[]>,
    database.get('memory_episode_v3', {} as Record<string, never>) as Promise<MemoryEpisodeV3Record[]>,
    database.get('memory_candidate_v3', {} as Record<string, never>) as Promise<MemoryCandidateV3Record[]>,
    database.get('memory_job_v3', {} as Record<string, never>) as Promise<MemoryJobV3Record[]>,
    database.get('memory_audit_event', {} as Record<string, never>) as Promise<MemoryAuditEventRecord[]>,
    database.get('memory_provenance', {} as Record<string, never>) as Promise<MemoryProvenanceRecord[]>,
  ]);

  void contextRows;
  const facts = factRows.map(toFactItem).sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  const episodes = episodeRows.map(toEpisodeItem).sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  const pendingReview = candidateRows
    .filter((row) => row.reviewStatus === 'pending_review')
    .map(toPendingReviewItem)
    .sort((left, right) => right.createdAt - left.createdAt);
  const jobs = jobRows.map(toJobItem).sort((left, right) => right.updatedAt - left.updatedAt);
  const audit = auditRows.map(toAuditItem).sort((left, right) => right.createdAt - left.createdAt).slice(0, 200);
  const users = buildUserItems({ users: userRows, facts, episodes, pendingReview });
  const recentFailures = [
    ...jobs.filter((job) => job.lastError).map((job) => `${job.jobType}: ${job.lastError}`),
    ...audit.filter((item) => item.eventType.includes('failed')).map((item) => item.detail ?? item.eventType),
  ].slice(0, 20);

  return {
    available: true,
    summary: {
      userCount: users.length,
      factCount: facts.length,
      episodeCount: episodes.length,
      pendingReviewCount: pendingReview.length,
      pendingJobs: jobs.filter((item) => item.status === 'pending').length,
      processingJobs: jobs.filter((item) => item.status === 'processing').length,
      deadLetterJobs: jobs.filter((item) => item.status === 'dead_letter').length,
    },
    users,
    selectedUser: users[0]?.userKey ?? null,
    facts,
    episodes,
    pendingReview,
    jobs,
    audit,
    provenanceCount: provenanceRows.length,
    status,
    providerRoutes: status?.providerRoutes ?? [],
    recentFailures,
  };
}
