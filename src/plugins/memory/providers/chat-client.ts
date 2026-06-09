import {
  MEMORY_CANDIDATE_JSON_SCHEMA,
  buildMemoryExtractionPrompt,
  parseMemoryExtractionJson,
  type MemoryConversationTurn,
  type MemoryExtractionTarget,
} from './schemas.js';
import type { ExtractedMemoryCandidate } from '../gates.js';
import type { MemoryProviderProfile } from './router.js';

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
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

export async function requestChatMemoryJson(
  profile: MemoryProviderProfile,
  turns: MemoryConversationTurn[],
  target: MemoryExtractionTarget,
): Promise<{ candidates: ExtractedMemoryCandidate[]; rawText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
  try {
    const response = await fetch(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: profile.model,
        temperature: 0.1,
        response_format: {
          type: 'json_schema',
          json_schema: MEMORY_CANDIDATE_JSON_SCHEMA,
        },
        messages: [
          { role: 'system', content: '按 memory_extraction schema 提取长期记忆候选。' },
          { role: 'user', content: buildMemoryExtractionPrompt(turns, 'native_chat_json_schema', target) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`extract_http_${response.status}`);
    const payload = await response.json() as ChatCompletionResponse;
    const rawText = extractResponseText(payload.choices?.[0]?.message?.content);
    return { candidates: parseMemoryExtractionJson(rawText), rawText };
  } finally {
    clearTimeout(timer);
  }
}

export async function requestChatMemoryPlainText(
  profile: MemoryProviderProfile,
  turns: MemoryConversationTurn[],
  target: MemoryExtractionTarget,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
  try {
    const response = await fetch(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: profile.model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: '只输出 memory_extraction bounded block。' },
          { role: 'user', content: buildMemoryExtractionPrompt(turns, 'plain_text_memory_v1', target) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`extract_http_${response.status}`);
    const payload = await response.json() as ChatCompletionResponse;
    return extractResponseText(payload.choices?.[0]?.message?.content);
  } finally {
    clearTimeout(timer);
  }
}
