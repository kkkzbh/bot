import type { Context } from 'koishi';
import type {
  MemoryAttributionStatus,
  MemoryChannelType,
  MemoryProfileKind,
  MemoryScopeType,
  MemorySensitivity,
  MemoryVisibility,
} from '../../types/memory.js';
import { parseJsonArray, slugify, stringifyStringArray } from './format.js';
import { buildMemoryKey, isMemoryScopeType, scopeKeyForType, scopeTypeFromVisibility, sourceKindFromContextKey } from './scope.js';
import type { MemoryDatabaseLike } from './store.js';

export const LEGACY_MEMORY_TABLES = {
  candidate: 'memory_candidate_v3',
  fact: 'memory_fact_v3',
  episode: 'memory_episode_v3',
  profile: 'memory_profile_v4',
  source: 'memory_source_v4',
  job: 'memory_job_v3',
} as const;

type LegacyOwnedRow = {
  id?: number;
  userKey?: string | null;
  ownerUserKey?: string | null;
  sourceKind?: string | null;
  sourceContextKey?: string | null;
  contextKey?: string | null;
  visibility?: string | null;
  scopeType?: string | null;
  scopeKey?: string | null;
  targetSpeakerId?: string | null;
  targetSpeakerName?: string | null;
  evidenceMessageIds?: string | null;
  evidenceSpeakerIds?: string | null;
  attributionStatus?: string | null;
  allowedContextKeys?: string | null;
  deniedContextKeys?: string | null;
  validFrom?: number | null;
  validUntil?: number | null;
  expiresAt?: number | null;
  firstSeenAt?: number | null;
  lastSeenAt?: number | null;
  lastAccessedAt?: number | null;
  version?: number | null;
  archived?: number | null;
  supersedesId?: number | null;
  conflictSetId?: string | null;
};

type LegacyFactRow = LegacyOwnedRow & {
  kind?: string | null;
  topicKey?: string | null;
  content?: string | null;
  keywords?: string | null;
  importance?: number | null;
  confidence?: number | null;
  sensitivity?: string | null;
  applicability?: string | null;
  embeddingModel?: string | null;
  embedding?: string | null;
  memoryKey?: string | null;
  retrievalText?: string | null;
  lastUsedReason?: string | null;
  invalidatedAt?: number | null;
};

type LegacyEpisodeRow = LegacyOwnedRow & {
  title?: string | null;
  summary?: string | null;
  keywords?: string | null;
  importance?: number | null;
  confidence?: number | null;
  sensitivity?: string | null;
  applicability?: string | null;
  periodStart?: number | null;
  periodEnd?: number | null;
  embeddingModel?: string | null;
  embedding?: string | null;
  memoryKey?: string | null;
  retrievalText?: string | null;
  lastUsedReason?: string | null;
  invalidatedAt?: number | null;
};

type LegacyProfileRow = LegacyOwnedRow & {
  profileKey?: string | null;
  kind?: string | null;
  content?: string | null;
  valueJson?: string | null;
  importance?: number | null;
  confidence?: number | null;
  sensitivity?: string | null;
};

export interface LegacyMemoryMigrationResult {
  factsMigrated: number;
  episodesMigrated: number;
  profilesMigrated: number;
  groupRowsDiscarded: number;
  skippedRows: number;
}

const PROFILE_KINDS = new Set<MemoryProfileKind>([
  'identity',
  'preference',
  'trait',
  'boundary',
  'plan',
  'relationship',
  'response_policy',
]);
const VISIBILITIES = new Set<MemoryVisibility>([
  'global',
  'private_only',
  'source_context_only',
  'allowed_contexts',
  'denied_contexts',
  'pending_review',
  'archived',
]);
const SENSITIVITIES = new Set<MemorySensitivity>(['low', 'personal', 'sensitive', 'secret']);
const ATTRIBUTION_STATUSES = new Set<MemoryAttributionStatus>(['verified', 'rejected', 'unknown']);

function tableModel(ctx: Context): {
  extend: (table: string, fields: Record<string, unknown>, options: Record<string, unknown>) => void;
} {
  return ctx.model as unknown as {
    extend: (table: string, fields: Record<string, unknown>, options: Record<string, unknown>) => void;
  };
}

