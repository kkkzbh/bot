import type { SearchLLMConfig } from './types.js';
import { normalizeText } from './utils.js';

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

function normalizeBaseURL(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function isDeepSeekCompatibleBaseURL(baseURL: string): boolean {
  return /(^https?:\/\/)?api\.deepseek\.com(?:\/|$)/i.test(baseURL);
}

function extractMessageText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n');
}

function buildModelCandidates(model: string, baseURL: string): string[] {
  const normalized = normalizeText(model);
  if (!normalized) return [];

  const shortName = normalized.includes('/') ? normalizeText(normalized.split('/').pop() ?? '') : '';
  if (isDeepSeekCompatibleBaseURL(baseURL) && shortName) {
    return [shortName, normalized];
  }
  return shortName ? [normalized, shortName] : [normalized];
}

export function hasLLM(config: SearchLLMConfig): boolean {
  return !!normalizeText(config.baseURL) && !!normalizeText(config.apiKey) && !!normalizeText(config.model);
}

export async function invokeOpenAICompatible(
  config: SearchLLMConfig,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const baseURL = normalizeBaseURL(config.baseURL);
  const modelCandidates = buildModelCandidates(config.model, baseURL);
  if (!baseURL || !config.apiKey || !modelCandidates.length) {
    throw new Error('llm config unavailable');
  }

  let lastError: Error | null = null;
  for (const model of modelCandidates) {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (response.ok) {
      const payload = (await response.json()) as ChatCompletionResponse;
      return extractMessageText(payload.choices?.[0]?.message?.content);
    }

    const error = new Error(`openai-compatible status=${response.status} model=${model}`);
    lastError = error;
    if (response.status < 500) continue;
    throw error;
  }

  throw lastError ?? new Error('openai-compatible request failed');
}
