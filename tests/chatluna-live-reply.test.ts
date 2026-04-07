import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { resolveChatlunaCoreImportUrl, resolveChatlunaSourceRoot } from './helpers/chatluna-paths.js';

vi.mock('koishi-plugin-chatluna', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('koishi-plugin-chatluna/utils/string', async () => {
  const { gunzipSync, gzipSync } = await import('node:zlib');

  return {
    bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    },
    async gzipEncode(input: string): Promise<Buffer> {
      return gzipSync(Buffer.from(input, 'utf8'));
    },
    async gzipDecode(input: ArrayBuffer): Promise<string> {
      return gunzipSync(Buffer.from(input)).toString('utf8');
    },
  };
});

type TableName = 'chathub_conversation' | 'chathub_message';
type Row = Record<string, any>;

function encodeStoredContent(text: string): ArrayBuffer {
  const buffer = gzipSync(Buffer.from(JSON.stringify(text), 'utf8'));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function cloneRow<T extends Row>(row: T): T {
  return { ...row };
}

class MemoryDatabase {
  tables: Record<TableName, Row[]>;

  constructor(seed: { conversations?: Row[]; messages?: Row[] } = {}) {
    this.tables = {
      chathub_conversation: (seed.conversations ?? []).map(cloneRow),
      chathub_message: (seed.messages ?? []).map(cloneRow),
    };
  }

  async get(table: TableName, query: Record<string, unknown>): Promise<Row[]> {
    return this.tables[table]
      .filter((row) =>
        Object.entries(query).every(([key, value]) => {
          if (Array.isArray(value)) {
            return value.includes(row[key]);
          }
          return row[key] === value;
        }),
      )
      .map(cloneRow);
  }

  async upsert(table: TableName, rows: Row[]): Promise<void> {
    for (const row of rows) {
      const next = cloneRow(row);
      const index = this.tables[table].findIndex((item) => item.id === next.id);
      if (index >= 0) {
        this.tables[table][index] = { ...this.tables[table][index], ...next };
      } else {
        this.tables[table].push(next);
      }
    }
  }

  async remove(table: TableName, query: Record<string, unknown>): Promise<void> {
    this.tables[table] = this.tables[table].filter((row) =>
      !Object.entries(query).every(([key, value]) => {
        if (Array.isArray(value)) {
          return value.includes(row[key]);
        }
        return row[key] === value;
      }),
    );
  }

  async create(table: TableName, row: Row): Promise<void> {
    this.tables[table].push(cloneRow(row));
  }
}

function createHistory(args: { conversationId: string; latestId: string; messages: Row[] }) {
  const database = new MemoryDatabase({
    conversations: [{ id: args.conversationId, latestId: args.latestId, updatedAt: new Date(0) }],
    messages: args.messages,
  });
  const ctx = {
    database,
    logger: { warn: vi.fn() },
  };
  return { ctx, database };
}

async function createChatHistory(args: { conversationId: string; latestId: string; messages: Row[] }) {
  const { ctx, database } = createHistory(args);
  const historyModule = (await import(resolveChatlunaCoreImportUrl('lib/llm-core/memory/message/index.cjs'))) as {
    KoishiChatMessageHistory: new (ctx: unknown, conversationId: string, maxMessagesCount: number) => any;
  };
  const { KoishiChatMessageHistory } = historyModule;
  const history = new KoishiChatMessageHistory(ctx as never, args.conversationId, 10_000);
  return { history, database };
}

function normalizeHistory(history: {
  normalizeResearchReplyHistory?: (text: string, updatedAt?: Date) => Promise<any>;
  normalizeReplyAgentHistory?: (text: string, updatedAt?: Date) => Promise<any>;
}, finalVisibleText: string, updatedAt?: Date) {
  const normalize =
    history.normalizeResearchReplyHistory?.bind(history) ??
    history.normalizeReplyAgentHistory?.bind(history);
  if (!normalize) {
    throw new Error('missing research history normalization method');
  }
  return normalize(finalVisibleText, updatedAt);
}

describe('research reply history compatibility', () => {
  it('collapses a legacy ai tool-call tail into one normalized ai message', async () => {
    const { history, database } = await createChatHistory({
      conversationId: 'conv-1',
      latestId: 'msg-tool-1',
      messages: [
        {
          id: 'msg-human-1',
          role: 'human',
          parent: null,
          conversation: 'conv-1',
          content: encodeStoredContent('你好'),
        },
        {
          id: 'msg-ai-1',
          role: 'ai',
          parent: 'msg-human-1',
          conversation: 'conv-1',
          content: encodeStoredContent(''),
          tool_calls: [{ id: 'tool-1', name: 'submit_reply_plan' }],
        },
        {
          id: 'msg-tool-1',
          role: 'tool',
          parent: 'msg-ai-1',
          conversation: 'conv-1',
          content: encodeStoredContent('{"segments":[{"kind":"text","content":"收到"}]}'),
          tool_call_id: 'tool-1',
        },
      ],
    });

    const updatedAt = new Date('2026-03-22T11:00:00.000Z');
    const result = await normalizeHistory(history, '收到', updatedAt);

    expect(result.deletedMessageIds).toEqual(['msg-tool-1', 'msg-ai-1']);
    expect(result.latestId).toBe(result.normalizedMessageId);

    const [conversation] = await database.get('chathub_conversation', { id: 'conv-1' });
    expect(conversation.latestId).toBe(result.normalizedMessageId);
    expect(conversation.updatedAt).toEqual(updatedAt);

    const storedMessages = await database.get('chathub_message', { conversation: 'conv-1' });
    expect(storedMessages).toHaveLength(2);
    expect(storedMessages.map((message) => message.role)).toEqual(['human', 'ai']);
    expect(storedMessages[1]).toEqual(
      expect.objectContaining({
        id: result.normalizedMessageId,
        parent: 'msg-human-1',
        role: 'ai',
      }),
    );

    const visibleMessages = await history.getMessages();
    expect(
      visibleMessages.map((message: { getType: () => string; content: unknown }) => ({
        role: message.getType(),
        content: message.content,
      })),
    ).toEqual([
      { role: 'human', content: '你好' },
      { role: 'ai', content: '收到' },
    ]);
  });

  it('appends the next human message to the normalized ai tail instead of the deleted tool chain', async () => {
    const { history, database } = await createChatHistory({
      conversationId: 'conv-2',
      latestId: 'msg-tool-2',
      messages: [
        {
          id: 'msg-human-1',
          role: 'human',
          parent: null,
          conversation: 'conv-2',
          content: encodeStoredContent('查一下然后回我一句'),
        },
        {
          id: 'msg-ai-1',
          role: 'ai',
          parent: 'msg-human-1',
          conversation: 'conv-2',
          content: encodeStoredContent(''),
          tool_calls: [{ id: 'tool-search', name: 'web_search' }],
        },
        {
          id: 'msg-tool-1',
          role: 'tool',
          parent: 'msg-ai-1',
          conversation: 'conv-2',
          content: encodeStoredContent('搜索结果'),
          tool_call_id: 'tool-search',
        },
        {
          id: 'msg-ai-2',
          role: 'ai',
          parent: 'msg-tool-1',
          conversation: 'conv-2',
          content: encodeStoredContent(''),
          tool_calls: [{ id: 'tool-submit', name: 'submit_reply_plan' }],
        },
        {
          id: 'msg-tool-2',
          role: 'tool',
          parent: 'msg-ai-2',
          conversation: 'conv-2',
          content: encodeStoredContent('{"segments":[{"kind":"text","content":"最终回复"}]}'),
          tool_call_id: 'tool-submit',
        },
      ],
    });

    const result = await normalizeHistory(history, '最终回复');
    await history.addUserMessage('下一句');

    const [conversation] = await database.get('chathub_conversation', { id: 'conv-2' });
    const storedMessages = await database.get('chathub_message', { conversation: 'conv-2' });
    const latestMessage = storedMessages.find((message) => message.id === conversation.latestId);

    expect(result.deletedMessageIds).toEqual(['msg-tool-2', 'msg-ai-2', 'msg-tool-1', 'msg-ai-1']);
    expect(latestMessage).toEqual(
      expect.objectContaining({
        role: 'human',
        parent: result.normalizedMessageId,
      }),
    );
  });

  it('deletes the current research tail when there is no final visible text', async () => {
    const { history, database } = await createChatHistory({
      conversationId: 'conv-3',
      latestId: 'msg-tool-1',
      messages: [
        {
          id: 'msg-human-1',
          role: 'human',
          parent: null,
          conversation: 'conv-3',
          content: encodeStoredContent('查一下液态玻璃'),
        },
        {
          id: 'msg-ai-1',
          role: 'ai',
          parent: 'msg-human-1',
          conversation: 'conv-3',
          content: encodeStoredContent(''),
          tool_calls: [{ id: 'tool-1' }],
        },
        {
          id: 'msg-tool-1',
          role: 'tool',
          parent: 'msg-ai-1',
          conversation: 'conv-3',
          content: encodeStoredContent('{"segments":[]}'),
          tool_call_id: 'tool-1',
        },
      ],
    });

    const result = await normalizeHistory(history, '');

    expect(result).toEqual({
      deletedMessageIds: ['msg-tool-1', 'msg-ai-1'],
      latestId: 'msg-human-1',
      normalizedMessageId: null,
      normalizedText: '',
    });

    const [conversation] = await database.get('chathub_conversation', { id: 'conv-3' });
    expect(conversation.latestId).toBe('msg-human-1');

    const visibleMessages = await history.getMessages();
    expect(
      visibleMessages.map((message: { getType: () => string; content: unknown }) => ({
        role: message.getType(),
        content: message.content,
      })),
    ).toEqual([
      { role: 'human', content: '查一下液态玻璃' },
    ]);
  });

  it('appends the visible ai reply when no research tail was persisted', async () => {
    const { history, database } = await createChatHistory({
      conversationId: 'conv-4',
      latestId: 'msg-human-1',
      messages: [
        {
          id: 'msg-human-1',
          role: 'human',
          parent: null,
          conversation: 'conv-4',
          content: encodeStoredContent('你知道液态玻璃吗'),
        },
      ],
    });

    const result = await normalizeHistory(history, '知道，是一种界面风格说法');

    expect(result.deletedMessageIds).toEqual([]);
    expect(result.normalizedText).toBe('知道，是一种界面风格说法');

    const visibleMessages = await history.getMessages();
    expect(
      visibleMessages.map((message: { getType: () => string; content: unknown }) => ({
        role: message.getType(),
        content: message.content,
      })),
    ).toEqual([
      { role: 'human', content: '你知道液态玻璃吗' },
      { role: 'ai', content: '知道，是一种界面风格说法' },
    ]);

    const [conversation] = await database.get('chathub_conversation', { id: 'conv-4' });
    expect(conversation.latestId).toBe(result.normalizedMessageId);
  });

  it('stores only successful reusable tool results in bounded hidden tool memory', async () => {
    const { history, database } = await createChatHistory({
      conversationId: 'conv-5',
      latestId: 'msg-human-1',
      messages: [
        {
          id: 'msg-human-1',
          role: 'human',
          parent: null,
          conversation: 'conv-5',
          content: encodeStoredContent('查一下液态玻璃'),
        },
      ],
    });

    const TOOL_MEMORY_STORAGE_KEY = '__chatluna_internal_tool_memory_v1';
    const firstEntries = [
      {
        turnId: 'turn-1',
        createdAt: '2026-03-23T06:00:00.000Z',
        toolName: 'web_search',
        inputDigest: '{"query":"液态玻璃"}',
        snippetFormat: 'text' as const,
        snippet: '搜索结果 A',
        freshnessHint: '2026-03-23T06:00:00.000Z',
      },
    ];

    await history.storeToolMemoryEntries(firstEntries, {
      storageKey: TOOL_MEMORY_STORAGE_KEY,
      maxEntries: 3,
    });

    await history.storeToolMemoryEntries(
      [
        {
          ...firstEntries[0],
          createdAt: '2026-03-23T06:01:00.000Z',
          snippet: '搜索结果 A（更新版）',
        },
        {
          turnId: 'turn-2',
          createdAt: '2026-03-23T06:02:00.000Z',
          toolName: 'web_search',
          inputDigest: '{"query":"另一条"}',
          snippetFormat: 'text',
          snippet: '搜索结果 B',
          freshnessHint: '2026-03-23T06:02:00.000Z',
        },
        {
          turnId: 'turn-3',
          createdAt: '2026-03-23T06:03:00.000Z',
          toolName: 'web_browser',
          inputDigest: '{"url":"https://example.com"}',
          snippetFormat: 'text',
          snippet: '页面摘要',
          freshnessHint: '2026-03-23T06:03:00.000Z',
        },
        {
          turnId: 'turn-4',
          createdAt: '2026-03-23T06:04:00.000Z',
          toolName: 'weather',
          inputDigest: '{"location":"上海"}',
          snippetFormat: 'json',
          snippet: '{"temp":23}',
          freshnessHint: '2026-03-23T06:04:00.000Z',
        },
      ],
      {
        storageKey: TOOL_MEMORY_STORAGE_KEY,
        maxEntries: 3,
      },
    );

    const [conversation] = await database.get('chathub_conversation', { id: 'conv-5' });
    const additionalArgs = JSON.parse(String(conversation.additional_kwargs ?? '{}'));
    const storedEntries = JSON.parse(String(additionalArgs[TOOL_MEMORY_STORAGE_KEY] ?? '[]'));

    expect(storedEntries).toHaveLength(3);
    expect(storedEntries.map((entry: { toolName: string; snippet: string }) => [entry.toolName, entry.snippet])).toEqual([
      ['weather', '{"temp":23}'],
      ['web_browser', '页面摘要'],
      ['web_search', '搜索结果 B'],
    ]);
  });
});

describe('chatluna room auto-update', () => {
  it('drops legacy reply-mode preservation helpers during template sync', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const resolveRoomSource = readFileSync(join(packageRoot, 'src/middlewares/room/resolve_room.ts'), 'utf8');

    expect(resolveRoomSource).not.toContain('shouldPreserveExplicitReplyChatMode');
    expect(resolveRoomSource).not.toContain('isResearchReplyChatMode');
    expect(resolveRoomSource).not.toContain('normalizeLegacyReplyChatMode');
    expect(resolveRoomSource).toContain("export type ChatMode =");
    expect(resolveRoomSource).toContain("'plugin'");
    expect(resolveRoomSource).toContain("'browsing'");
  });

  it('passes qqbot research follow-up prompts through after_user_message', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const pluginChainSource = readFileSync(join(packageRoot, 'src/llm-core/chain/plugin_chat_chain.ts'), 'utf8');

    expect(pluginChainSource).toContain('qqbot_after_user_message');
    expect(pluginChainSource).toContain("requests['after_user_message'] = afterUserMessage");
  });
});
