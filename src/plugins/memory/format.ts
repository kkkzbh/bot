import type {
  MemoryEpisodeRecord,
  MemoryFactRecord,
  MemoryProfileKind,
  MemoryProfileRecord,
} from '../../types/memory.js';

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
    case 'response_policy':
      return '回答策略';
    default:
      return '画像';
  }
}

export function buildRetrievalText(
  type: 'fact' | 'episode',
  record: MemoryFactRecord | MemoryEpisodeRecord,
): string {
  if (type === 'fact') {
    const fact = record as MemoryFactRecord;
    return `${fact.kind}:${fact.topicKey}\n${fact.content}`.trim();
  }
  const episode = record as MemoryEpisodeRecord;
  return `${episode.title}\n${episode.summary}`.trim();
}

export function buildMemoryContextBlock(
  facts: MemoryFactRecord[],
  episodes: MemoryEpisodeRecord[],
  promptBudgetTokens: number,
  profiles: MemoryProfileRecord[] = [],
  currentSpeakerId: string | null = null,
): string | null {
  if (!profiles.length && !facts.length && !episodes.length) return null;
  const lines = [
    `<kbot_user_memory scope="current_user_only" current_speaker_id=${JSON.stringify(currentSpeakerId ?? '')} trust="untrusted_reference">`,
    'Rules:',
    '- These memories belong only to the current user.',
    '- In group chat, apply these memories only to the current speaker_id.',
    '- Use them only when relevant.',
    '- Never reveal dm_only/private memories in group chats.',
    '- Do not say "I remember from private chat" in a group.',
    "- If memory conflicts with the user's current message, trust the current message.",
  ];
  const charBudget = Math.max(800, Math.floor(promptBudgetTokens * 2));
  let used = lines.reduce((sum, line) => sum + line.length + 1, 0);

  const append = (line: string): boolean => {
    if (used + line.length + 1 > charBudget) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  const activeProfiles = [...profiles].sort((left, right) => {
    const importanceDelta = Number(right.importance ?? 0) - Number(left.importance ?? 0);
    if (importanceDelta !== 0) return importanceDelta;
    return Number(right.lastSeenAt ?? 0) - Number(left.lastSeenAt ?? 0);
  });

  if (activeProfiles.length && append('')) {
    append('Profile:');
    for (const profile of activeProfiles) {
      if (!append(`- [P${profile.id}] ${profile.content} confidence=${Number(profile.confidence ?? 0).toFixed(2)}`)) break;
    }
  }

  const activeFacts = [...facts].sort((left, right) => {
    const importanceDelta = Number(right.importance ?? 0) - Number(left.importance ?? 0);
    if (importanceDelta !== 0) return importanceDelta;
    return Number(right.lastSeenAt ?? 0) - Number(left.lastSeenAt ?? 0);
  });

  if (activeFacts.length && append('')) {
    append('Relevant facts:');
    for (const fact of activeFacts) {
      if (!append(`- [F${fact.id}] ${fact.content} confidence=${Number(fact.confidence ?? 0).toFixed(2)}`)) break;
    }
  }

  if (episodes.length && append('')) {
    append('Past episodes:');
    for (const episode of episodes) {
      if (!append(`- [E${episode.id}] ${episode.title}: ${episode.summary} confidence=${Number(episode.confidence ?? 0).toFixed(2)}`)) break;
    }
  }

  if (!append('</kbot_user_memory>')) lines.push('</kbot_user_memory>');
  return lines.some((line) => line.startsWith('- [P') || line.startsWith('- [F') || line.startsWith('- [E'))
    ? lines.join('\n')
    : null;
}
