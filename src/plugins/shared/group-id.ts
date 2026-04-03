export function normalizeGroupId(input?: string | null): string | null {
  if (!input) return null;
  const value = String(input).trim();
  if (!value) return null;
  if (value.startsWith('group:')) return value.slice('group:'.length);
  if (value.startsWith('guild:')) return value.slice('guild:'.length);
  return value;
}

export function parseGroupSet(value?: string[] | string): Set<string> {
  if (!value) return new Set<string>();
  if (Array.isArray(value)) {
    return new Set(value.map((item) => normalizeGroupId(item)).filter((item): item is string => Boolean(item)));
  }
  return new Set(
    value
      .split(',')
      .map((item) => normalizeGroupId(item))
      .filter((item): item is string => Boolean(item)),
  );
}
