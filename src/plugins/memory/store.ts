import { Logger, type Context, type Session } from 'koishi';
import { gzipDecode } from 'koishi-plugin-chatluna/utils/string';
import type {
  MemoryEpisodeRecord,
  MemoryFactRecord,
  MemoryJobRecord,
  MemoryV2QueueSummary,
  MemoryScopeType,
} from '../../types/memory-v2.js';
import type {
  ExtractedMemoryEpisode,
  ExtractedMemoryFact,
  MemoryConversationTurn,
  MemoryExtractionResult,
} from './llm.js';

export interface MemoryScope {
  scopeType: MemoryScopeType;
  scopeKey: string;
}

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

export interface MemorySearchDocument {
  key: string;
  kind: 'fact' | 'episode';
  recordId: number;
  title: string;
  text: string;
  keywords: string[];
  importance: number;
  updatedAt: number;
  accessedAt: number;
  embedding: number[] | null;
}

export interface RecallPlan {
  candidates: MemorySearchDocument[];
  needsSemanticSearch: boolean;
  explicitRecallCue: boolean;
}

interface EmbedJobPayload {
  recordType: 'fact' | 'episode';
  recordId: number;
}

interface ExtractJobPayload extends MemoryScope {
  conversationId: string;
  maxMessages: number;
}

interface MemoryV2DatabaseLike {
  get(table: string, query: Record<string, unknown>): Promise<any[]>;
  set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown>;
  upsert(table: string, rows: Record<string, unknown>[], keys?: string[]): Promise<unknown>;
  create(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
}

const DAY_MS = 86_400_000;
const CHINESE_STOP_WORDS = new Set(['什么', '怎么', '还是', '就是', '然后', '现在', '今天', '一下', '这个', '那个']);
const logger = new Logger('memory-v2');

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

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

function stringifyStringArray(values: string[]): string {
  return JSON.stringify([...new Set(values.map((item) => item.trim()).filter(Boolean))]);
}

function parseEmbedding(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const vector = parsed.map((item) => Number(item)).filter((item) => Number.isFinite(item));
    return vector.length ? vector : null;
  } catch {
    return null;
  }
}

function stringifyEmbedding(value: number[]): string {
  return JSON.stringify(value);
}

function toTimestamp(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

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

function toStoredArrayBuffer(raw: unknown): ArrayBuffer | null {
  if (raw instanceof ArrayBuffer) return raw;
  if (!ArrayBuffer.isView(raw)) return null;
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
}

export async function decodeStoredMessageText(content: unknown): Promise<string> {
  const buffer = toStoredArrayBuffer(content);
  if (!buffer) return '';
  const payload = await gzipDecode(buffer);
  return extractPlainText(JSON.parse(payload));
}

export function buildMemoryScope(session: Session): MemoryScope | null {
  const userId = session.userId?.trim();
  const botSelfId = session.bot?.selfId?.trim() || 'bot';
  const platform = session.platform?.trim() || 'unknown';
  if (!userId) return null;

  if (session.isDirect) {
    return {
      scopeType: 'user',
      scopeKey: `${platform}:${botSelfId}:user:${userId}`,
    };
  }

  const groupKey = session.guildId?.trim() || session.channelId?.trim();
  if (!groupKey) return null;
  return {
    scopeType: 'user_group',
    scopeKey: `${platform}:${botSelfId}:group:${groupKey}:user:${userId}`,
  };
}

function slugify(raw: string): string {
  return normalizeText(raw)
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function deriveTopicKey(input: Pick<ExtractedMemoryFact, 'topicKey' | 'content' | 'keywords'>): string {
  const topicKey = typeof input.topicKey === 'string' ? slugify(input.topicKey) : '';
  if (topicKey) return topicKey;
  const keyword = input.keywords?.find((item) => item.trim()) ?? '';
  return slugify(keyword || input.content.slice(0, 48)) || 'memory-fact';
}

function uniqueKeywords(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].slice(0, 12);
}

export function mergeFactRecord(
  existing: MemoryFactRecord | null,
  incoming: ExtractedMemoryFact,
  now: number,
  sourceMessageIds: string[],
): Omit<MemoryFactRecord, 'id'> {
  const keywords = uniqueKeywords([...(existing ? parseStringArray(existing.keywords) : []), ...(incoming.keywords ?? [])]);
  const content = incoming.content.trim();
  return {
    scopeType: existing?.scopeType ?? 'user',
    scopeKey: existing?.scopeKey ?? '',
    topicKey: deriveTopicKey(incoming),
    content,
    keywords: keywords.length ? stringifyStringArray(keywords) : null,
    importance: Math.max(Number(existing?.importance ?? 0), Number(incoming.importance ?? 0.55)),
    confidence: Math.max(Number(existing?.confidence ?? 0), Number(incoming.confidence ?? 0.8)),
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    sourceMessageIds: stringifyStringArray([...(existing ? parseStringArray(existing.sourceMessageIds) : []), ...sourceMessageIds]),
    embeddingModel: existing?.embeddingModel ?? null,
    embedding: existing?.embedding ?? null,
    version: (existing?.version ?? 0) + 1,
    archived: 0,
  };
}

function buildEpisodeFingerprint(title: string, keywords: string[]): string {
  return slugify([title, ...keywords.slice(0, 3)].join('-')) || slugify(title) || 'memory-episode';
}

function keywordOverlap(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let hits = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) hits += 1;
  }
  return hits / Math.max(leftSet.size, rightSet.size, 1);
}

