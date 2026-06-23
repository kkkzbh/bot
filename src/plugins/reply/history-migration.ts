import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { ChatReplyV1Parser, encodeChatReplyV1 } from './pipeline/chat-reply-v1.js';
import type { StructuredReply, StructuredReplyMessage } from './pipeline/types.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const CHAT_REPLY_V1_HISTORY_NONCE = 'history';

type DatabaseLike = {
  get: (table: string, query: Record<string, unknown>, fields?: string[]) => Promise<Array<Record<string, unknown>>>;
  set: (table: string, query: Record<string, unknown>, update: Record<string, unknown>) => Promise<unknown>;
  remove: (table: string, query: Record<string, unknown>) => Promise<unknown>;
};

export interface StructuredReplyHistoryMigrationResult {
  scanned: number;
  migrated: number;
  structuredRowsMigrated: number;
  submitReplyPlansMigrated: number;
  emptySubmitReplyPlanToolsRemoved: number;
  protocolViolationPromptsRemoved: number;
}

function normalizeLegacyStructuredReply(raw: unknown): StructuredReply | null {
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  if (record.decision === 'no_reply') {
    return { decision: 'no_reply', outbound_messages: null };
  }
  if (record.decision !== 'reply') return null;

  const outbound = record.outbound_messages ?? record.messages;
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
    if (typeof message.modality === 'string') {
      const migrated = normalizeLegacyMessageItem(message);
      if (!migrated) return null;
      messages.push(migrated);
      continue;
    }
    return null;
  }

  return {
    decision: 'reply',
    outbound_messages: messages,
  };
}

function normalizeLegacyMessageItem(message: Record<string, unknown>): StructuredReplyMessage | null {
  const modality = message.modality;
  if (modality === 'text' || modality === 'message') {
    if (typeof message.content !== 'string') return null;
    return {
      type: 'message',
      content: message.content.trim(),
    };
  }

  if (modality === 'rich_text') {
    const segments = message.segments;
    if (!Array.isArray(segments)) return null;
    return {
      type: 'message',
      content: segments.map((segment) => renderLegacyRichTextSegment(segment)).join('').trim(),
    };
  }

  if (modality === 'voice') {
    if (typeof message.content !== 'string') return null;
    return {
      type: 'voice',
      content: message.content.trim(),
    };
  }

  if (modality === 'meme' || modality === 'sticker') {
    if (typeof message.content !== 'string') return null;
    return {
      type: 'meme',
      content: message.content.trim(),
    };
  }

  if (modality === 'image') {
    const assetRef = typeof message.assetRef === 'string' ? message.assetRef.trim() : '';
    const alt = typeof message.alt === 'string'
      ? message.alt.trim()
      : typeof message.content === 'string'
        ? message.content.trim()
        : '';
    return {
      type: 'image',
      assetRef,
      alt,
    };
  }

  return null;
}

function renderLegacyRichTextSegment(segment: unknown): string {
  if (!segment || typeof segment !== 'object') return '';
  const record = segment as Record<string, unknown>;
  if (record.kind === 'text') {
    return typeof record.text === 'string'
      ? record.text
      : typeof record.content === 'string'
        ? record.content
        : '';
  }
  if (record.kind === 'mention') {
    const userId = typeof record.userId === 'string' ? record.userId.trim() : '';
    return userId ? `@${userId}` : '';
  }
  if (record.kind === 'image') {
    const alt = typeof record.alt === 'string' ? record.alt.trim() : '';
    return alt ? `（发送图片：${alt}）` : '（发送图片）';
  }
  return '';
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

function normalizeLegacyChatReplyV1History(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('CHAT_REPLY_V1 ')) return null;

  const withoutLegacyMentionHeader = trimmed
    .split(/\r\n?|\n/u)
    .filter((line) => !/^MENTIONS\s+/u.test(line.trim()))
    .join('\n');

  try {
    const parsed = new ChatReplyV1Parser().parse(withoutLegacyMentionHeader);
    const normalized = encodeChatReplyV1(parsed, CHAT_REPLY_V1_HISTORY_NONCE);
    return normalized === trimmed ? null : normalized;
  } catch {
    return null;
  }
}

async function decodeStoredStringContent(content: unknown): Promise<string | null> {
  if (!content) return null;

  let decoded: string;
  try {
    decoded = (await gunzipAsync(content as never)).toString();
  } catch {
    return null;
  }

  try {
    const storedContent = JSON.parse(decoded) as unknown;
    return typeof storedContent === 'string' ? storedContent : null;
  } catch {
    return null;
  }
}

async function decodeStructuredReplyHistoryContent(content: unknown): Promise<string | null> {
  const storedContent = await decodeStoredStringContent(content);
  if (storedContent == null) return null;

  const normalizedChatReplyV1 = normalizeLegacyChatReplyV1History(storedContent);
  if (normalizedChatReplyV1) return normalizedChatReplyV1;

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

type LegacySubmitReplyPlanCall = {
  id?: unknown;
  name?: unknown;
  function?: {
    name?: unknown;
  };
  args?: {
    segments?: unknown;
  };
};

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseToolCalls(value: unknown): LegacySubmitReplyPlanCall[] {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value as LegacySubmitReplyPlanCall[];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as LegacySubmitReplyPlanCall[] : [];
  } catch {
    return [];
  }
}

function getToolCallName(call: LegacySubmitReplyPlanCall): string {
  return normalizeText(call.name ?? call.function?.name);
}

