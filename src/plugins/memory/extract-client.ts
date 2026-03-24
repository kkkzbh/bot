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

export interface ExtractedMemoryFact {
  topicKey?: string;
  content: string;
  keywords?: string[];
  importance?: number;
  confidence?: number;
}

export interface ExtractedMemoryEpisode {
  title: string;
  summary: string;
  keywords?: string[];
  importance?: number;
  confidence?: number;
  periodStart?: string | number | null;
  periodEnd?: string | number | null;
}

export interface MemoryExtractionResult {
  facts: ExtractedMemoryFact[];
  episodes: ExtractedMemoryEpisode[];
  drop: string[];
}

const MEMORY_EXTRACTION_JSON_SCHEMA = {
  name: 'memory_extraction_v1',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      facts: {
        type: 'array',
        description:
          '只记录用户相关、未来仍值得保留的稳定事实、偏好、长期计划、持续关系、明确禁忌。不得记录助手 persona、角色设定、说话风格、台词、临时情绪、挑衅演绎、普通寒暄或一次性指令。',
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            topicKey: {
              type: 'string',
              description: '稳定英文或 kebab-case 主题键，例如 preference-music、plan-job-change。',
            },
            content: {
              type: 'string',
              description: '对用户长期记忆的简洁陈述。',
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
          required: ['topicKey', 'content', 'keywords', 'importance', 'confidence'],
        },
      },
      episodes: {
        type: 'array',
        description:
          '只记录可供以后回忆的阶段性事件。不要记录普通寒暄、无意义重复、纯角色扮演冲突，或仅反映助手 persona 的内容。',
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: {
              type: 'string',
              description: '简短事件标题。',
            },
            summary: {
              type: 'string',
              description: '可供以后回忆的事件摘要，不要复制原文。',
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
          required: ['title', 'summary', 'keywords', 'importance', 'confidence', 'periodStart', 'periodEnd'],
        },
      },
      drop: {
        type: 'array',
        description: '明确说明被丢弃的信息类型或原因。',
        items: { type: 'string' },
        maxItems: 12,
      },
    },
    required: ['facts', 'episodes', 'drop'],
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

function normalizeFact(raw: unknown): ExtractedMemoryFact | null {
  if (!raw || typeof raw !== 'object') return null;
  const fact = raw as Record<string, unknown>;
  const content = typeof fact.content === 'string' ? fact.content.trim() : '';
  if (!content) return null;
  const topicKey = typeof fact.topicKey === 'string' ? fact.topicKey.trim() : '';
  return {
    ...(topicKey ? { topicKey } : {}),
    content,
    keywords: normalizeKeywords(fact.keywords),
    importance: normalizeScore(fact.importance, 0.55),
    confidence: normalizeScore(fact.confidence, 0.8),
  };
}

function normalizeEpisode(raw: unknown): ExtractedMemoryEpisode | null {
  if (!raw || typeof raw !== 'object') return null;
  const episode = raw as Record<string, unknown>;
  const title = typeof episode.title === 'string' ? episode.title.trim() : '';
  const summary = typeof episode.summary === 'string' ? episode.summary.trim() : '';
  if (!title || !summary) return null;
  return {
    title,
    summary,
    keywords: normalizeKeywords(episode.keywords),
    importance: normalizeScore(episode.importance, 0.58),
    confidence: normalizeScore(episode.confidence, 0.78),
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
    const facts = Array.isArray(parsed.facts) ? parsed.facts.map(normalizeFact).filter(Boolean) : [];
    const episodes = Array.isArray(parsed.episodes) ? parsed.episodes.map(normalizeEpisode).filter(Boolean) : [];
    const drop = Array.isArray(parsed.drop)
      ? parsed.drop.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
    return { facts, episodes, drop } as MemoryExtractionResult;
  } catch {
    return null;
  }
}

function buildExtractionPrompt(turns: MemoryConversationTurn[]): string {
  const transcript = turns
    .map((turn) => `${turn.role === 'human' ? '用户' : '助手'}: ${turn.text}`)
    .join('\n');

  return ['对话记录：', transcript].join('\n');
}

export async function extractLongMemory(
  runtime: MemoryExtractRuntime,
  turns: MemoryConversationTurn[],
): Promise<MemoryExtractionResult> {
  if (!isExtractRuntimeConfigured(runtime)) {
    return { facts: [], episodes: [], drop: [] };
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
            content: '请根据提供的 schema 提取长期记忆。',
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
