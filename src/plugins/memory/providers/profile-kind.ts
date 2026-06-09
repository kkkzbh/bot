import type { MemoryProfileKind } from '../../../types/memory.js';

export const PROFILE_KINDS = new Set<MemoryProfileKind>([
  'identity',
  'preference',
  'trait',
  'boundary',
  'plan',
  'relationship',
  'response_policy',
]);

const PROFILE_KIND_ALIASES: Record<string, MemoryProfileKind> = {
  interest: 'preference',
  interests: 'preference',
  hobby: 'preference',
  hobbies: 'preference',
  like: 'preference',
  likes: 'preference',
  dislike: 'preference',
  dislikes: 'preference',
};

export function normalizeProfileKind(value: unknown): MemoryProfileKind | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  if (PROFILE_KINDS.has(normalized as MemoryProfileKind)) return normalized as MemoryProfileKind;
  return PROFILE_KIND_ALIASES[normalized] ?? null;
}
