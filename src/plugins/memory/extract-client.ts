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

  return [
    '你负责把聊天提炼成长期记忆。',
    '只保留以后仍值得记住的稳定事实或阶段事件，不要保留普通寒暄、一次性问题、泛泛情绪、无意义闲聊。',
    'facts 只收稳定背景、偏好、长期计划、持续关系、明确禁忌等。',
    'episodes 只收阶段性事件，标题要短，summary 要可供以后回忆，不要复制原文。',
    'topicKey 使用稳定的英文或 kebab-case 主题键，例如 preference-music、plan-job-change。',
    '如果没有值得长期保存的内容，返回空数组。',
    '严格只输出 JSON，不要加解释。',
    'JSON 结构如下：',
    '{"facts":[{"topicKey":"string","content":"string","keywords":["string"],"importance":0.0,"confidence":0.0}],"episodes":[{"title":"string","summary":"string","keywords":["string"],"importance":0.0,"confidence":0.0,"periodStart":"YYYY-MM-DD|null","periodEnd":"YYYY-MM-DD|null"}],"drop":["string"]}',
    '',
    transcript,
  ].join('\n');
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
        messages: [
          {
            role: 'system',
            content:
              '你是长期记忆提炼器。你的唯一输出必须是合法 JSON，不能有解释、不能有 Markdown、不能有额外文字。',
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