function tokenizeQuery(text: string): string[] {
  const normalized = normalizeText(text);
  const ascii = normalized.match(/[a-z0-9_-]{2,}/g) ?? [];
  const chineseSegments = normalized.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const chineseTokens: string[] = [];

  for (const segment of chineseSegments) {
    if (!CHINESE_STOP_WORDS.has(segment)) chineseTokens.push(segment);
    if (segment.length <= 4) continue;
    for (let index = 0; index <= segment.length - 2; index += 1) {
      const token = segment.slice(index, index + 2);
      if (!CHINESE_STOP_WORDS.has(token)) chineseTokens.push(token);
    }
  }

  return [...new Set([...ascii, ...chineseTokens])];
}

function hasRecallCue(text: string): boolean {
  return /还记得|记得吗|想起来|回忆|之前|以前|上次|上个月|去年|那次|当时|提过/.test(text);
}

function hasTimeCue(text: string): boolean {
  return /上个月|这个月|去年|前年|之前|上次|那次|当时|后来/.test(text);
}

function coarseScore(query: string, tokens: string[], document: MemorySearchDocument, now: number): number {
  const normalizedQuery = normalizeText(query);
  const haystack = normalizeText(`${document.title}\n${document.text}\n${document.keywords.join(' ')}`);
  let keywordHits = 0;
  for (const token of tokens) {
    if (token && haystack.includes(token)) keywordHits += 1;
  }
  const keywordScore = tokens.length ? keywordHits / tokens.length : 0;
  const directMention = normalizedQuery && haystack.includes(normalizedQuery) ? 0.4 : 0;
  const recency = 1 / (1 + Math.max(0, now - document.updatedAt) / (30 * DAY_MS));
  const timeBonus = hasTimeCue(query) && document.kind === 'episode' ? 0.18 : 0;
  return keywordScore * 0.5 + directMention + document.importance * 0.2 + recency * 0.12 + timeBonus;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || !right.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function buildMemoryDocuments(
  facts: MemoryFactRecord[],
  episodes: MemoryEpisodeRecord[],
): MemorySearchDocument[] {
  const factDocs = facts
    .filter((item) => item.archived !== 1)
    .map(
      (item): MemorySearchDocument => ({
        key: `fact:${item.id}`,
        kind: 'fact',
        recordId: item.id,
        title: item.topicKey,
        text: item.content,
        keywords: parseStringArray(item.keywords),
        importance: Number(item.importance ?? 0),
        updatedAt: Number(item.lastSeenAt ?? item.firstSeenAt ?? 0),
        accessedAt: Number(item.lastSeenAt ?? item.firstSeenAt ?? 0),
        embedding: parseEmbedding(item.embedding),
      }),
    );

  const episodeDocs = episodes
    .filter((item) => item.archived !== 1)
    .map(
      (item): MemorySearchDocument => ({
        key: `episode:${item.id}`,
        kind: 'episode',
        recordId: item.id,
        title: item.title,
        text: item.summary,
        keywords: parseStringArray(item.keywords),
        importance: Number(item.importance ?? 0),
        updatedAt: Number(item.lastSeenAt ?? item.firstSeenAt ?? 0),
        accessedAt: Number(item.lastAccessedAt ?? item.lastSeenAt ?? item.firstSeenAt ?? 0),
        embedding: parseEmbedding(item.embedding),
      }),
    );

  return [...factDocs, ...episodeDocs];
}

export function planMemoryRecall(
  query: string,
  documents: MemorySearchDocument[],
  now: number,
  topK: number,
): RecallPlan {
  const explicitRecallCue = hasRecallCue(query);
  const timeCue = hasTimeCue(query);
  const normalizedQuery = normalizeText(query);
  const tokens = tokenizeQuery(query);
  const scored = documents
    .map((document) => {
      const haystack = normalizeText(`${document.title}\n${document.text}\n${document.keywords.join(' ')}`);
      const keywordHits = tokens.filter((token) => haystack.includes(token)).length;
      const directMention = normalizedQuery ? haystack.includes(normalizedQuery) : false;
      const timeMatch = timeCue && document.kind === 'episode';
      return {
        document,
        score: coarseScore(query, tokens, document, now),
        lexicalHit: keywordHits > 0 || directMention || timeMatch,
      };
    })
    .filter(({ score, lexicalHit }) => (explicitRecallCue ? score >= 0.1 : lexicalHit && score >= 0.22))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, topK));

  const candidates = scored.map((item) => item.document);
  const needsSemanticSearch =
    explicitRecallCue && (!candidates.length || scored[0]?.score < 0.58 || candidates.length < Math.min(3, topK));

  return {
    candidates,
    needsSemanticSearch,
    explicitRecallCue,
  };
}

