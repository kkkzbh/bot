import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

type DatabaseLike = {
  get: (table: string, query: Record<string, unknown>, fields?: string[]) => Promise<Array<Record<string, unknown>>>;
  set: (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => Promise<unknown>;
};

export interface StructuredReplyHistoryMigrationResult {
  scanned: number;
  migrated: number;
}

type StructuredReplyMessage =
  | { type: 'message'; content: string }
  | { type: 'structured_block'; content: string }
  | { type: 'voice'; content: string }
  | { type: 'image'; assetRef: string; alt: string }
  | { type: 'meme'; content: string };

type StructuredReply = {
  decision: 'reply' | 'no_reply';
  outbound_messages: StructuredReplyMessage[] | null;
};

function normalizeLegacyStructuredReply(raw: unknown): StructuredReply | null {
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  if (record.decision === 'no_reply') {
    return { decision: 'no_reply', outbound_messages: null };
  }
  if (record.decision !== 'reply') return null;

  const outbound = record.outbound_messages;
  if (!Array.isArray(outbound)) return null;

  const messages: StructuredReplyMessage[] = [];
  for (const item of outbound) {
    if (!item || typeof item !== 'object') return null;
    const message = item as Record<string, unknown>;
    if (message.type === 'message' || message.type === 'structured_block' || message.type === 'voice' || message.type === 'meme') {
      if (typeof message.content !== 'string') return null;
      messages.push({
        type: message.type,
        content: message.content.trim(),
      } as StructuredReplyMessage);
      continue;
    }
    if (message.type === 'image') {
      if (typeof message.assetRef !== 'string' || typeof message.alt !== 'string') return null;
      messages.push({
        type: 'image',
        assetRef: message.assetRef.trim(),
        alt: message.alt.trim(),
      });
      continue;
    }
    return null;
  }

  return {
    decision: 'reply',
    outbound_messages: messages,
  };
}

function renderMigratedStructuredReplyHistory(reply: StructuredReply): string {
  if (reply.decision !== 'reply') return '';

  return (reply.outbound_messages ?? [])
    .map((message) => {
      if (message.type === 'message' || message.type === 'structured_block') {
        return message.content.trim();
      }
      if (message.type === 'voice') {
        const content = message.content.trim();
        return content ? `（发送语音：${content}）` : '';
      }
      if (message.type === 'image') {
        const alt = message.alt.trim();
        return alt ? `（发送图片：${alt}）` : '（发送图片）';
      }

      const content = message.content.trim();
      return content ? `（发送表情包：${content}）` : '（发送表情包）';
    })
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

async function decodeStructuredReplyHistoryContent(content: unknown): Promise<string | null> {
  if (!content) return null;

  let decoded: string;
  try {
    decoded = (await gunzipAsync(content as never)).toString();
  } catch {
    return null;
  }

  let storedContent: unknown;
  try {
    storedContent = JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }

  if (typeof storedContent !== 'string') return null;

  let structured: unknown;
  try {
    structured = JSON.parse(storedContent) as unknown;
  } catch {
    return null;
  }

  const reply = normalizeLegacyStructuredReply(structured);
  if (!reply) return null;

  const visibleHistory = renderMigratedStructuredReplyHistory(reply);
  return visibleHistory || null;
}

export async function migrateStructuredReplyHistoryRows(
  database: DatabaseLike,
): Promise<StructuredReplyHistoryMigrationResult> {
  const rows = await database.get('chatluna_message', { role: 'ai' }, ['id', 'role', 'content']);
  let migrated = 0;

  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) continue;

    const visibleHistory = await decodeStructuredReplyHistoryContent(row.content);
    if (!visibleHistory) continue;

    await database.set('chatluna_message', { id }, {
      content: await gzipAsync(JSON.stringify(visibleHistory)),
    });
    migrated += 1;
  }

  return {
    scanned: rows.length,
    migrated,
  };
}
