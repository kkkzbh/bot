import type {
  MemoryOutputProtocolId,
  MemoryProfileKind,
  MemorySensitivity,
  MemoryVisibility,
} from '../../../types/memory-v3.js';
import type { ExtractedMemoryCandidate } from '../gates.js';
import { clampScore, uniqueKeywords } from '../format.js';

export interface MemoryConversationTurn {
  id: string;
  role: 'human' | 'ai';
  text: string;
}

const PROFILE_KINDS = new Set<MemoryProfileKind>(['identity', 'preference', 'trait', 'boundary', 'plan', 'relationship']);
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

export const MEMORY_CANDIDATE_JSON_SCHEMA = {
  name: 'memory_extraction_v3',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      facts: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            subject: { type: 'string', enum: ['user'] },
            kind: { type: 'string', enum: ['identity', 'preference', 'trait', 'boundary', 'plan', 'relationship'] },
            topicKey: { type: 'string' },
            content: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' }, maxItems: 12 },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            sensitivity: { type: 'string', enum: ['low', 'personal', 'sensitive', 'secret'] },
            suggestedVisibility: {
              type: 'string',
              enum: ['global', 'private_only', 'source_context_only', 'allowed_contexts', 'denied_contexts', 'pending_review', 'archived'],
            },
            applicability: { type: ['string', 'null'] },
            evidence: { type: ['string', 'null'] },
            conflictHint: { type: ['string', 'null'] },
            validFrom: { type: ['string', 'null'] },
            validUntil: { type: ['string', 'null'] },
            expiresAt: { type: ['string', 'null'] },
          },
          required: [
            'subject',
            'kind',
            'topicKey',
            'content',
            'keywords',
            'importance',
            'confidence',
            'sensitivity',
            'suggestedVisibility',
            'applicability',
            'evidence',
            'conflictHint',
            'validFrom',
            'validUntil',
            'expiresAt',
          ],
        },
      },
      episodes: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            subject: { type: 'string', enum: ['user'] },
            title: { type: 'string' },
            summary: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' }, maxItems: 12 },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            periodStart: { type: ['string', 'null'] },
            periodEnd: { type: ['string', 'null'] },
            sensitivity: { type: 'string', enum: ['low', 'personal', 'sensitive', 'secret'] },
            suggestedVisibility: {
              type: 'string',
              enum: ['global', 'private_only', 'source_context_only', 'allowed_contexts', 'denied_contexts', 'pending_review', 'archived'],
            },
            applicability: { type: ['string', 'null'] },
            evidence: { type: ['string', 'null'] },
            validFrom: { type: ['string', 'null'] },
            validUntil: { type: ['string', 'null'] },
            expiresAt: { type: ['string', 'null'] },
          },
          required: [
            'subject',
            'title',
            'summary',
            'keywords',
            'importance',
            'confidence',
            'periodStart',
            'periodEnd',
            'sensitivity',
            'suggestedVisibility',
            'applicability',
            'evidence',
            'validFrom',
            'validUntil',
            'expiresAt',
          ],
        },
      },
      drops: {
        type: 'array',
        maxItems: 12,
        items: { type: 'string' },
      },
    },
    required: ['facts', 'episodes', 'drops'],
  },
} as const;

export function buildMemoryExtractionPrompt(turns: MemoryConversationTurn[], protocol: MemoryOutputProtocolId): string {
  const transcript = turns.map((turn) => `${turn.role === 'human' ? '用户' : '助手'}: ${turn.text}`).join('\n');
  const base = [
    '提取“助手对这个用户的长期记忆候选”，不要记录只关于助手 persona、设定、口头禅、兴趣或角色扮演的内容。',
    '长期记忆候选分为 fact 和 episode。fact 用于稳定身份、偏好、特点、边界、长期计划、关系；episode 用于将来值得回忆的用户相关事件。',
    '不要把群聊玩笑、外号、梗、第三方隐私、API key、token、password 写成长期记忆。',
    'visibility 建议：低风险稳定用户偏好可 global；私密信息 private_only；群聊来源默认 source_context_only；不确定则 pending_review。',
    'sensitivity 建议：普通偏好 low，个人信息 personal，隐私/健康/账号 sensitive，密钥 secret。',
  ];

  if (protocol === 'plain_text_memory_v1') {
    base.push(
      '只输出一个 <memory_extraction_v3> bounded block，不要输出解释。',
      '每行格式只能是：',
      'FACT|kind=preference|topic=answer-style|visibility=global|sensitivity=low|confidence=0.82|importance=0.70|用户喜欢简洁直接的技术回答',
      'EPISODE|title=重构 memory-v3|date=2026-06-09|visibility=private_only|sensitivity=personal|confidence=0.80|importance=0.70|用户正在重构 kbot 的长期记忆系统',
      'DROP|群聊玩笑，不应泛化为全局偏好',
    );
  } else {
    base.push('严格按提供的 JSON schema 输出 facts、episodes、drops。');
  }

  return [...base, '对话记录：', transcript].join('\n');
}

