import type {
  MemoryAddress,
  MemoryAuditEventRecord,
  MemoryCandidateReviewStatus,
  MemoryCandidateV3Record,
  MemoryEpisodeV3Record,
  MemoryFactV3Record,
  MemoryJobV3Record,
  MemoryJobV3Status,
  MemoryJobV3Type,
  MemoryOutputProtocolId,
  MemoryRecordType,
  MemoryTombstoneRecord,
  MemoryV3QueueSummary,
  MemoryVisibility,
} from '../../types/memory-v3.js';
import type { ExtractedMemoryCandidate, PrivacyDecision } from './gates.js';
import {
  buildRetrievalText,
  deriveTopicKey,
  parseJsonArray,
  slugify,
  stringifyEmbedding,
  stringifyStringArray,
  toTimestamp,
  uniqueKeywords,
} from './format.js';
import type { MemoryConversationTurn } from './providers/schemas.js';

export interface StoredConversationRecord {
  id: string;
  latestId?: string | null;
}

export interface StoredMessageRecord {
  id: string;
  role?: string | null;
  parent?: string | null;
  conversation?: string | null;
  content?: unknown;
}

export interface ExtractJobPayload {
  address: MemoryAddress;
  maxMessages: number;
}

export interface PrivacyReviewJobPayload {
  batchId: string;
  address: MemoryAddress;
}

export interface ConsolidateJobPayload {
  candidateId: number;
  address: MemoryAddress;
}

export interface EmbedJobPayload {
  recordType: MemoryRecordType;
  recordId: number;
}

export type MemoryJobPayload =
  | ExtractJobPayload
  | PrivacyReviewJobPayload
  | ConsolidateJobPayload
  | EmbedJobPayload
  | Record<string, unknown>;

export interface MemoryDatabaseLike {
  get(table: string, query: Record<string, unknown>): Promise<any[]>;
  set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown>;
  upsert?: (table: string, rows: Record<string, unknown>[], keys?: string[]) => Promise<unknown>;
  create(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
}

const logger = {
  warn: (...args: unknown[]) => {
    void args;
  },
};
const DAY_MS = 86_400_000;

export function extractPlainText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && 'text' in raw) {
    const text = (raw as { text?: unknown }).text;
    return typeof text === 'string' ? text.trim() : '';
  }
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