export function rankMemoryDocumentsByVector(
  documents: MemorySearchDocument[],
  queryEmbedding: number[],
  now: number,
  topK: number,
): MemorySearchDocument[] {
  return documents
    .map((document) => {
      const similarity = document.embedding ? cosineSimilarity(queryEmbedding, document.embedding) : 0;
      const recency = 1 / (1 + Math.max(0, now - document.updatedAt) / (30 * DAY_MS));
      const accessRecency = 1 / (1 + Math.max(0, now - document.accessedAt) / (30 * DAY_MS));
      const score = similarity * 0.55 + document.importance * 0.22 + recency * 0.13 + accessRecency * 0.1;
      return { document, score };
    })
    .filter(({ score, document }) => score >= 0.18 || document.importance >= 0.9)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, topK))
    .map(({ document }) => document);
}

export function buildMemoryContextBlock(documents: MemorySearchDocument[], promptBudgetTokens: number): string | null {
  if (!documents.length) return null;
  const facts = documents.filter((item) => item.kind === 'fact');
  const episodes = documents.filter((item) => item.kind === 'episode');
  const lines = ['Relevant Long-Term Memory'];
  const charBudget = Math.max(400, Math.floor(promptBudgetTokens * 2));
  let used = lines.join('\n').length;

  const appendSection = (title: string, entries: string[]): void => {
    if (!entries.length) return;
    lines.push(`${title}:`);
    used += title.length + 2;
    for (const entry of entries) {
      if (used + entry.length + 3 > charBudget) break;
      lines.push(`- ${entry}`);
      used += entry.length + 3;
    }
  };

  appendSection(
    'Stable Facts',
    facts.map((item) => `${item.title}: ${item.text}`),
  );
  appendSection(
    'Relevant Past Episodes',
    episodes.map((item) => `${item.title}: ${item.text}`),
  );

  return lines.length > 1 ? lines.join('\n') : null;
}

