import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => ({
  Context: class {},
  h: {},
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
  // @ts-expect-error local built chatluna bundle does not ship a resolvable .mjs declaration path here
  const { KoishiChatMessageHistory } = await import('../../chatluna/packages/core/lib/llm-core/memory/message/index.mjs');
  const history = new KoishiChatMessageHistory(ctx as never, args.conversationId, 10_000);
  return { history, database };
}

describe('reply-agent history normalization', () => {
  it('collapses an ai tool-call tail into one normalized ai message', async () => {
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
    const result = await history.normalizeReplyAgentHistory('收到', updatedAt);

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

    const result = await history.normalizeReplyAgentHistory('最终回复');
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

  it('deletes the current reply-agent tail when there is no final visible text', async () => {
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

    const result = await history.normalizeReplyAgentHistory('');

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
});
