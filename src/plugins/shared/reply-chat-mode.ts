export type CanonicalReplyChatMode = 'agent' | 'automation';

export function normalizeReplyChatMode(chatMode: unknown): CanonicalReplyChatMode | null {
  const value = String(chatMode ?? '').trim();
  if (!value) return null;
  if (value === 'plugin' || value === 'agent') {
    return 'agent';
  }
  if (value === 'automation') {
    return 'automation';
  }
  return null;
}