function renderSubmitReplyPlanSegments(rawSegments: unknown): string {
  if (!Array.isArray(rawSegments)) return '';

  return rawSegments
    .map((segment) => {
      if (!segment || typeof segment !== 'object') return '';
      const record = segment as Record<string, unknown>;
      const kind = normalizeText(record.kind ?? record.type);
      const content = normalizeText(record.content);
      if (kind === 'text' || kind === 'message' || kind === 'structured_block') return content;
      if (kind === 'voice') return content ? `（发送语音：${content}）` : '';
      if (kind === 'sticker' || kind === 'meme') return content ? `（发送表情包：${content}）` : '（发送表情包）';
      if (kind === 'image') {
        const alt = normalizeText(record.alt ?? record.content);
        return alt ? `（发送图片：${alt}）` : '（发送图片）';
      }
      return content;
    })
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

async function isStoredContentEmpty(content: unknown): Promise<boolean> {
  const decoded = await decodeStoredStringContent(content);
  return decoded == null || decoded.trim() === '';
}

const LEGACY_REPLY_PLAN_VIOLATION_PREFIX = 'Protocol violation: reply-agent must finish by calling submit_reply_plan.';

export async function migrateStructuredReplyHistoryRows(
  database: DatabaseLike,
): Promise<StructuredReplyHistoryMigrationResult> {
  const rows = await database.get('chatluna_message', { role: 'ai' }, ['id', 'role', 'content']);
  let structuredRowsMigrated = 0;

  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) continue;

    const visibleHistory = await decodeStructuredReplyHistoryContent(row.content);
    if (!visibleHistory) continue;

    await database.set('chatluna_message', { id }, {
      content: await gzipAsync(JSON.stringify(visibleHistory)),
    });
    structuredRowsMigrated += 1;
  }

  const allRows = await database.get('chatluna_message', {}, [
    'id',
    'conversationId',
    'parentId',
    'role',
    'name',
    'content',
    'tool_call_id',
    'tool_calls',
  ]);
  const rowsByParent = new Map<string, Record<string, unknown>[]>();
  for (const row of allRows) {
    const parentId = normalizeId(row.parentId);
    const bucket = rowsByParent.get(parentId) ?? [];
    bucket.push(row);
    rowsByParent.set(parentId, bucket);
  }

  let submitReplyPlansMigrated = 0;
  let emptySubmitReplyPlanToolsRemoved = 0;
  let protocolViolationPromptsRemoved = 0;

  for (const row of allRows) {
    const id = normalizeId(row.id);
    if (!id || row.role !== 'ai') continue;
    if (!(await isStoredContentEmpty(row.content))) continue;

    const toolCalls = parseToolCalls(row.tool_calls);
    if (toolCalls.length !== 1 || getToolCallName(toolCalls[0]) !== 'submit_reply_plan') continue;

    const visibleHistory = renderSubmitReplyPlanSegments(toolCalls[0].args?.segments);
    if (!visibleHistory) continue;

    const children = rowsByParent.get(id) ?? [];
    const emptyToolRows = [];
    for (const child of children) {
      if (child.role !== 'tool' || child.name !== 'submit_reply_plan') continue;
      const toolCallId = normalizeId(child.tool_call_id);
      if (toolCallId && toolCallId !== normalizeId(toolCalls[0].id)) continue;
      if (!(await isStoredContentEmpty(child.content))) continue;
      emptyToolRows.push(child);
    }
    if (!emptyToolRows.length) continue;

    await database.set('chatluna_message', { id }, {
      content: await gzipAsync(JSON.stringify(visibleHistory)),
      tool_calls: [],
    });
    submitReplyPlansMigrated += 1;

    for (const toolRow of emptyToolRows) {
      const toolId = normalizeId(toolRow.id);
      if (!toolId) continue;

      for (const grandchild of rowsByParent.get(toolId) ?? []) {
        const grandchildId = normalizeId(grandchild.id);
        if (grandchildId) {
          await database.set('chatluna_message', { id: grandchildId }, { parentId: id });
        }
      }
      await database.set('chatluna_conversation', { latestMessageId: toolId }, { latestMessageId: id });
      await database.remove('chatluna_message', { id: toolId });
      emptySubmitReplyPlanToolsRemoved += 1;
    }
  }

  for (const row of allRows) {
    const id = normalizeId(row.id);
    if (!id || row.role !== 'human' || normalizeId(row.name)) continue;

    const content = await decodeStoredStringContent(row.content);
    if (!content?.startsWith(LEGACY_REPLY_PLAN_VIOLATION_PREFIX)) continue;

    const parentId = normalizeId(row.parentId) || null;
    for (const child of rowsByParent.get(id) ?? []) {
      const childId = normalizeId(child.id);
      if (childId) {
        await database.set('chatluna_message', { id: childId }, { parentId });
      }
    }
    await database.set('chatluna_conversation', { latestMessageId: id }, { latestMessageId: parentId });
    await database.remove('chatluna_message', { id });
    protocolViolationPromptsRemoved += 1;
  }

  const migrated =
    structuredRowsMigrated +
    submitReplyPlansMigrated +
    emptySubmitReplyPlanToolsRemoved +
    protocolViolationPromptsRemoved;

  return {
    scanned: rows.length,
    migrated,
    structuredRowsMigrated,
    submitReplyPlansMigrated,
    emptySubmitReplyPlanToolsRemoved,
    protocolViolationPromptsRemoved,
  };
}
