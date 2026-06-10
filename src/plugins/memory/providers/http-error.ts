export class MemoryProviderHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly retryable: boolean;
  readonly providerCode: string | number | null;

  constructor(input: {
    operation: 'extract' | 'embed';
    status: number;
    statusText: string;
    bodyText: string;
  }) {
    const detail = parseProviderErrorDetail(input.bodyText);
    const base = `${input.operation}_http_${input.status}`;
    const message = detail?.message
      ? `${base}: ${detail.message}${detail.code == null ? '' : ` (code ${detail.code})`}`
      : base;
    super(message);
    this.name = 'MemoryProviderHttpError';
    this.status = input.status;
    this.statusText = input.statusText;
    this.retryable = isRetryableHttpStatus(input.status);
    this.providerCode = detail?.code ?? null;
  }
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function parseProviderErrorDetail(bodyText: string): { message: string; code: string | number | null } | null {
  const trimmed = bodyText.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : null;
    const message = stringField(nested, 'message') ?? stringField(record, 'message') ?? stringField(record, 'error');
    if (!message) return null;
    return {
      message,
      code: nested ? scalarField(nested, 'code') ?? scalarField(record, 'code') : scalarField(record, 'code'),
    };
  } catch {
    return { message: trimmed.slice(0, 240), code: null };
  }
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function scalarField(record: Record<string, unknown> | null, key: string): string | number | null {
  const value = record?.[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

export async function throwMemoryProviderHttpError(
  response: Response,
  operation: 'extract' | 'embed',
): Promise<never> {
  const bodyText = await response.text();
  throw new MemoryProviderHttpError({
    operation,
    status: response.status,
    statusText: response.statusText,
    bodyText,
  });
}

export function isNonRetryableMemoryProviderError(error: unknown): boolean {
  return error instanceof MemoryProviderHttpError && !error.retryable;
}
