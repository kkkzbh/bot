import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gunzipAsync = promisify(gunzip);

export function extractPlainText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && 'text' in raw) {
    const text = (raw as { text?: unknown }).text;
    return typeof text === 'string' ? text.trim() : '';
  }
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

function toStoredArrayBuffer(raw: unknown): ArrayBuffer | null {
  if (raw instanceof ArrayBuffer) return raw;
  if (!ArrayBuffer.isView(raw)) return null;
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
}

export async function decodeStoredMessageJson<T = unknown>(content: unknown): Promise<T | null> {
  const buffer = toStoredArrayBuffer(content);
  if (!buffer) return null;
  const payload = (await gunzipAsync(Buffer.from(buffer))).toString('utf8');
  return JSON.parse(payload) as T;
}

export async function decodeStoredMessageText(content: unknown): Promise<string> {
  return extractPlainText(await decodeStoredMessageJson(content));
}
