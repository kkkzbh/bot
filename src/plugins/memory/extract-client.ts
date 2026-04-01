import type { MemoryProfileKind } from '../../types/memory-v2.js';

export interface MemoryConversationTurn {
  id: string;
  role: 'human' | 'ai';
  text: string;
}

export interface MemoryExtractRuntime {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface ExtractedMemoryProfileItem {
  subject: 'user';
  kind: MemoryProfileKind;
  topicKey?: string;
  content: string;
  keywords?: string[];
  importance?: number;
  confidence?: number;
}

export interface ExtractedMemoryEpisode {
  subject: 'user';
  title: string;
  summary: string;
  keywords?: string[];
  importance?: number;
  confidence?: number;
  periodStart?: string | number | null;
  periodEnd?: string | number | null;
}

export interface MemoryExtractionResult {
  profileItems: ExtractedMemoryProfileItem[];
  episodes: ExtractedMemoryEpisode[];
  drop: string[];
}

const PROFILE_KINDS = new Set<MemoryProfileKind>(['identity', 'preference', 'trait', 'boundary', 'plan', 'relationship']);
const BOT_ONLY_PREFIX = /^(助手|bot|AI|小祥|祥子|丰川祥子)[：:，,\s]?/i;
const PROFILE_CONTENT_PREFIX = /^用户[：:，,\s]?/;
const EPISODE_CONTENT_PREFIX = /^(用户|我)[：:，,\s]?/;

const MEMORY_EXTRACTION_JSON_SCHEMA = {
  name: 'memory_extraction_v1',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      profile_items: {
        type: 'array',
        description:
          '只记录用户画像：用户身份信息、稳定偏好、行为特点、边界禁忌、长期计划、持续关系信号。绝不记录只关于我的 persona、兴趣、设定、台词、情绪、口头禅或角色扮演内容。',
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            subject: {
              type: 'string',
              enum: ['user'],
              description: '固定为 user。',
            },
            kind: {
              type: 'string',
              enum: ['identity', 'preference', 'trait', 'boundary', 'plan', 'relationship'],
            },
            topicKey: {
              type: 'string',
              description: '稳定英文或 kebab-case 主题键，例如 preferred-name、boundary-name-test。',
            },
            content: {
              type: 'string',
              description: '自然、简洁、可复用的用户画像描述，必须以“用户”开头。',
            },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 12,
            },
            importance: {
              type: 'number',
              minimum: 0,
              maximum: 1,
            },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
            },
          },
          required: ['subject', 'kind', 'topicKey', 'content', 'keywords', 'importance', 'confidence'],
        },
      },
      episodes: {
        type: 'array',
        description:
          '只记录与用户有关、以后值得回忆的互动事件。summary 可以用“我”来写用户如何对待我，但不能变成自我介绍、persona 摘抄或只关于我的记忆。',
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            subject: {
              type: 'string',
              enum: ['user'],
              description: '固定为 user。',
            },
            title: {
              type: 'string',
              description: '简短事件标题。',
            },
            summary: {
              type: 'string',
              description: '自然描述用户相关事件；可以写“我被……”，但必须体现用户特点、偏好、边界或互动模式。',
            },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 12,
            },
            importance: {
              type: 'number',
              minimum: 0,
              maximum: 1,
            },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
            },
            periodStart: {
              type: ['string', 'null'],
              description: 'YYYY-MM-DD 或 null。',
            },
            periodEnd: {
              type: ['string', 'null'],
              description: 'YYYY-MM-DD 或 null。',
            },
          },
          required: ['subject', 'title', 'summary', 'keywords', 'importance', 'confidence', 'periodStart', 'periodEnd'],
        },
      },
      drop: {
        type: 'array',
        description: '明确说明被丢弃的信息类型或原因。',
        items: { type: 'string' },
        maxItems: 12,
      },
    },
    required: ['profile_items', 'episodes', 'drop'],
  },
} as const;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

export function isExtractRuntimeConfigured(runtime: MemoryExtractRuntime): boolean {
  return Boolean(runtime.baseUrl.trim() && runtime.apiKey.trim() && runtime.model.trim());
}

export function extractResponseText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
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

function normalizeScore(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean))].slice(0, 12);
}

