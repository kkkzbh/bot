import type { MemoryEpisodeRecord, MemoryFactRecord, MemoryRecordType, MemoryScopeType, MemorySensitivity } from '../../types/memory.js';
import { cosineSimilarity, parseEmbedding, parseJsonArray } from './format.js';

const DAY_MS = 86_400_000;
const CHINESE_STOP_WORDS = new Set(['什么', '怎么', '还是', '就是', '然后', '现在', '今天', '一下', '这个', '那个']);

export interface MemorySearchDocument {
  key: string;
  type: MemoryRecordType;
  id: number;
  title: string;
  text: string;
  keywords: string[];
  importance: number;
  confidence: number;
  updatedAt: number;
  accessedAt: number;
  embedding: number[] | null;
  sourceContextKey: string | null;
  scopeType: MemoryScopeType | null;
  sensitivity: MemorySensitivity;
}

export interface RankedMemoryDocument {
  document: MemorySearchDocument;
  score: number;
  reason: string;
}

export function tokenizeMemoryQuery(text: string): string[] {
  const normalized = text.trim().toLowerCase();
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

export function hasRecallCue(text: string): boolean {
  return /还记得|记得吗|想起来|回忆|之前|以前|上次|上个月|去年|那次|当时|提过/.test(text);
}

export function buildFactDocument(fact: MemoryFactRecord): MemorySearchDocument {
  return {
    key: `fact:${fact.id}`,
    type: 'fact',
    id: fact.id,
    title: `${fact.kind}:${fact.topicKey}`,
    text: fact.content,
    keywords: parseJsonArray(fact.keywords),
    importance: Number(fact.importance ?? 0),
    confidence: Number(fact.confidence ?? 0),
    updatedAt: Number(fact.lastSeenAt ?? fact.firstSeenAt ?? 0),
    accessedAt: Number(fact.lastAccessedAt ?? fact.lastSeenAt ?? fact.firstSeenAt ?? 0),
    embedding: parseEmbedding(fact.embedding),
    sourceContextKey: fact.sourceContextKey,
    scopeType: fact.scopeType,
    sensitivity: fact.sensitivity,
  };
}

export function buildEpisodeDocument(episode: MemoryEpisodeRecord): MemorySearchDocument {
  return {
    key: `episode:${episode.id}`,
    type: 'episode',
    id: episode.id,
    title: episode.title,
    text: episode.summary,
    keywords: parseJsonArray(episode.keywords),
    importance: Number(episode.importance ?? 0),
    confidence: Number(episode.confidence ?? 0),
    updatedAt: Number(episode.lastSeenAt ?? episode.firstSeenAt ?? 0),
    accessedAt: Number(episode.lastAccessedAt ?? episode.lastSeenAt ?? episode.firstSeenAt ?? 0),
    embedding: parseEmbedding(episode.embedding),
    sourceContextKey: episode.sourceContextKey,
    scopeType: episode.scopeType,
    sensitivity: episode.sensitivity,
  };
}

export function rankMemoryDocumentsDetailed(input: {
  query: string;
  documents: MemorySearchDocument[];
  now: number;
  topK: number;
  queryEmbedding?: number[] | null;
  contextKey?: string | null;
}): RankedMemoryDocument[] {
  const tokens = tokenizeMemoryQuery(input.query);
  const normalizedQuery = input.query.trim().toLowerCase();
  return input.documents
    .map((document) => {
      const haystack = `${document.title}\n${document.text}\n${document.keywords.join(' ')}`.toLowerCase();
      const keywordHits = tokens.filter((token) => haystack.includes(token)).length;
      const keywordScore = tokens.length ? keywordHits / tokens.length : 0;
      const directMention = normalizedQuery && haystack.includes(normalizedQuery) ? 1 : 0;
      const recency = 1 / (1 + Math.max(0, input.now - document.updatedAt) / (30 * DAY_MS));
      const accessRecency = 1 / (1 + Math.max(0, input.now - document.accessedAt) / (30 * DAY_MS));
      const semantic = input.queryEmbedding && document.embedding
        ? Math.max(0, cosineSimilarity(input.queryEmbedding, document.embedding))
        : 0;
      const sameContext = input.contextKey && document.sourceContextKey === input.contextKey ? 1 : 0;
      const groupSensitivityPenalty = document.sensitivity === 'personal' ? 0.04 : 0;
      const score =
        semantic * 0.42 +
        keywordScore * 0.23 +
        document.importance * 0.12 +
        document.confidence * 0.08 +
        recency * 0.06 +
        sameContext * 0.06 +
        directMention * 0.03 +
        accessRecency * 0.02 -
        groupSensitivityPenalty;
      const reasons = [
        semantic > 0 ? 'semantic' : '',
        keywordHits > 0 ? 'keyword' : '',
        sameContext ? 'same_context' : '',
        directMention ? 'direct_mention' : '',
        document.importance >= 0.75 ? 'important' : '',
      ].filter(Boolean);
      return {
        document,
        score,
        reason: reasons.join('+') || (document.type === 'episode' && hasRecallCue(input.query) ? 'recall_cue' : 'ranked'),
        lexicalHit: keywordHits > 0 || Boolean(directMention),
      };
    })
    .filter(({ score, lexicalHit, document }) => {
      if (document.type === 'fact') return score >= 0.12 || document.importance >= 0.75;
      return hasRecallCue(input.query) ? score >= 0.1 : lexicalHit && score >= 0.2;
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, input.topK))
    .map((item) => ({ document: item.document, score: item.score, reason: item.reason }));
}

export function rankMemoryDocuments(input: {
  query: string;
  documents: MemorySearchDocument[];
  now: number;
  topK: number;
  queryEmbedding?: number[] | null;
  contextKey?: string | null;
}): MemorySearchDocument[] {
  return rankMemoryDocumentsDetailed(input).map((item) => item.document);
}