async function decodeStoredMessageText(content: unknown): Promise<string> {
  const direct = extractPlainText(content);
  if (direct) return direct;
  const { decodeStoredMessageText: decode } = await import('../shared/stored-message.js');
  return decode(content);
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function parsePayload<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isJobStatus(value: unknown): value is MemoryJobV3Status {
  return value === 'pending' || value === 'processing' || value === 'done' || value === 'failed' || value === 'dead_letter';
}

function toCandidatePayload(row: MemoryCandidateV3Record): ExtractedMemoryCandidate | null {
  return parsePayload<ExtractedMemoryCandidate>(row.payload);
}

function candidateTopic(candidate: ExtractedMemoryCandidate): string | null {
  if (candidate.candidateType !== 'fact') return null;
  return deriveTopicKey({
    topicKey: candidate.topicKey,
    content: candidate.content ?? '',
    keywords: candidate.keywords,
  });
}

function buildEpisodeFingerprint(candidate: ExtractedMemoryCandidate): string {
  return slugify([candidate.title ?? '', ...(candidate.keywords ?? []).slice(0, 3)].join('-')) || 'episode';
}

function keywordOverlap(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  let hits = 0;
  for (const item of new Set(left)) {
    if (rightSet.has(item)) hits += 1;
  }
  return hits / Math.max(new Set(left).size, rightSet.size, 1);
}

function jobKey(jobType: MemoryJobV3Type, payload: MemoryJobPayload): string {
  if (jobType === 'extract') {
    const input = payload as ExtractJobPayload;
    return `extract:${input.address.conversationId}`;
  }
  if (jobType === 'privacy_review') {
    return `privacy_review:${(payload as PrivacyReviewJobPayload).batchId}`;
  }
  if (jobType === 'consolidate') {
    return `consolidate:${(payload as ConsolidateJobPayload).candidateId}`;
  }
  if (jobType === 'embed' || jobType === 'reembed') {
    const input = payload as EmbedJobPayload;
    return `${jobType}:${input.recordType}:${input.recordId}`;
  }
  return `${jobType}:${JSON.stringify(payload)}`;
}

export class MemoryV3Store {
  constructor(private readonly database: MemoryDatabaseLike) {}

  async upsertAddress(address: MemoryAddress): Promise<void> {
    const [user] = await this.database.get('memory_user', { userKey: address.userKey });
    if (user?.id) {
      await this.database.set('memory_user', { id: user.id }, { lastSeenAt: address.observedAt });
    } else {
      await this.database.create('memory_user', {
        userKey: address.userKey,
        platform: address.platform,
        userId: address.userId,
        firstSeenAt: address.observedAt,
        lastSeenAt: address.observedAt,
        readEnabled: 1,
        writeEnabled: 1,
      });
    }

    const [context] = await this.database.get('memory_context', { contextKey: address.contextKey });
    const contextRecord = {
      platform: address.platform,
      botSelfId: address.botSelfId,
      channelType: address.channelType,
      groupId: address.groupId ?? null,
      channelId: address.channelId ?? null,
      rawContextId: address.rawContextId ?? null,
      lastSeenAt: address.observedAt,
    };
    if (context?.id) {
      await this.database.set('memory_context', { id: context.id }, contextRecord);
    } else {
      await this.database.create('memory_context', {
        contextKey: address.contextKey,
        ...contextRecord,
        firstSeenAt: address.observedAt,
      });
    }
  }

  async getUserFlags(userKey: string): Promise<{ readEnabled: boolean; writeEnabled: boolean }> {
    const [row] = await this.database.get('memory_user', { userKey });
    return {
      readEnabled: row?.readEnabled == null ? true : Number(row.readEnabled) === 1,
      writeEnabled: row?.writeEnabled == null ? true : Number(row.writeEnabled) === 1,
    };
  }

  async queueJob(jobType: MemoryJobV3Type, payload: MemoryJobPayload, nextRunAt = Date.now()): Promise<void> {
    const now = Date.now();
    const key = jobKey(jobType, payload);
    const [existing] = await this.database.get('memory_job_v3', { jobKey: key });
    const row = {
      jobType,
      status: 'pending',
      payload: serialize(payload),
      nextRunAt,
      lockedAt: null,
      lastError: null,
      updatedAt: now,
    };
    if (existing?.id) {
      await this.database.set('memory_job_v3', { id: existing.id }, row);
      return;
    }
    await this.database.create('memory_job_v3', {
      jobKey: key,
      retryCount: 0,
      createdAt: now,
      ...row,
    });
  }

  async listDueJobs(jobType: MemoryJobV3Type, now: number): Promise<MemoryJobV3Record[]> {
    const rows = await this.database.get('memory_job_v3', { jobType, status: 'pending' }) as MemoryJobV3Record[];
    return rows.filter((row) => Number(row.nextRunAt ?? 0) <= now).sort((left, right) => left.nextRunAt - right.nextRunAt);
  }

  async markJobProcessing(job: MemoryJobV3Record): Promise<void> {
    await this.database.set('memory_job_v3', { id: job.id }, {
      status: 'processing',
      lockedAt: Date.now(),
      updatedAt: Date.now(),
      lastError: null,
    });
  }

  async completeJob(job: MemoryJobV3Record): Promise<void> {
    await this.database.remove('memory_job_v3', { id: job.id });
  }

  async retryJob(job: MemoryJobV3Record, error: unknown, delayMs: number, maxRetries: number): Promise<void> {
    const retryCount = Number(job.retryCount ?? 0) + 1;
    const status: MemoryJobV3Status = retryCount > maxRetries ? 'dead_letter' : 'pending';
    await this.database.set('memory_job_v3', { id: job.id }, {
      status,
      retryCount,
      nextRunAt: Date.now() + delayMs * Math.max(1, retryCount),
      lockedAt: null,
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    });
  }

  async requeueStaleProcessingJobs(lockTimeoutMs: number): Promise<number> {
    const rows = await this.database.get('memory_job_v3', { status: 'processing' }) as MemoryJobV3Record[];
    const threshold = Date.now() - lockTimeoutMs;
    let count = 0;
    for (const row of rows) {
      if (Number(row.lockedAt ?? 0) > threshold) continue;
      await this.database.set('memory_job_v3', { id: row.id }, {
        status: 'pending',
        lockedAt: null,
        nextRunAt: Date.now(),
        updatedAt: Date.now(),
      });
      count += 1;
    }
    return count;
  }

  async getJobSummary(): Promise<MemoryV3QueueSummary> {
    const rows = await this.database.get('memory_job_v3', {} as Record<string, never>) as MemoryJobV3Record[];
    return rows.reduce<MemoryV3QueueSummary>(
      (summary, row) => {
        if (row.status === 'dead_letter') summary.deadLetter += 1;
        if (row.jobType === 'extract' && row.status === 'pending') summary.extractPending += 1;
        if (row.jobType === 'extract' && row.status === 'processing') summary.extractProcessing += 1;
        if (row.jobType === 'privacy_review' && row.status === 'pending') summary.privacyReviewPending += 1;
        if (row.jobType === 'consolidate' && row.status === 'pending') summary.consolidatePending += 1;
        if ((row.jobType === 'embed' || row.jobType === 'reembed') && row.status === 'pending') summary.embedPending += 1;
        if ((row.jobType === 'embed' || row.jobType === 'reembed') && row.status === 'processing') summary.embedProcessing += 1;
        return summary;
      },
      {
        extractPending: 0,
        extractProcessing: 0,
        privacyReviewPending: 0,
        consolidatePending: 0,
        embedPending: 0,
        embedProcessing: 0,
        deadLetter: 0,
      },
    );
  }

  parseJobPayload<T>(job: MemoryJobV3Record): T | null {
    if (!isJobStatus(job.status)) return null;
    return parsePayload<T>(job.payload);
  }

  async readConversationWindow(conversationId: string, maxMessages: number): Promise<MemoryConversationTurn[]> {
    const [conversation] = await this.database.get('chathub_conversation', { id: conversationId }) as StoredConversationRecord[];
    if (!conversation?.id || !conversation.latestId) return [];

    const rows = await this.database.get('chathub_message', { conversation: conversationId }) as StoredMessageRecord[];
    const messageMap = new Map(rows.map((row) => [row.id, row]));
    const window: MemoryConversationTurn[] = [];
    let cursor: string | null | undefined = conversation.latestId;
    while (cursor && window.length < maxMessages) {
      const row = messageMap.get(cursor);
      if (!row) break;
      if (row.role === 'human' || row.role === 'ai') {
        try {
          const text = await decodeStoredMessageText(row.content);
          if (text) {
            window.push({
              id: row.id,
              role: row.role,
              text,
            });
          }
        } catch (error) {
          logger.warn('failed to decode stored message content for %s: %s', row.id, (error as Error).message);
        }
      }
      cursor = row.parent ?? null;
    }
    return window.reverse();
  }

  async filterTombstonedTurns(userKey: string, turns: MemoryConversationTurn[]): Promise<MemoryConversationTurn[]> {
    const tombstones = await this.database.get('memory_tombstone', { userKey }) as MemoryTombstoneRecord[];
    const sourceIds = new Set(
      tombstones
        .filter((row) => row.memoryType === 'source' && row.sourceMessageId)
        .map((row) => row.sourceMessageId as string),
    );
    return turns.filter((turn) => !sourceIds.has(turn.id));
  }

  async writeCandidateBatch(input: {
    address: MemoryAddress;
    batchId: string;
    candidates: ExtractedMemoryCandidate[];
    messageIds: string[];
    providerRoute: MemoryOutputProtocolId;
    rawTextHash: string | null;
  }): Promise<void> {
    const messageIds = stringifyStringArray(input.messageIds);
    for (const candidate of input.candidates) {
      await this.database.create('memory_candidate_v3', {
        batchId: input.batchId,
        candidateType: candidate.candidateType,
        userKey: input.address.userKey,
        contextKey: input.address.contextKey,
        conversationId: input.address.conversationId,
        messageIds,
        payload: serialize(candidate),
        reviewStatus: 'pending',
        sensitivity: candidate.sensitivity,
        suggestedVisibility: candidate.suggestedVisibility,
        finalVisibility: null,
        dropReason: candidate.dropReason ?? null,
        providerRoute: input.providerRoute,
        rawTextHash: input.rawTextHash,
        createdAt: Date.now(),
        reviewedAt: null,
        consolidatedAt: null,
      });
    }
    await this.audit({
      userKey: input.address.userKey,
      contextKey: input.address.contextKey,
      eventType: 'extract_candidates_written',
      turnId: input.address.conversationId,
      detail: {
        batchId: input.batchId,
        count: input.candidates.length,
        providerRoute: input.providerRoute,
      },
    });
  }

  async listBatchCandidates(batchId: string): Promise<MemoryCandidateV3Record[]> {
    return await this.database.get('memory_candidate_v3', { batchId }) as MemoryCandidateV3Record[];
  }

  async getCandidateById(candidateId: number): Promise<MemoryCandidateV3Record | null> {
    const [row] = await this.database.get('memory_candidate_v3', { id: candidateId }) as MemoryCandidateV3Record[];
    return row ?? null;
  }

  async applyPrivacyDecision(row: MemoryCandidateV3Record, decision: PrivacyDecision): Promise<void> {
    await this.database.set('memory_candidate_v3', { id: row.id }, {
      reviewStatus: decision.status,
      sensitivity: decision.sensitivity,
      finalVisibility: decision.visibility,
      dropReason: decision.reason,
      reviewedAt: Date.now(),
    });
    await this.audit({
      userKey: row.userKey,
      contextKey: row.contextKey,
      eventType: 'privacy_review',
      candidateId: row.id,
      detail: decision,
    });
  }

  async queueApprovedConsolidation(row: MemoryCandidateV3Record, address: MemoryAddress): Promise<void> {
    if (row.reviewStatus !== 'approved') return;
    await this.queueJob('consolidate', { candidateId: row.id, address });
  }

  private async isTopicTombstoned(userKey: string, contextKey: string, topicKey: string | null): Promise<boolean> {
    if (!topicKey) return false;
    const rows = await this.database.get('memory_tombstone', { userKey }) as MemoryTombstoneRecord[];
    return rows.some((row) => {
      if (row.memoryType !== 'topic' && row.memoryType !== 'fact') return false;
      if (row.topicKey !== topicKey) return false;
      return !row.contextKey || row.contextKey === contextKey;
    });
  }

  private async isCandidateSourceTombstoned(row: MemoryCandidateV3Record): Promise<boolean> {
    const tombstones = await this.database.get('memory_tombstone', { userKey: row.userKey }) as MemoryTombstoneRecord[];
    const tombstonedSources = new Set(
      tombstones
        .filter((item) => item.memoryType === 'source' && item.sourceMessageId)
        .map((item) => item.sourceMessageId as string),
    );
    return parseJsonArray(row.messageIds).some((id) => tombstonedSources.has(id));
  }

  async consolidateCandidate(row: MemoryCandidateV3Record, address: MemoryAddress): Promise<{ type: MemoryRecordType; id: number } | null> {
    if (row.reviewStatus !== 'approved' || row.consolidatedAt != null) return null;
    if (await this.isCandidateSourceTombstoned(row)) {
      await this.database.set('memory_candidate_v3', { id: row.id }, {
        reviewStatus: 'rejected',
        dropReason: 'source_tombstoned',
        consolidatedAt: Date.now(),
      });
      return null;
    }
    const candidate = toCandidatePayload(row);
    if (!candidate || candidate.candidateType === 'drop') {
      await this.database.set('memory_candidate_v3', { id: row.id }, { consolidatedAt: Date.now() });
      return null;
    }

    if (candidate.candidateType === 'fact') {
      const topicKey = candidateTopic(candidate);
      if (!topicKey || await this.isTopicTombstoned(row.userKey, row.contextKey, topicKey)) {
        await this.database.set('memory_candidate_v3', { id: row.id }, {
          reviewStatus: 'rejected',
          dropReason: 'topic_tombstoned',
          consolidatedAt: Date.now(),
        });
        return null;
      }
      const result = await this.upsertFact(row, candidate, topicKey);
      await this.database.set('memory_candidate_v3', { id: row.id }, { consolidatedAt: Date.now() });
      await this.createProvenance(row, 'fact', result.id);
      await this.queueJob('embed', { recordType: 'fact', recordId: result.id });
      await this.audit({
        userKey: row.userKey,
        contextKey: row.contextKey,
        eventType: result.created ? 'fact_created' : 'fact_updated',
        memoryType: 'fact',
        memoryId: result.id,
        candidateId: row.id,
        turnId: address.conversationId,
      });
      return { type: 'fact', id: result.id };
    }

    const result = await this.upsertEpisode(row, candidate);
    await this.database.set('memory_candidate_v3', { id: row.id }, { consolidatedAt: Date.now() });
    await this.createProvenance(row, 'episode', result.id);
    await this.queueJob('embed', { recordType: 'episode', recordId: result.id });
    await this.audit({
      userKey: row.userKey,
      contextKey: row.contextKey,
      eventType: result.created ? 'episode_created' : 'episode_updated',
      memoryType: 'episode',
      memoryId: result.id,
      candidateId: row.id,
      turnId: address.conversationId,
    });
    return { type: 'episode', id: result.id };
  }

  private async upsertFact(
    row: MemoryCandidateV3Record,
    candidate: ExtractedMemoryCandidate,
    topicKey: string,
  ): Promise<{ id: number; created: boolean }> {
    const now = Date.now();
    const kind = candidate.kind ?? 'preference';
    const [existing] = await this.database.get('memory_fact_v3', {
      userKey: row.userKey,
      kind,
      topicKey,
      archived: 0,
    }) as MemoryFactV3Record[];
    const keywords = uniqueKeywords([
      ...parseJsonArray(existing?.keywords),
      ...candidate.keywords,
    ]);
    const patch = {
      kind,
      topicKey,
      content: candidate.content?.trim() ?? '',
      keywords: stringifyStringArray(keywords),
      importance: Math.max(Number(existing?.importance ?? 0), Number(candidate.importance ?? 0.6)),
      confidence: Math.max(Number(existing?.confidence ?? 0), Number(candidate.confidence ?? 0.8)),
      sensitivity: row.sensitivity,
      visibility: (row.finalVisibility ?? row.suggestedVisibility) as MemoryVisibility,
      sourceContextKey: row.contextKey,
      allowedContextKeys: null,
      deniedContextKeys: null,
      applicability: candidate.applicability ?? null,
      validFrom: toTimestamp(candidate.validFrom),
      validUntil: toTimestamp(candidate.validUntil),
      expiresAt: toTimestamp(candidate.expiresAt),
      lastSeenAt: now,
      lastAccessedAt: existing?.lastAccessedAt ?? null,
      embeddingModel: null,
      embedding: null,
      version: Number(existing?.version ?? 0) + 1,
      archived: 0,
      supersedesId: existing?.supersedesId ?? null,
      conflictSetId: candidate.conflictHint ? slugify(candidate.conflictHint) : existing?.conflictSetId ?? null,
    };
    if (existing?.id) {
      await this.database.set('memory_fact_v3', { id: existing.id }, patch);
      return { id: existing.id, created: false };
    }
    const created = await this.database.create('memory_fact_v3', {
      userKey: row.userKey,
      firstSeenAt: now,
      ...patch,
    }) as unknown as MemoryFactV3Record;
    return { id: Number(created.id), created: true };
  }

  private async upsertEpisode(
    row: MemoryCandidateV3Record,
    candidate: ExtractedMemoryCandidate,
  ): Promise<{ id: number; created: boolean }> {
    const now = Date.now();
    const existingRows = await this.database.get('memory_episode_v3', { userKey: row.userKey, archived: 0 }) as MemoryEpisodeV3Record[];
    const incomingKeywords = uniqueKeywords(candidate.keywords);
    const incomingFingerprint = buildEpisodeFingerprint(candidate);
    const existing = existingRows.find((episode) => {
      const existingFingerprint = slugify([episode.title, ...parseJsonArray(episode.keywords).slice(0, 3)].join('-')) || 'episode';
      return existingFingerprint === incomingFingerprint || keywordOverlap(parseJsonArray(episode.keywords), incomingKeywords) >= 0.6;
    }) ?? null;
    const keywords = uniqueKeywords([
      ...parseJsonArray(existing?.keywords),
      ...incomingKeywords,
    ]);
    const patch = {
      title: candidate.title?.trim() ?? '',
      summary: candidate.summary?.trim() ?? '',
      keywords: stringifyStringArray(keywords),
      importance: Math.max(Number(existing?.importance ?? 0), Number(candidate.importance ?? 0.62)),
      confidence: Math.max(Number(existing?.confidence ?? 0), Number(candidate.confidence ?? 0.8)),
      sensitivity: row.sensitivity,
      visibility: (row.finalVisibility ?? row.suggestedVisibility) as MemoryVisibility,
      sourceContextKey: row.contextKey,
      allowedContextKeys: null,
      deniedContextKeys: null,
      applicability: candidate.applicability ?? null,
      periodStart: toTimestamp(candidate.periodStart) ?? existing?.periodStart ?? null,
      periodEnd: toTimestamp(candidate.periodEnd) ?? existing?.periodEnd ?? null,
      validFrom: toTimestamp(candidate.validFrom),
      validUntil: toTimestamp(candidate.validUntil),
      expiresAt: toTimestamp(candidate.expiresAt),
      lastSeenAt: now,
      lastAccessedAt: existing?.lastAccessedAt ?? null,
      embeddingModel: null,
      embedding: null,
      version: Number(existing?.version ?? 0) + 1,
      archived: 0,
      supersedesId: existing?.supersedesId ?? null,
      conflictSetId: candidate.conflictHint ? slugify(candidate.conflictHint) : existing?.conflictSetId ?? null,
    };
    if (existing?.id) {
      await this.database.set('memory_episode_v3', { id: existing.id }, patch);
      return { id: existing.id, created: false };
    }
    const created = await this.database.create('memory_episode_v3', {
      userKey: row.userKey,
      firstSeenAt: now,
      ...patch,
    }) as unknown as MemoryEpisodeV3Record;
    return { id: Number(created.id), created: true };
  }

  private async createProvenance(row: MemoryCandidateV3Record, memoryType: MemoryRecordType, memoryId: number): Promise<void> {
    await this.database.create('memory_provenance', {
      userKey: row.userKey,
      contextKey: row.contextKey,
      memoryType,
      memoryId,
      candidateId: row.id,
      conversationId: row.conversationId,
      messageIds: row.messageIds,
      source: 'qqbot_memory_v3',
      createdAt: Date.now(),
    });
  }

  async resolveEmbedJob(job: MemoryJobV3Record): Promise<{ payload: EmbedJobPayload; text: string } | null> {
    const payload = this.parseJobPayload<EmbedJobPayload>(job);
    if (!payload || (payload.recordType !== 'fact' && payload.recordType !== 'episode') || !payload.recordId) return null;
    if (payload.recordType === 'fact') {
      const [row] = await this.database.get('memory_fact_v3', { id: payload.recordId }) as MemoryFactV3Record[];
      if (!row?.id || row.archived === 1) return null;
      return { payload, text: buildRetrievalText('fact', row) };
    }
    const [row] = await this.database.get('memory_episode_v3', { id: payload.recordId }) as MemoryEpisodeV3Record[];
    if (!row?.id || row.archived === 1) return null;
    return { payload, text: buildRetrievalText('episode', row) };
  }

  async applyEmbedding(payload: EmbedJobPayload, model: string, embedding: number[]): Promise<void> {
    const table = payload.recordType === 'fact' ? 'memory_fact_v3' : 'memory_episode_v3';
    await this.database.set(table, { id: payload.recordId }, {
      embeddingModel: model,
      embedding: stringifyEmbedding(embedding),
    });
  }

  async listFactsForUser(userKey: string): Promise<MemoryFactV3Record[]> {
    return await this.database.get('memory_fact_v3', { userKey, archived: 0 }) as MemoryFactV3Record[];
  }

  async listEpisodesForUser(userKey: string): Promise<MemoryEpisodeV3Record[]> {
    return await this.database.get('memory_episode_v3', { userKey, archived: 0 }) as MemoryEpisodeV3Record[];
  }

  async touchMemory(type: MemoryRecordType, ids: readonly number[]): Promise<void> {
    const table = type === 'fact' ? 'memory_fact_v3' : 'memory_episode_v3';
    for (const id of ids) {
      await this.database.set(table, { id }, { lastAccessedAt: Date.now() });
    }
  }

  async archiveExpired(now = Date.now()): Promise<number> {
    let archived = 0;
    const facts = await this.database.get('memory_fact_v3', { archived: 0 }) as MemoryFactV3Record[];
    for (const fact of facts) {
      if (fact.expiresAt == null || fact.expiresAt > now) continue;
      await this.database.set('memory_fact_v3', { id: fact.id }, { archived: 1, lastSeenAt: now });
      archived += 1;
    }
    const episodes = await this.database.get('memory_episode_v3', { archived: 0 }) as MemoryEpisodeV3Record[];
    for (const episode of episodes) {
      if (episode.expiresAt == null || episode.expiresAt > now) continue;
      await this.database.set('memory_episode_v3', { id: episode.id }, { archived: 1, lastSeenAt: now });
      archived += 1;
    }
    return archived;
  }

  async archiveLowRiskOldEpisodes(archiveDays: number, now = Date.now()): Promise<number> {
    const threshold = now - archiveDays * DAY_MS;
    const episodes = await this.database.get('memory_episode_v3', { archived: 0 }) as MemoryEpisodeV3Record[];
    let count = 0;
    for (const episode of episodes) {
      const lastTouched = Number(episode.lastAccessedAt ?? episode.lastSeenAt ?? episode.firstSeenAt ?? 0);
      if (episode.importance >= 0.85 || episode.sensitivity !== 'low' || lastTouched > threshold) continue;
      await this.database.set('memory_episode_v3', { id: episode.id }, { archived: 1, lastSeenAt: now });
      count += 1;
    }
    return count;
  }

  async forgetMemory(input: { userKey: string; type: MemoryRecordType; id: number; reason?: string | null }): Promise<boolean> {
    const table = input.type === 'fact' ? 'memory_fact_v3' : 'memory_episode_v3';
    const [row] = await this.database.get(table, { id: input.id });
    if (!row?.id || row.userKey !== input.userKey) return false;
    const provenanceRows = await this.database.get('memory_provenance', {
      memoryType: input.type,
      memoryId: input.id,
    });
    await this.database.remove(table, { id: input.id });
    await this.database.remove('memory_provenance', { memoryType: input.type, memoryId: input.id });
    await this.removeJobsReferencing(input.type, input.id);
    for (const provenance of provenanceRows) {
      for (const sourceMessageId of parseJsonArray(provenance.messageIds)) {
        await this.database.create('memory_tombstone', {
          userKey: input.userKey,
          contextKey: provenance.contextKey ?? row.sourceContextKey ?? null,
          memoryType: 'source',
          memoryId: null,
          topicKey: null,
          sourceMessageId,
          reason: input.reason ?? 'forget',
          createdAt: Date.now(),
        });
      }
    }
    await this.database.create('memory_tombstone', {
      userKey: input.userKey,
      contextKey: row.sourceContextKey ?? null,
      memoryType: input.type,
      memoryId: input.id,
      topicKey: input.type === 'fact' ? row.topicKey ?? null : null,
      sourceMessageId: null,
      reason: input.reason ?? 'forget',
      createdAt: Date.now(),
    });
    if (input.type === 'fact' && row.topicKey) {
      await this.database.create('memory_tombstone', {
        userKey: input.userKey,
        contextKey: row.sourceContextKey ?? null,
        memoryType: 'topic',
        memoryId: null,
        topicKey: row.topicKey,
        sourceMessageId: null,
        reason: input.reason ?? 'forget',
        createdAt: Date.now(),
      });
    }
    await this.audit({
      userKey: input.userKey,
      contextKey: row.sourceContextKey ?? null,
      eventType: 'forget',
      memoryType: input.type,
      memoryId: input.id,
      detail: { reason: input.reason ?? 'forget' },
    });
    return true;
  }

  async forgetTopic(userKey: string, topicKey: string, contextKey: string | null = null): Promise<number> {
    const rows = await this.database.get('memory_fact_v3', { userKey, topicKey }) as MemoryFactV3Record[];
    let count = 0;
    for (const row of rows) {
      if (contextKey && row.sourceContextKey !== contextKey) continue;
      if (await this.forgetMemory({ userKey, type: 'fact', id: row.id, reason: 'forget_topic' })) count += 1;
    }
    await this.database.create('memory_tombstone', {
      userKey,
      contextKey,
      memoryType: 'topic',
      memoryId: null,
      topicKey,
      sourceMessageId: null,
      reason: 'forget_topic',
      createdAt: Date.now(),
    });
    return count;
  }

  async forgetContext(userKey: string, contextKey: string): Promise<number> {
    const [facts, episodes] = await Promise.all([
      this.database.get('memory_fact_v3', { userKey, sourceContextKey: contextKey }) as Promise<MemoryFactV3Record[]>,
      this.database.get('memory_episode_v3', { userKey, sourceContextKey: contextKey }) as Promise<MemoryEpisodeV3Record[]>,
    ]);
    let count = 0;
    for (const row of facts) {
      if (await this.forgetMemory({ userKey, type: 'fact', id: row.id, reason: 'forget_context' })) count += 1;
    }
    for (const row of episodes) {
      if (await this.forgetMemory({ userKey, type: 'episode', id: row.id, reason: 'forget_context' })) count += 1;
    }
    await this.database.create('memory_tombstone', {
      userKey,
      contextKey,
      memoryType: 'source',
      memoryId: null,
      topicKey: null,
      sourceMessageId: null,
      reason: 'forget_context',
      createdAt: Date.now(),
    });
    return count;
  }

  async forgetAll(userKey: string): Promise<number> {
    const [facts, episodes] = await Promise.all([
      this.database.get('memory_fact_v3', { userKey }) as Promise<MemoryFactV3Record[]>,
      this.database.get('memory_episode_v3', { userKey }) as Promise<MemoryEpisodeV3Record[]>,
    ]);
    let count = 0;
    for (const row of facts) {
      if (await this.forgetMemory({ userKey, type: 'fact', id: row.id, reason: 'forget_all' })) count += 1;
    }
    for (const row of episodes) {
      if (await this.forgetMemory({ userKey, type: 'episode', id: row.id, reason: 'forget_all' })) count += 1;
    }
    return count;
  }

  async updateVisibility(input: {
    userKey: string;
    type: MemoryRecordType;
    id: number;
    visibility: MemoryVisibility;
  }): Promise<boolean> {
    const table = input.type === 'fact' ? 'memory_fact_v3' : 'memory_episode_v3';
    const [row] = await this.database.get(table, { id: input.id });
    if (!row?.id || row.userKey !== input.userKey) return false;
    await this.database.set(table, { id: input.id }, { visibility: input.visibility, version: Number(row.version ?? 0) + 1 });
    await this.audit({
      userKey: input.userKey,
      contextKey: row.sourceContextKey ?? null,
      eventType: 'visibility_updated',
      memoryType: input.type,
      memoryId: input.id,
      detail: { visibility: input.visibility },
    });
    return true;
  }

  async editMemory(input: {
    userKey: string;
    type: MemoryRecordType;
    id: number;
    content: string;
  }): Promise<boolean> {
    const table = input.type === 'fact' ? 'memory_fact_v3' : 'memory_episode_v3';
    const [row] = await this.database.get(table, { id: input.id });
    if (!row?.id || row.userKey !== input.userKey) return false;
    const patch = input.type === 'fact'
      ? { content: input.content.trim(), version: Number(row.version ?? 0) + 1, embedding: null, embeddingModel: null }
      : { summary: input.content.trim(), version: Number(row.version ?? 0) + 1, embedding: null, embeddingModel: null };
    await this.database.set(table, { id: input.id }, patch);
    await this.queueJob('embed', { recordType: input.type, recordId: input.id });
    await this.audit({
      userKey: input.userKey,
      contextKey: row.sourceContextKey ?? null,
      eventType: 'memory_edited',
      memoryType: input.type,
      memoryId: input.id,
    });
    return true;
  }

  async reviewCandidate(input: {
    candidateId: number;
    action: 'approve' | 'reject' | 'private';
  }): Promise<boolean> {
    const [row] = await this.database.get('memory_candidate_v3', { id: input.candidateId }) as MemoryCandidateV3Record[];
    if (!row?.id) return false;
    const reviewStatus: MemoryCandidateReviewStatus = input.action === 'reject' ? 'rejected' : 'approved';
    const finalVisibility: MemoryVisibility | null = input.action === 'private' ? 'private_only' : row.finalVisibility ?? row.suggestedVisibility;
    await this.database.set('memory_candidate_v3', { id: row.id }, {
      reviewStatus,
      finalVisibility,
      reviewedAt: Date.now(),
      dropReason: input.action === 'reject' ? 'manual_reject' : row.dropReason,
    });
    await this.audit({
      userKey: row.userKey,
      contextKey: row.contextKey,
      eventType: 'candidate_manual_review',
      candidateId: row.id,
      detail: { action: input.action },
    });
    return true;
  }

  private async removeJobsReferencing(recordType: MemoryRecordType, recordId: number): Promise<void> {
    const rows = await this.database.get('memory_job_v3', {} as Record<string, never>) as MemoryJobV3Record[];
    for (const row of rows) {
      const payload = parsePayload<Record<string, unknown>>(row.payload);
      if (payload?.recordType === recordType && Number(payload.recordId) === recordId) {
        await this.database.remove('memory_job_v3', { id: row.id });
      }
    }
  }

  async audit(input: {
    userKey?: string | null;
    contextKey?: string | null;
    eventType: string;
    memoryType?: MemoryRecordType | null;
    memoryId?: number | null;
    candidateId?: number | null;
    turnId?: string | null;
    detail?: unknown;
  }): Promise<void> {
    await this.database.create('memory_audit_event', {
      userKey: input.userKey ?? null,
      contextKey: input.contextKey ?? null,
      eventType: input.eventType,
      memoryType: input.memoryType ?? null,
      memoryId: input.memoryId ?? null,
      candidateId: input.candidateId ?? null,
      turnId: input.turnId ?? null,
      detail: input.detail == null ? null : serialize(input.detail),
      createdAt: Date.now(),
    } satisfies Omit<MemoryAuditEventRecord, 'id'>);
  }
}