export function ensureLegacyMemoryMigrationTables(ctx: Context): void {
  const model = tableModel(ctx);
  model.extend(
    LEGACY_MEMORY_TABLES.fact,
    {
      id: 'unsigned',
      userKey: 'string',
      kind: 'string',
      topicKey: 'string',
      content: 'text',
      keywords: { type: 'text', nullable: true },
      importance: 'double',
      confidence: 'double',
      sensitivity: 'string',
      visibility: 'string',
      sourceContextKey: 'string',
      allowedContextKeys: { type: 'text', nullable: true },
      deniedContextKeys: { type: 'text', nullable: true },
      applicability: { type: 'text', nullable: true },
      validFrom: { type: 'double', nullable: true },
      validUntil: { type: 'double', nullable: true },
      expiresAt: { type: 'double', nullable: true },
      firstSeenAt: 'double',
      lastSeenAt: 'double',
      lastAccessedAt: { type: 'double', nullable: true },
      embeddingModel: { type: 'string', nullable: true },
      embedding: { type: 'text', nullable: true },
      version: 'unsigned',
      archived: 'unsigned',
      supersedesId: { type: 'unsigned', nullable: true },
      conflictSetId: { type: 'string', nullable: true },
    },
    { autoInc: true },
  );

  model.extend(
    LEGACY_MEMORY_TABLES.episode,
    {
      id: 'unsigned',
      userKey: 'string',
      title: 'string',
      summary: 'text',
      keywords: { type: 'text', nullable: true },
      importance: 'double',
      confidence: 'double',
      sensitivity: 'string',
      visibility: 'string',
      sourceContextKey: 'string',
      allowedContextKeys: { type: 'text', nullable: true },
      deniedContextKeys: { type: 'text', nullable: true },
      applicability: { type: 'text', nullable: true },
      periodStart: { type: 'double', nullable: true },
      periodEnd: { type: 'double', nullable: true },
      validFrom: { type: 'double', nullable: true },
      validUntil: { type: 'double', nullable: true },
      expiresAt: { type: 'double', nullable: true },
      firstSeenAt: 'double',
      lastSeenAt: 'double',
      lastAccessedAt: { type: 'double', nullable: true },
      embeddingModel: { type: 'string', nullable: true },
      embedding: { type: 'text', nullable: true },
      version: 'unsigned',
      archived: 'unsigned',
      supersedesId: { type: 'unsigned', nullable: true },
      conflictSetId: { type: 'string', nullable: true },
    },
    { autoInc: true },
  );

  model.extend(
    LEGACY_MEMORY_TABLES.profile,
    {
      id: 'unsigned',
      userKey: { type: 'string', nullable: true },
      ownerUserKey: { type: 'string', nullable: true },
      profileKey: 'string',
      kind: 'string',
      content: 'text',
      valueJson: { type: 'text', nullable: true },
      importance: 'double',
      confidence: 'double',
      sensitivity: 'string',
      scopeType: 'string',
      scopeKey: { type: 'string', nullable: true },
      sourceContextKey: 'string',
      allowedContextKeys: { type: 'text', nullable: true },
      deniedContextKeys: { type: 'text', nullable: true },
      validFrom: { type: 'double', nullable: true },
      validUntil: { type: 'double', nullable: true },
      expiresAt: { type: 'double', nullable: true },
      firstSeenAt: 'double',
      lastSeenAt: 'double',
      lastAccessedAt: { type: 'double', nullable: true },
      version: 'unsigned',
      archived: 'unsigned',
      supersedesId: { type: 'unsigned', nullable: true },
      conflictSetId: { type: 'string', nullable: true },
    },
    { autoInc: true },
  );
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProfileKind(value: unknown): MemoryProfileKind | null {
  const normalized = normalizeString(value);
  return PROFILE_KINDS.has(normalized as MemoryProfileKind) ? normalized as MemoryProfileKind : null;
}

function normalizeVisibility(value: unknown): MemoryVisibility {
  const normalized = normalizeString(value);
  return VISIBILITIES.has(normalized as MemoryVisibility) ? normalized as MemoryVisibility : 'global';
}

function normalizeSensitivity(value: unknown): MemorySensitivity {
  const normalized = normalizeString(value);
  return SENSITIVITIES.has(normalized as MemorySensitivity) ? normalized as MemorySensitivity : 'low';
}

function normalizeAttributionStatus(value: unknown): MemoryAttributionStatus {
  const normalized = normalizeString(value);
  return ATTRIBUTION_STATUSES.has(normalized as MemoryAttributionStatus) ? normalized as MemoryAttributionStatus : 'verified';
}

function ownerUserKey(row: LegacyOwnedRow): string {
  return normalizeString(row.ownerUserKey) || normalizeString(row.userKey);
}

function ownerSpeakerId(row: LegacyOwnedRow): string | null {
  return normalizeString(row.targetSpeakerId) || ownerUserKey(row).split(':').at(-1) || null;
}

function sourceContextKey(row: LegacyOwnedRow): string {
  return normalizeString(row.sourceContextKey) || normalizeString(row.contextKey);
}

function isGroupContext(contextKey: string): boolean {
  return contextKey.includes(':group:') || contextKey.includes(':guild:') || contextKey.includes(':channel:');
}

function shouldMigrateDirectRow(row: LegacyOwnedRow): boolean {
  const contextKey = sourceContextKey(row);
  const kind = normalizeString(row.sourceKind);
  if (!ownerUserKey(row) || !contextKey) return false;
  if (kind === 'group' || isGroupContext(contextKey)) return false;
  return kind === 'direct' || contextKey.includes(':dm:') || !kind;
}

function resolveScope(row: LegacyOwnedRow, visibility: MemoryVisibility): {
  scopeType: MemoryScopeType;
  scopeKey: string | null;
  sourceKind: MemoryChannelType;
} {
  const explicit = normalizeString(row.scopeType);
  const scopeType = isMemoryScopeType(explicit) ? explicit : scopeTypeFromVisibility(visibility);
  return {
    scopeType,
    scopeKey: normalizeString(row.scopeKey) || scopeKeyForType(scopeType, sourceContextKey(row)),
    sourceKind: sourceKindFromContextKey(sourceContextKey(row)),
  };
}

function evidenceMessageIds(row: LegacyOwnedRow): string | null {
  const ids = parseJsonArray(row.evidenceMessageIds);
  return ids.length ? stringifyStringArray(ids) : null;
}

function evidenceSpeakerIds(row: LegacyOwnedRow): string | null {
  const ids = parseJsonArray(row.evidenceSpeakerIds);
  const speakerId = ownerSpeakerId(row);
  const merged = ids.length ? ids : speakerId ? [speakerId] : [];
  return merged.length ? stringifyStringArray(merged) : null;
}

async function safeGetAll<T>(database: MemoryDatabaseLike, table: string): Promise<T[]> {
  try {
    return await database.get(table, {} as Record<string, never>) as T[];
  } catch {
    return [];
  }
}

async function hasCanonicalMemory(database: MemoryDatabaseLike, table: string, query: Record<string, unknown>): Promise<boolean> {
  const [existing] = await database.get(table, query);
  return Boolean(existing?.id);
}

async function migrateFact(database: MemoryDatabaseLike, row: LegacyFactRow): Promise<boolean> {
  if (!shouldMigrateDirectRow(row)) return false;
  const kind = normalizeProfileKind(row.kind);
  const topicKey = normalizeString(row.topicKey);
  const content = normalizeString(row.content);
  const owner = ownerUserKey(row);
  if (!kind || !topicKey || !content || !owner) return false;
  const visibility = normalizeVisibility(row.visibility);
  const scope = resolveScope(row, visibility);
  const memoryKey = normalizeString(row.memoryKey) || buildMemoryKey({
    userKey: owner,
    layer: 'fact',
    kind,
    topicKey,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
  });
  if (await hasCanonicalMemory(database, 'memory_fact', { memoryKey, archived: 0 })) return false;
  const targetSpeakerId = ownerSpeakerId(row);
  await database.create('memory_fact', {
    ownerUserKey: owner,
    kind,
    topicKey,
    content,
    keywords: row.keywords ?? null,
    importance: Number(row.importance ?? 0.6),
    confidence: Number(row.confidence ?? 0.8),
    sensitivity: normalizeSensitivity(row.sensitivity),
    visibility,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    memoryKey,
    sourceKind: scope.sourceKind,
    sourceContextKey: sourceContextKey(row),
    targetSpeakerId,
    targetSpeakerName: normalizeString(row.targetSpeakerName) || null,
    evidenceMessageIds: evidenceMessageIds(row),
    evidenceSpeakerIds: evidenceSpeakerIds(row),
    attributionStatus: normalizeAttributionStatus(row.attributionStatus),
    allowedContextKeys: row.allowedContextKeys ?? null,
    deniedContextKeys: row.deniedContextKeys ?? null,
    applicability: row.applicability ?? null,
    validFrom: row.validFrom ?? null,
    validUntil: row.validUntil ?? null,
    expiresAt: row.expiresAt ?? null,
    invalidatedAt: row.invalidatedAt ?? null,
    retrievalText: normalizeString(row.retrievalText) || `${kind}:${topicKey}\n${content}`,
    lastUsedReason: row.lastUsedReason ?? null,
    firstSeenAt: Number(row.firstSeenAt ?? Date.now()),
    lastSeenAt: Number(row.lastSeenAt ?? row.firstSeenAt ?? Date.now()),
    lastAccessedAt: row.lastAccessedAt ?? null,
    embeddingModel: row.embeddingModel ?? null,
    embedding: row.embedding ?? null,
    version: Number(row.version ?? 1),
    archived: Number(row.archived ?? 0),
    supersedesId: row.supersedesId ?? null,
    conflictSetId: row.conflictSetId ?? null,
  });
  return true;
}

async function migrateEpisode(database: MemoryDatabaseLike, row: LegacyEpisodeRow): Promise<boolean> {
  if (!shouldMigrateDirectRow(row)) return false;
  const title = normalizeString(row.title);
  const summary = normalizeString(row.summary);
  const owner = ownerUserKey(row);
  if (!title || !summary || !owner) return false;
  const visibility = normalizeVisibility(row.visibility);
  const scope = resolveScope(row, visibility);
  const topicKey = slugify([title, ...parseJsonArray(row.keywords).slice(0, 3)].join('-')) || 'episode';
  const memoryKey = normalizeString(row.memoryKey) || buildMemoryKey({
    userKey: owner,
    layer: 'episode',
    kind: 'episode',
    topicKey,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
  });
  if (await hasCanonicalMemory(database, 'memory_episode', { memoryKey, archived: 0 })) return false;
  const targetSpeakerId = ownerSpeakerId(row);
  await database.create('memory_episode', {
    ownerUserKey: owner,
    title,
    summary,
    keywords: row.keywords ?? null,
    importance: Number(row.importance ?? 0.62),
    confidence: Number(row.confidence ?? 0.8),
    sensitivity: normalizeSensitivity(row.sensitivity),
    visibility,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    memoryKey,
    sourceKind: scope.sourceKind,
    sourceContextKey: sourceContextKey(row),
    targetSpeakerId,
    targetSpeakerName: normalizeString(row.targetSpeakerName) || null,
    evidenceMessageIds: evidenceMessageIds(row),
    evidenceSpeakerIds: evidenceSpeakerIds(row),
    attributionStatus: normalizeAttributionStatus(row.attributionStatus),
    allowedContextKeys: row.allowedContextKeys ?? null,
    deniedContextKeys: row.deniedContextKeys ?? null,
    applicability: row.applicability ?? null,
    periodStart: row.periodStart ?? null,
    periodEnd: row.periodEnd ?? null,
    validFrom: row.validFrom ?? null,
    validUntil: row.validUntil ?? null,
    expiresAt: row.expiresAt ?? null,
    invalidatedAt: row.invalidatedAt ?? null,
    retrievalText: normalizeString(row.retrievalText) || `${title}\n${summary}`,
    lastUsedReason: row.lastUsedReason ?? null,
    firstSeenAt: Number(row.firstSeenAt ?? Date.now()),
    lastSeenAt: Number(row.lastSeenAt ?? row.firstSeenAt ?? Date.now()),
    lastAccessedAt: row.lastAccessedAt ?? null,
    embeddingModel: row.embeddingModel ?? null,
    embedding: row.embedding ?? null,
    version: Number(row.version ?? 1),
    archived: Number(row.archived ?? 0),
    supersedesId: row.supersedesId ?? null,
    conflictSetId: row.conflictSetId ?? null,
  });
  return true;
}

async function migrateProfile(database: MemoryDatabaseLike, row: LegacyProfileRow): Promise<boolean> {
  if (!shouldMigrateDirectRow(row)) return false;
  const kind = normalizeProfileKind(row.kind);
  const profileKey = normalizeString(row.profileKey);
  const content = normalizeString(row.content);
  const owner = ownerUserKey(row);
  if (!kind || !profileKey || !content || !owner) return false;
  const visibility = normalizeVisibility(row.visibility);
  const scope = resolveScope(row, visibility);
  if (await hasCanonicalMemory(database, 'memory_profile', {
    ownerUserKey: owner,
    kind,
    profileKey,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    archived: 0,
  })) {
    return false;
  }
  const targetSpeakerId = ownerSpeakerId(row);
  await database.create('memory_profile', {
    ownerUserKey: owner,
    profileKey,
    kind,
    content,
    valueJson: row.valueJson ?? null,
    importance: Number(row.importance ?? 0.72),
    confidence: Number(row.confidence ?? 0.8),
    sensitivity: normalizeSensitivity(row.sensitivity),
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    sourceContextKey: sourceContextKey(row),
    targetSpeakerId,
    targetSpeakerName: normalizeString(row.targetSpeakerName) || null,
    evidenceMessageIds: evidenceMessageIds(row),
    evidenceSpeakerIds: evidenceSpeakerIds(row),
    attributionStatus: normalizeAttributionStatus(row.attributionStatus),
    allowedContextKeys: row.allowedContextKeys ?? null,
    deniedContextKeys: row.deniedContextKeys ?? null,
    validFrom: row.validFrom ?? null,
    validUntil: row.validUntil ?? null,
    expiresAt: row.expiresAt ?? null,
    firstSeenAt: Number(row.firstSeenAt ?? Date.now()),
    lastSeenAt: Number(row.lastSeenAt ?? row.firstSeenAt ?? Date.now()),
    lastAccessedAt: row.lastAccessedAt ?? null,
    version: Number(row.version ?? 1),
    archived: Number(row.archived ?? 0),
    supersedesId: row.supersedesId ?? null,
    conflictSetId: row.conflictSetId ?? null,
  });
  return true;
}

export async function runLegacyMemoryMigration(database: MemoryDatabaseLike): Promise<LegacyMemoryMigrationResult> {
  const result: LegacyMemoryMigrationResult = {
    factsMigrated: 0,
    episodesMigrated: 0,
    profilesMigrated: 0,
    groupRowsDiscarded: 0,
    skippedRows: 0,
  };

  const facts = await safeGetAll<LegacyFactRow>(database, LEGACY_MEMORY_TABLES.fact);
  for (const row of facts) {
    if (!shouldMigrateDirectRow(row)) {
      if (ownerUserKey(row) && sourceContextKey(row)) result.groupRowsDiscarded += 1;
      else result.skippedRows += 1;
      continue;
    }
    if (await migrateFact(database, row)) result.factsMigrated += 1;
    else result.skippedRows += 1;
  }

  const episodes = await safeGetAll<LegacyEpisodeRow>(database, LEGACY_MEMORY_TABLES.episode);
  for (const row of episodes) {
    if (!shouldMigrateDirectRow(row)) {
      if (ownerUserKey(row) && sourceContextKey(row)) result.groupRowsDiscarded += 1;
      else result.skippedRows += 1;
      continue;
    }
    if (await migrateEpisode(database, row)) result.episodesMigrated += 1;
    else result.skippedRows += 1;
  }

  const profiles = await safeGetAll<LegacyProfileRow>(database, LEGACY_MEMORY_TABLES.profile);
  for (const row of profiles) {
    if (!shouldMigrateDirectRow(row)) {
      if (ownerUserKey(row) && sourceContextKey(row)) result.groupRowsDiscarded += 1;
      else result.skippedRows += 1;
      continue;
    }
    if (await migrateProfile(database, row)) result.profilesMigrated += 1;
    else result.skippedRows += 1;
  }

  const migrated = result.factsMigrated + result.episodesMigrated + result.profilesMigrated;
  if (migrated > 0 || result.groupRowsDiscarded > 0) {
    await database.create('memory_audit_event', {
      userKey: null,
      contextKey: null,
      eventType: 'migration_completed',
      memoryType: null,
      memoryId: null,
      candidateId: null,
      turnId: null,
      detail: JSON.stringify(result),
      createdAt: Date.now(),
    });
  }

  return result;
}
