import type { Session } from 'koishi';

function normalizeCommandText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isAffinityPanelCommandText(value: unknown): boolean {
  return normalizeCommandText(value) === '好感';
}

export function isAffinityPanelCommandSession(session: Session): boolean {
  const carrier = session as unknown as { stripped?: { content?: unknown }; content?: unknown };
  return isAffinityPanelCommandText(carrier.stripped?.content ?? carrier.content);
}
