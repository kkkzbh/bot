import type { Context } from 'koishi';
import { registerPromptFragment } from '../../shared/prompt-context/index.js';

export interface ToolMemoryEntry {
  turnId: string;
  createdAt: string;
  toolName: string;
  inputDigest: string;
  snippetFormat: 'text' | 'json';
  snippet: string;
}

const TOOL_MEMORY_STORAGE_KEY = '__chatluna_internal_tool_memory_v1';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readRequiredString(
  record: Record<string, unknown>,
  field: string,
  entryIndex: number,
): string {
  const value = record[field];
  if (typeof value !== 'string') {
    throw new Error(`tool memory entry ${entryIndex + 1}.${field} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`tool memory entry ${entryIndex + 1}.${field} must not be empty.`);
  }
  return normalized;
}

function readOptionalString(
  record: Record<string, unknown>,
  field: string,
  entryIndex: number,
): string {
  const value = record[field];
  if (value == null) return '';
  if (typeof value !== 'string') {
    throw new Error(`tool memory entry ${entryIndex + 1}.${field} must be a string.`);
  }
  return value.trim();
}

function parseStoredToolMemoryEntries(raw: unknown): ToolMemoryEntry[] {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('tool memory payload must be a non-empty JSON string.');
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('tool memory payload must be a JSON array.');
  }

  return parsed.map((entry, index) => {
    if (!isPlainRecord(entry)) {
      throw new Error(`tool memory entry ${index + 1} must be an object.`);
    }
    const turnId = readRequiredString(entry, 'turnId', index);
    const createdAt = readRequiredString(entry, 'createdAt', index);
    const toolName = readRequiredString(entry, 'toolName', index);
    const inputDigest = readOptionalString(entry, 'inputDigest', index);
    const snippetFormat = readRequiredString(entry, 'snippetFormat', index);
    if (snippetFormat !== 'text' && snippetFormat !== 'json') {
      throw new Error(`tool memory entry ${index + 1}.snippetFormat must be text or json.`);
    }
    const snippet = readRequiredString(entry, 'snippet', index);

    return {
      turnId,
      createdAt,
      toolName,
      inputDigest,
      snippetFormat,
      snippet,
    } satisfies ToolMemoryEntry;
  });
}

async function loadReplyToolMemoryEntries(
  ctx: Context,
  conversationId: string,
): Promise<ToolMemoryEntry[]> {
  const database = ctx.database as unknown as {
    get: (
      table: 'chatluna_conversation',
      query: { id: string },
    ) => Promise<Array<{ additional_kwargs?: string }>>;
  };
  const [conversation] = await database.get('chatluna_conversation', {
    id: conversationId,
  });
  const rawAdditionalArgs =
    typeof conversation?.additional_kwargs === 'string'
      ? conversation.additional_kwargs
      : '';
  if (!rawAdditionalArgs) return [];

  const parsed = JSON.parse(rawAdditionalArgs) as Record<string, unknown>;
  if (!isPlainRecord(parsed)) {
    throw new Error('conversation additional_kwargs must be a JSON object.');
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, TOOL_MEMORY_STORAGE_KEY)) return [];
  return parseStoredToolMemoryEntries(parsed[TOOL_MEMORY_STORAGE_KEY]);
}

function buildReplyToolMemoryStateText(entries: ToolMemoryEntry[]): string {
  const lines = [
    '这是最近几轮可复用的工具结果片段。',
    '它们是背景记忆，不是用户当前正在说的话。',
    '除非用户要求刷新、结果明显过时、或当前问题超出这些片段，否则优先复用，不要重复调用同类工具。',
  ];

  for (const [index, entry] of entries.entries()) {
    lines.push(`片段 ${index + 1}:`);
    lines.push(`- 工具: ${entry.toolName}`);
    if (entry.createdAt) {
      lines.push(`- 时间: ${entry.createdAt}`);
    }
    if (entry.inputDigest) {
      lines.push(`- 输入: ${entry.inputDigest}`);
    }
    lines.push(`- 结果(${entry.snippetFormat}):`);
    lines.push(entry.snippet);
  }

  return lines.join('\n');
}

export async function registerReplyToolMemoryFragment(
  ctx: Context,
  conversationId: string,
  logger: { warn: (message: string, ...args: unknown[]) => void },
): Promise<void> {
  let entries: ToolMemoryEntry[] = [];
  try {
    entries = await loadReplyToolMemoryEntries(ctx, conversationId);
  } catch (error) {
    logger.warn('reply tool memory parse failed: %s', (error as Error).message);
    return;
  }

  if (!entries.length) return;

  registerPromptFragment(conversationId, {
    source: 'qqbot_reply_tool_memory',
    title: 'Reply Tool Memory',
    authority: 'assistant_state',
    trust: 'trusted',
    ttl: 'turn',
    payload: {
      kind: 'text',
      value: buildReplyToolMemoryStateText(entries),
    },
  });
}