export class MemoryV2Store {
  constructor(private readonly database: MemoryV2DatabaseLike) {}

  static ensureTables(ctx: Context): void {
    ctx.model.extend(
      'memory_fact',
      {
        id: 'unsigned',
        scopeType: 'string',
        scopeKey: 'string',
        topicKey: 'string',
        content: 'text',
        keywords: { type: 'text', nullable: true },
        importance: 'double',
        confidence: 'double',
        firstSeenAt: 'double',
        lastSeenAt: 'double',
        sourceMessageIds: { type: 'text', nullable: true },
        embeddingModel: { type: 'string', nullable: true },
        embedding: { type: 'text', nullable: true },
        version: 'unsigned',
        archived: 'unsigned',
      },
      {
        autoInc: true,
        indexes: [['scopeType', 'scopeKey', 'archived'], ['scopeKey', 'topicKey']],
      },
    );

    ctx.model.extend(
      'memory_episode',
      {
        id: 'unsigned',
        scopeType: 'string',
        scopeKey: 'string',
        title: 'string',
        summary: 'text',
        keywords: { type: 'text', nullable: true },
        importance: 'double',
        confidence: 'double',
        periodStart: { type: 'double', nullable: true },
        periodEnd: { type: 'double', nullable: true },
        firstSeenAt: 'double',
        lastSeenAt: 'double',
        lastAccessedAt: { type: 'double', nullable: true },
        sourceMessageIds: { type: 'text', nullable: true },
        embeddingModel: { type: 'string', nullable: true },
        embedding: { type: 'text', nullable: true },
        archived: 'unsigned',
      },
      {
        autoInc: true,
        indexes: [['scopeType', 'scopeKey', 'archived'], ['scopeKey', 'lastSeenAt']],
      },
    );

    ctx.model.extend(
      'memory_job',
      {
        id: 'unsigned',
        jobKey: 'string',
        jobType: 'string',
        status: 'string',
        payload: 'text',
        retryCount: 'unsigned',
        nextRunAt: 'double',
        lastError: { type: 'text', nullable: true },
        createdAt: 'double',
        updatedAt: 'double',
      },
      {
        autoInc: true,
        indexes: [['jobType', 'status', 'nextRunAt'], ['jobKey']],
      },
    );
  }

