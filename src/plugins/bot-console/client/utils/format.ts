/**
 * Formats a Unix timestamp (ms) into a localized date-time string.
 * Returns '未记录' when the value is null / undefined.
 */
export function formatDateTime(value: number | null | undefined): string {
  if (value == null) return '未记录'
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(value))
  } catch {
    return '未记录'
  }
}

/**
 * Formats a latency value (ms number) as a human-readable string.
 * Returns '未记录' when the value is null / undefined / non-finite.
 */
export function formatLatency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '未记录'
  return `${Math.max(0, Math.round(Number(value)))} ms`
}
