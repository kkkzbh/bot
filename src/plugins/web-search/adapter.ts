import { z } from 'zod';
import { isRecord, normalizeText } from './utils.js';

export const WEB_SEARCH_INPUT_SCHEMA = z.object({
  query: z.string().optional().describe('The natural-language search query from the user.'),
  input: z.string().optional().describe('Fallback field for the natural-language search query.'),
  text: z.string().optional(),
  keyword: z.string().optional(),
  keywords: z.union([z.string(), z.array(z.string())]).optional(),
  q: z.string().optional(),
  search: z.string().optional(),
  search_query: z.union([z.string(), z.array(z.string())]).optional(),
  args: z.unknown().optional(),
  arguments: z.unknown().optional(),
  params: z.unknown().optional(),
  payload: z.unknown().optional(),
  data: z.unknown().optional(),
}).passthrough();

export type WebSearchToolInput = z.infer<typeof WEB_SEARCH_INPUT_SCHEMA>;

function isBogusQuery(value: string): boolean {
  return /^\[object\s+object\]$/i.test(normalizeText(value));
}

export function extractSearchQueryInput(input: unknown, depth = 0): string {
  if (depth > 4 || input == null) return '';

  if (typeof input === 'string') {
    const normalized = normalizeText(input);
    if (!normalized || isBogusQuery(normalized)) return '';

    if (
      (normalized.startsWith('{') && normalized.endsWith('}')) ||
      (normalized.startsWith('[') && normalized.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(normalized) as unknown;
        const extracted = extractSearchQueryInput(parsed, depth + 1);
        if (extracted) return extracted;
      } catch {}
    }

    return normalized;
  }

  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    return String(input);
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const extracted = extractSearchQueryInput(item, depth + 1);
      if (extracted) return extracted;
    }
    return '';
  }

  if (!isRecord(input)) return '';

  for (const key of ['query', 'input', 'text', 'keyword', 'keywords', 'q', 'search', 'search_query']) {
    const extracted = extractSearchQueryInput(input[key], depth + 1);
    if (extracted) return extracted;
  }

  for (const key of ['args', 'arguments', 'params', 'payload', 'data']) {
    const extracted = extractSearchQueryInput(input[key], depth + 1);
    if (extracted) return extracted;
  }

  const entries = Object.entries(input).filter(([, value]) => value != null);
  if (entries.length === 1) {
    return extractSearchQueryInput(entries[0][1], depth + 1);
  }

  return '';
}

export function summarizeToolInput(input: unknown): string {
  if (typeof input === 'string') return normalizeText(input);
  try {
    const serialized = JSON.stringify(input);
    if (!serialized) return String(input);
    return serialized.length > 400 ? `${serialized.slice(0, 400)}...` : serialized;
  } catch {
    return String(input);
  }
}
