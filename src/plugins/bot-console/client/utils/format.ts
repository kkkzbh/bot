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

export function formatErrorMessage(error: unknown, fallback = '操作失败'): string {
  if (error instanceof Error) {
    return error.message || fallback
  }

  if (typeof error === 'string') {
    return error || fallback
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    const direct = record.message
    if (typeof direct === 'string' && direct) {
      return direct
    }

    const nestedError = record.error
    if (nestedError && typeof nestedError === 'object') {
      const nestedMessage = (nestedError as Record<string, unknown>).message
      if (typeof nestedMessage === 'string' && nestedMessage) {
        return nestedMessage
      }
    }
  }

  return fallback
}
