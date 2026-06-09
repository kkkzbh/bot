import type {
  MemoryEpisodeV3Record,
  MemoryFactV3Record,
  MemoryProfileKind,
} from '../../types/memory-v3.js';

export function clampScore(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  } catch {
    return [];
  }
}

export function stringifyStringArray(values: readonly string[]): string | null {
  const unique = [...new Set(values.map((item) => item.trim()).filter(Boolean))];
  return unique.length ? JSON.stringify(unique) : null;
}

export function parseEmbedding(raw: string | null | undefined): number[] | null {
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

export function stringifyEmbedding(vector: readonly number[]): string {
  return JSON.stringify(vector);
}

export function toTimestamp(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

export function uniqueKeywords(values: readonly string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].slice(0, 12);
}

export function deriveTopicKey(input: { topicKey?: string | null; content: string; keywords?: readonly string[] }): string {
  const explicit = input.topicKey ? slugify(input.topicKey) : '';
  if (explicit) return explicit;
  const keyword = input.keywords?.find((item) => item.trim()) ?? '';
  return slugify(keyword || input.content.slice(0, 48)) || 'memory-fact';
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (!left.length || !right.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function formatProfileKind(kind: MemoryProfileKind): string {
  switch (kind) {
    case 'identity':
      return '身份';
    case 'preference':
      return '偏好';
    case 'trait':
      return '特点';
    case 'boundary':
      return '边界';
    case 'plan':
      return '计划';
    case 'relationship':
      return '关系';
    default:
      return '画像';
  }
}

export function buildRetrievalText(
  type: 'fact' | 'episode',
  record: MemoryFactV3Record | MemoryEpisodeV3Record,
): string {
  if (type === 'fact') {
    const fact = record as MemoryFactV3Record;
    return `${fact.kind}:${fact.topicKey}\n${fact.content}`.trim();
  }
  const episode = record as MemoryEpisodeV3Record;
  return `${episode.title}\n${episode.summary}`.trim();
}

export function buildMemoryContextBlock(
  facts: MemoryFactV3Record[],
  episodes: MemoryEpisodeV3Record[],
  promptBudgetTokens: number,
): string | null {
  if (!facts.length && !episodes.length) return null;
  const lines = ['Relevant Long-Term Memory'];
  const charBudget = Math.max(400, Math.floor(promptBudgetTokens * 2));
  let used = lines[0].length;

  const append = (line: string): boolean => {
    if (used + line.length + 1 > charBudget) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  const activeFacts = [...facts].sort((left, right) => {
    const importanceDelta = Number(right.importance ?? 0) - Number(left.importance ?? 0);
    if (importanceDelta !== 0) return importanceDelta;
    return Number(right.lastSeenAt ?? 0) - Number(left.lastSeenAt ?? 0);
  });

  if (activeFacts.length && append('User Profile:')) {
    for (const fact of activeFacts) {
      if (!append(`- ${formatProfileKind(fact.kind)}: ${fact.content}`)) break;
    }
  }

  if (episodes.length && append('Relevant Past Episodes:')) {
    for (const episode of episodes) {
      if (!append(`- ${episode.title}: ${episode.summary}`)) break;
    }
  }

  return lines.length > 1 ? lines.join('\n') : null;
}
