import { gzipDecode } from 'koishi-plugin-chatluna/utils/string';

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

export async function decodeStoredMessageText(content: unknown): Promise<string> {
  const buffer = toStoredArrayBuffer(content);
  if (!buffer) return '';
  const payload = await gzipDecode(buffer);
  return extractPlainText(JSON.parse(payload));
}