function normalizeProfileItem(raw: unknown): ExtractedMemoryProfileItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const subject = item.subject === 'user' ? 'user' : null;
  const kind = typeof item.kind === 'string' && PROFILE_KINDS.has(item.kind as MemoryProfileKind)
    ? (item.kind as MemoryProfileKind)
    : null;
  const content = typeof item.content === 'string' ? item.content.trim() : '';
  if (!subject || !kind || !content) return null;
  if (!PROFILE_CONTENT_PREFIX.test(content) || BOT_ONLY_PREFIX.test(content)) return null;

  const topicKey = typeof item.topicKey === 'string' ? item.topicKey.trim() : '';
  return {
    subject,
    kind,
    ...(topicKey ? { topicKey } : {}),
    content,
    keywords: normalizeKeywords(item.keywords),
    importance: normalizeScore(item.importance, 0.6),
    confidence: normalizeScore(item.confidence, 0.82),
  };
}

function normalizeEpisode(raw: unknown): ExtractedMemoryEpisode | null {
  if (!raw || typeof raw !== 'object') return null;
  const episode = raw as Record<string, unknown>;
  const subject = episode.subject === 'user' ? 'user' : null;
  const title = typeof episode.title === 'string' ? episode.title.trim() : '';
  const summary = typeof episode.summary === 'string' ? episode.summary.trim() : '';
  if (!subject || !title || !summary) return null;
  if (!EPISODE_CONTENT_PREFIX.test(summary) || BOT_ONLY_PREFIX.test(summary)) return null;
  return {
    subject,
    title,
    summary,
    keywords: normalizeKeywords(episode.keywords),
    importance: normalizeScore(episode.importance, 0.62),
    confidence: normalizeScore(episode.confidence, 0.8),
    periodStart:
      typeof episode.periodStart === 'string' || typeof episode.periodStart === 'number' ? episode.periodStart : null,
    periodEnd: typeof episode.periodEnd === 'string' || typeof episode.periodEnd === 'number' ? episode.periodEnd : null,
  };
}

export function parseExtractionResponse(text: string): MemoryExtractionResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const profileItems = Array.isArray(parsed.profile_items)
      ? parsed.profile_items.map(normalizeProfileItem).filter(Boolean)
      : [];
    const episodes = Array.isArray(parsed.episodes) ? parsed.episodes.map(normalizeEpisode).filter(Boolean) : [];
    const drop = Array.isArray(parsed.drop)
      ? parsed.drop.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
    return { profileItems, episodes, drop } as MemoryExtractionResult;
  } catch {
    return null;
  }
}

function buildExtractionPrompt(turns: MemoryConversationTurn[]): string {
  const transcript = turns
    .map((turn) => `${turn.role === 'human' ? '用户' : '我'}: ${turn.text}`)
    .join('\n');

  return [
    '只提取“我对用户的长期记忆”，不要记录只关于我的信息。',
    '允许的长期记忆只有两类：',
    '1. 用户画像：稳定偏好、身份、行为特点、边界禁忌、长期计划、持续关系信号。',
    '2. 用户相关事件：以后值得回忆的互动事件，必须体现用户特征或用户如何对待我。',
    '坏例：',
    '- 助手喜欢音乐。',
    '- 助手对 Ave Mujica 感兴趣。',
    '- 助手昵称是小祥。',
    '好例：',
    '- 用户🥚会反复用“读名字”验证我发音，属于试探边界/验证反应的行为模式。',
    '- 我被用户反复要求念名字，以测试我的发音是否稳定。',
    '对话记录：',
    transcript,
  ].join('\n');
}

export async function extractLongMemory(
  runtime: MemoryExtractRuntime,
  turns: MemoryConversationTurn[],
): Promise<MemoryExtractionResult> {
  if (!isExtractRuntimeConfigured(runtime)) {
    return { profileItems: [], episodes: [], drop: [] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
  try {
    const response = await fetch(`${runtime.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtime.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: runtime.model,
        temperature: 0.2,
        response_format: {
          type: 'json_schema',
          json_schema: MEMORY_EXTRACTION_JSON_SCHEMA,
        },
        messages: [
          {
            role: 'system',
            content: '请根据提供的 schema 提取我对用户的长期记忆。',
          },
          {
            role: 'user',
            content: buildExtractionPrompt(turns),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`extract_http_${response.status}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const content = extractResponseText(payload.choices?.[0]?.message?.content);
    const parsed = parseExtractionResponse(content);
    if (!parsed) {
      throw new Error('extract_invalid_json');
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}
