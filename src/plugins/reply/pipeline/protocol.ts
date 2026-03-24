import type { Context } from 'koishi';
import { registerPromptFragment } from '../../shared/prompt-context/index.js';

export interface ToolMemoryEntry {
  turnId: string;
  createdAt: string;
  toolName: string;
  inputDigest: string;
  snippetFormat: 'text' | 'json';
  snippet: string;
  freshnessHint: string;
}

const TOOL_MEMORY_STORAGE_KEY = '__chatluna_internal_tool_memory_v1';

function parseStoredToolMemoryEntries(raw: unknown): ToolMemoryEntry[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const candidate = entry as Record<string, unknown>;
        const turnId = String(candidate.turnId ?? '').trim();
        const createdAt = String(candidate.createdAt ?? '').trim();
        const toolName = String(candidate.toolName ?? '').trim();
        const inputDigest = String(candidate.inputDigest ?? '').trim();
        const snippet = String(candidate.snippet ?? '').trim();
        if (!turnId || !createdAt || !toolName || !snippet) return null;

        return {
          turnId,
          createdAt,
          toolName,
          inputDigest,
          snippetFormat: candidate.snippetFormat === 'json' ? 'json' : 'text',
          snippet,
          freshnessHint: String(candidate.freshnessHint ?? '').trim() || createdAt,
        } satisfies ToolMemoryEntry;
      })
      .filter((entry): entry is ToolMemoryEntry => entry != null);
  } catch {
    return [];
  }
}

async function loadReplyToolMemoryEntries(
  ctx: Context,
  conversationId: string,
): Promise<ToolMemoryEntry[]> {
  const database = ctx.database as unknown as {
    get: (
      table: 'chathub_conversation',
      query: { id: string },
    ) => Promise<Array<{ additional_kwargs?: string }>>;
  };
  const [conversation] = await database.get('chathub_conversation', {
    id: conversationId,
  });
  const rawAdditionalArgs =
    typeof conversation?.additional_kwargs === 'string'
      ? conversation.additional_kwargs
      : '';
  if (!rawAdditionalArgs) return [];

  const parsed = JSON.parse(rawAdditionalArgs) as Record<string, unknown>;
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