function normalizeVisibility(value: unknown): MemoryVisibility | null {
  return typeof value === 'string' && VISIBILITIES.has(value as MemoryVisibility) ? value as MemoryVisibility : null;
}

function normalizeSensitivity(value: unknown): MemorySensitivity | null {
  return typeof value === 'string' && SENSITIVITIES.has(value as MemorySensitivity) ? value as MemorySensitivity : null;
}

function normalizeFact(raw: unknown): ExtractedMemoryCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const kind = typeof item.kind === 'string' && PROFILE_KINDS.has(item.kind as MemoryProfileKind)
    ? item.kind as MemoryProfileKind
    : null;
  const content = typeof item.content === 'string' ? item.content.trim() : '';
  const topicKey = typeof item.topicKey === 'string' ? item.topicKey.trim() : '';
  const visibility = normalizeVisibility(item.suggestedVisibility);
  const sensitivity = normalizeSensitivity(item.sensitivity);
  if (item.subject !== 'user' || !kind || !content || !topicKey || !visibility || !sensitivity) return null;
  return {
    candidateType: 'fact',
    subject: 'user',
    kind,
    topicKey,
    content,
    keywords: uniqueKeywords(Array.isArray(item.keywords) ? item.keywords.map(String) : []),
    importance: clampScore(item.importance, 0.6),
    confidence: clampScore(item.confidence, 0.8),
    sensitivity,
    suggestedVisibility: visibility,
    applicability: typeof item.applicability === 'string' ? item.applicability : null,
    evidence: typeof item.evidence === 'string' ? item.evidence : null,
    conflictHint: typeof item.conflictHint === 'string' ? item.conflictHint : null,
    validFrom: typeof item.validFrom === 'string' || typeof item.validFrom === 'number' ? item.validFrom : null,
    validUntil: typeof item.validUntil === 'string' || typeof item.validUntil === 'number' ? item.validUntil : null,
    expiresAt: typeof item.expiresAt === 'string' || typeof item.expiresAt === 'number' ? item.expiresAt : null,
  };
}

function normalizeEpisode(raw: unknown): ExtractedMemoryCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
  const visibility = normalizeVisibility(item.suggestedVisibility);
  const sensitivity = normalizeSensitivity(item.sensitivity);
  if (item.subject !== 'user' || !title || !summary || !visibility || !sensitivity) return null;
  return {
    candidateType: 'episode',
    subject: 'user',
    title,
    summary,
    keywords: uniqueKeywords(Array.isArray(item.keywords) ? item.keywords.map(String) : []),
    importance: clampScore(item.importance, 0.62),
    confidence: clampScore(item.confidence, 0.8),
    sensitivity,
    suggestedVisibility: visibility,
    periodStart: typeof item.periodStart === 'string' || typeof item.periodStart === 'number' ? item.periodStart : null,
    periodEnd: typeof item.periodEnd === 'string' || typeof item.periodEnd === 'number' ? item.periodEnd : null,
    applicability: typeof item.applicability === 'string' ? item.applicability : null,
    evidence: typeof item.evidence === 'string' ? item.evidence : null,
    validFrom: typeof item.validFrom === 'string' || typeof item.validFrom === 'number' ? item.validFrom : null,
    validUntil: typeof item.validUntil === 'string' || typeof item.validUntil === 'number' ? item.validUntil : null,
    expiresAt: typeof item.expiresAt === 'string' || typeof item.expiresAt === 'number' ? item.expiresAt : null,
  };
}

export function parseMemoryExtractionJson(text: string): ExtractedMemoryCandidate[] {
  const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
  const facts = Array.isArray(parsed.facts) ? parsed.facts.map(normalizeFact).filter(Boolean) : [];
  const episodes = Array.isArray(parsed.episodes) ? parsed.episodes.map(normalizeEpisode).filter(Boolean) : [];
  const drops = Array.isArray(parsed.drops)
    ? parsed.drops.map((item): ExtractedMemoryCandidate | null => {
      const reason = typeof item === 'string' ? item.trim() : '';
      return reason
        ? {
            candidateType: 'drop',
            subject: 'user',
            dropReason: reason,
            keywords: [],
            importance: 0,
            confidence: 1,
            sensitivity: 'low',
            suggestedVisibility: 'archived',
          }
        : null;
    }).filter(Boolean)
    : [];
  return [...facts, ...episodes, ...drops] as ExtractedMemoryCandidate[];
}
