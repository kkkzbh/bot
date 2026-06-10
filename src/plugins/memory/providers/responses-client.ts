import type { ExtractedMemoryCandidate } from '../gates.js';
import type { MemoryProviderProfile } from './router.js';
import {
  MEMORY_CANDIDATE_JSON_SCHEMA,
  buildMemoryExtractionPrompt,
  parseMemoryExtractionJson,
  type MemoryConversationTurn,
  type MemoryExtractionTarget,
} from './schemas.js';
import { throwMemoryProviderHttpError } from './http-error.js';

interface ResponsesApiResponse {
  output_text?: unknown;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: unknown;
    }>;
  }>;
}

function extractResponsesText(payload: ResponsesApiResponse): string {
  if (typeof payload.output_text === 'string') return payload.output_text.trim();
  const chunks: string[] = [];
  for (const output of payload.output ?? []) {
    for (const content of output.content ?? []) {
      if (typeof content.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('').trim();
}

export async function requestResponsesMemoryJson(
  profile: MemoryProviderProfile,
  turns: MemoryConversationTurn[],
  target: MemoryExtractionTarget,
): Promise<{ candidates: ExtractedMemoryCandidate[]; rawText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
  try {
    const response = await fetch(`${profile.baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: profile.model,
        temperature: 0.1,
        input: [
          {
            role: 'system',
            content: [{ type: 'input_text', text: '按 memory_extraction schema 提取长期记忆候选。' }],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: buildMemoryExtractionPrompt(turns, 'native_responses_json_schema', target) }],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            ...MEMORY_CANDIDATE_JSON_SCHEMA,
          },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) await throwMemoryProviderHttpError(response, 'extract');
    const payload = await response.json() as ResponsesApiResponse;
    const rawText = extractResponsesText(payload);
    return { candidates: parseMemoryExtractionJson(rawText), rawText };
  } finally {
    clearTimeout(timer);
  }
}