  async queueExtractJob(payload: ExtractJobPayload, nextRunAt: number): Promise<void> {
    const now = Date.now();
    const jobKey = `extract:${payload.conversationId}`;
    const [existing] = (await this.database.get('memory_job', { jobKey })) as MemoryJobRecord[];
    const serialized = JSON.stringify(payload);
    if (existing?.id) {
      await this.database.set(
        'memory_job',
        { id: existing.id },
        {
          status: 'pending',
          payload: serialized,
          nextRunAt,
          updatedAt: now,
          lastError: null,
        },
      );
      return;
    }

    await this.database.create('memory_job', {
      jobKey,
      jobType: 'extract',
      status: 'pending',
      payload: serialized,
      retryCount: 0,
      nextRunAt,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async listDueJobs(jobType: 'extract' | 'embed', now: number): Promise<MemoryJobRecord[]> {
    const rows = (await this.database.get('memory_job', { jobType, status: 'pending' })) as MemoryJobRecord[];
    return rows.filter((row) => Number(row.nextRunAt ?? 0) <= now).sort((left, right) => left.nextRunAt - right.nextRunAt);
  }

  async getJobSummary(): Promise<MemoryV2QueueSummary> {
    const rows = (await this.database.get('memory_job', {} as Record<string, never>)) as MemoryJobRecord[];
    return rows.reduce<MemoryV2QueueSummary>(
      (summary, row) => {
        if (row.jobType === 'extract' && row.status === 'pending') summary.extractPending += 1;
        if (row.jobType === 'extract' && row.status === 'processing') summary.extractProcessing += 1;
        if (row.jobType === 'embed' && row.status === 'pending') summary.embedPending += 1;
        if (row.jobType === 'embed' && row.status === 'processing') summary.embedProcessing += 1;
        return summary;
      },
      {
        extractPending: 0,
        extractProcessing: 0,
        embedPending: 0,
        embedProcessing: 0,
      },
    );
  }

  async requeueProcessingJobs(): Promise<number> {
    const rows = (await this.database.get('memory_job', {} as Record<string, never>)) as MemoryJobRecord[];
    const processing = rows.filter((row) => row.status === 'processing');
    if (!processing.length) return 0;

    const now = Date.now();
    for (const row of processing) {
      await this.database.set('memory_job', { id: row.id }, {
        status: 'pending',
        nextRunAt: Math.min(Number(row.nextRunAt ?? now) || now, now),
        updatedAt: now,
        lastError: null,
      });
    }
    return processing.length;
  }

  async markJobProcessing(job: MemoryJobRecord): Promise<void> {
    await this.database.set('memory_job', { id: job.id }, { status: 'processing', updatedAt: Date.now(), lastError: null });
  }

  async completeJob(job: MemoryJobRecord): Promise<void> {
    await this.database.remove('memory_job', { id: job.id });
  }

  async retryJob(job: MemoryJobRecord, error: unknown, delayMs: number): Promise<void> {
    await this.database.set('memory_job', { id: job.id }, {
      status: 'pending',
      retryCount: Number(job.retryCount ?? 0) + 1,
      nextRunAt: Date.now() + delayMs,
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    });
  }

  parseExtractJob(job: MemoryJobRecord): ExtractJobPayload | null {
    try {
      const parsed = JSON.parse(job.payload) as Partial<ExtractJobPayload>;
      if (!parsed || typeof parsed !== 'object') return null;
      if (!parsed.conversationId || !parsed.scopeType || !parsed.scopeKey) return null;
      return {
        conversationId: String(parsed.conversationId),
        scopeType: parsed.scopeType === 'user_group' ? 'user_group' : 'user',
        scopeKey: String(parsed.scopeKey),
        maxMessages: Math.max(4, Math.floor(Number(parsed.maxMessages ?? 12))),
      };
    } catch {
      return null;
    }
  }

  parseEmbedJob(job: MemoryJobRecord): EmbedJobPayload | null {
    try {
      const parsed = JSON.parse(job.payload) as Partial<EmbedJobPayload>;
      if (!parsed || typeof parsed !== 'object') return null;
      if (!parsed.recordId || !parsed.recordType) return null;
      return {
        recordId: Math.max(1, Math.floor(Number(parsed.recordId))),
        recordType: parsed.recordType === 'episode' ? 'episode' : 'fact',
      };
    } catch {
      return null;
    }
  }

  async readConversationWindow(conversationId: string, maxMessages: number): Promise<MemoryConversationTurn[]> {
    const [conversation] = (await this.database.get('chathub_conversation', { id: conversationId })) as StoredConversationRecord[];
    if (!conversation?.id || !conversation.latestId) return [];

    const rows = (await this.database.get('chathub_message', { conversation: conversationId })) as StoredMessageRecord[];
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

  async listScopeFacts(scope: MemoryScope): Promise<MemoryFactRecord[]> {
    return (await this.database.get('memory_fact', {
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      archived: 0,
    })) as MemoryFactRecord[];
  }

  async listScopeEpisodes(scope: MemoryScope): Promise<MemoryEpisodeRecord[]> {
    return (await this.database.get('memory_episode', {
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      archived: 0,
    })) as MemoryEpisodeRecord[];
  }

  async listScopeDocuments(scope: MemoryScope): Promise<MemorySearchDocument[]> {
    const [facts, episodes] = await Promise.all([this.listScopeFacts(scope), this.listScopeEpisodes(scope)]);
    return buildMemoryDocuments(facts, episodes);
  }

  private async queueEmbedJob(payload: EmbedJobPayload): Promise<void> {
    const now = Date.now();
    const jobKey = `embed:${payload.recordType}:${payload.recordId}`;
    const [existing] = (await this.database.get('memory_job', { jobKey })) as MemoryJobRecord[];
    const serialized = JSON.stringify(payload);
    if (existing?.id) {
      await this.database.set('memory_job', { id: existing.id }, {
        status: 'pending',
        payload: serialized,
        nextRunAt: now,
        updatedAt: now,
        lastError: null,
      });
      return;
    }

    await this.database.create('memory_job', {
      jobKey,
      jobType: 'embed',
      status: 'pending',
      payload: serialized,
      retryCount: 0,
      nextRunAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  private buildEpisodeRecord(
    existing: MemoryEpisodeRecord | null,
    incoming: ExtractedMemoryEpisode,
    now: number,
    sourceMessageIds: string[],
  ): Omit<MemoryEpisodeRecord, 'id'> {
    const keywords = uniqueKeywords([
      ...(existing ? parseStringArray(existing.keywords) : []),
      ...(incoming.keywords ?? []),
    ]);
    return {
      scopeType: existing?.scopeType ?? 'user',
      scopeKey: existing?.scopeKey ?? '',
      title: incoming.title.trim(),
      summary: incoming.summary.trim(),
      keywords: keywords.length ? stringifyStringArray(keywords) : null,
      importance: Math.max(Number(existing?.importance ?? 0), Number(incoming.importance ?? 0.58)),
      confidence: Math.max(Number(existing?.confidence ?? 0), Number(incoming.confidence ?? 0.78)),
      periodStart: toTimestamp(incoming.periodStart) ?? existing?.periodStart ?? null,
      periodEnd: toTimestamp(incoming.periodEnd) ?? existing?.periodEnd ?? null,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      lastAccessedAt: existing?.lastAccessedAt ?? null,
      sourceMessageIds: stringifyStringArray([...(existing ? parseStringArray(existing.sourceMessageIds) : []), ...sourceMessageIds]),
      embeddingModel: existing?.embeddingModel ?? null,
      embedding: existing?.embedding ?? null,
      archived: 0,
    };
  }

  private findEpisodeMatch(
    existingRows: MemoryEpisodeRecord[],
    incoming: ExtractedMemoryEpisode,
  ): MemoryEpisodeRecord | null {
    const incomingKeywords = uniqueKeywords(incoming.keywords ?? []);
    const incomingFingerprint = buildEpisodeFingerprint(incoming.title, incomingKeywords);
    const incomingStart = toTimestamp(incoming.periodStart);
    for (const row of existingRows) {
      const rowKeywords = parseStringArray(row.keywords);
      const sameFingerprint = incomingFingerprint === buildEpisodeFingerprint(row.title, rowKeywords);
      const overlap = keywordOverlap(incomingKeywords, rowKeywords);
      const timeClose =
        incomingStart == null ||
        row.periodStart == null ||
        Math.abs(incomingStart - row.periodStart) <= 45 * DAY_MS;
      if (sameFingerprint || (overlap >= 0.5 && timeClose)) {
        return row;
      }
    }
    return null;
  }

  async applyExtraction(
    scope: MemoryScope,
    extraction: MemoryExtractionResult,
    sourceMessageIds: string[],
  ): Promise<void> {
    const now = Date.now();
    const existingFacts = await this.listScopeFacts(scope);
    const existingEpisodes = await this.listScopeEpisodes(scope);
    const factMap = new Map(existingFacts.map((item) => [item.topicKey, item]));

    for (const fact of extraction.facts) {
      const topicKey = deriveTopicKey(fact);
      const existing = factMap.get(topicKey) ?? null;
      const record = mergeFactRecord(existing, fact, now, sourceMessageIds);
      record.scopeType = scope.scopeType;
      record.scopeKey = scope.scopeKey;
      record.topicKey = topicKey;
      record.embedding = null;
      record.embeddingModel = null;
      if (existing?.id) {
        await this.database.set('memory_fact', { id: existing.id }, record);
        await this.queueEmbedJob({ recordType: 'fact', recordId: existing.id });
      } else {
        const created = (await this.database.create('memory_fact', record)) as unknown as MemoryFactRecord;
        await this.queueEmbedJob({ recordType: 'fact', recordId: Number(created.id) });
      }
    }

    for (const episode of extraction.episodes) {
      const existing = this.findEpisodeMatch(existingEpisodes, episode);
      const record = this.buildEpisodeRecord(existing, episode, now, sourceMessageIds);
      record.scopeType = scope.scopeType;
      record.scopeKey = scope.scopeKey;
      record.embedding = null;
      record.embeddingModel = null;
      if (existing?.id) {
        await this.database.set('memory_episode', { id: existing.id }, record);
        await this.queueEmbedJob({ recordType: 'episode', recordId: existing.id });
      } else {
        const created = (await this.database.create('memory_episode', record)) as unknown as MemoryEpisodeRecord;
        await this.queueEmbedJob({ recordType: 'episode', recordId: Number(created.id) });
      }
    }
  }

  async resolveEmbedJob(job: MemoryJobRecord): Promise<{ payload: EmbedJobPayload; text: string } | null> {
    const payload = this.parseEmbedJob(job);
    if (!payload) return null;
    if (payload.recordType === 'fact') {
      const [row] = (await this.database.get('memory_fact', { id: payload.recordId })) as MemoryFactRecord[];
      if (!row?.id || row.archived === 1) return null;
      return { payload, text: row.content.trim() };
    }

    const [row] = (await this.database.get('memory_episode', { id: payload.recordId })) as MemoryEpisodeRecord[];
    if (!row?.id || row.archived === 1) return null;
    return { payload, text: `${row.title.trim()}\n${row.summary.trim()}`.trim() };
  }

  async applyEmbedding(payload: EmbedJobPayload, model: string, embedding: number[]): Promise<void> {
    const patch = {
      embeddingModel: model,
      embedding: stringifyEmbedding(embedding),
    };
    if (payload.recordType === 'fact') {
      await this.database.set('memory_fact', { id: payload.recordId }, patch);
      return;
    }
    await this.database.set('memory_episode', { id: payload.recordId }, patch);
  }

  async touchEpisodes(ids: number[]): Promise<void> {
    const now = Date.now();
    for (const id of ids) {
      await this.database.set('memory_episode', { id }, { lastAccessedAt: now, lastSeenAt: now });
    }
  }

  async archiveExpiredEpisodes(archiveDays: number): Promise<void> {
    const threshold = Date.now() - archiveDays * DAY_MS;
    const rows = (await this.database.get('memory_episode', { archived: 0 })) as MemoryEpisodeRecord[];
    for (const row of rows) {
      const lastTouched = Number(row.lastAccessedAt ?? row.lastSeenAt ?? row.firstSeenAt ?? 0);
      if (row.importance >= 0.85) continue;
      if (lastTouched > threshold) continue;
      await this.database.set('memory_episode', { id: row.id }, { archived: 1, lastSeenAt: Date.now() });
    }
  }
}
