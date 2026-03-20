import { describe, expect, it, vi } from 'vitest';
import { rewriteConversationTailForLiveReply } from '../src/plugins/live-reply/index.js';

describe('live reply history rewrite', () => {
  it('deletes the latest ai tail when no content has been committed', async () => {
    const database = {
      get: vi.fn(async (table: string, query: Record<string, unknown>) => {
        if (table === 'chathub_conversation') {
          return [{ id: query.id, latestId: 'msg-ai-1' }];
        }
        if (table === 'chathub_message') {
          return [
            { id: 'msg-human-1', role: 'human', parent: null, conversation: query.conversation ?? 'conv-1', text: '你好' },
            { id: 'msg-ai-1', role: 'ai', parent: 'msg-human-1', conversation: query.conversation ?? 'conv-1', text: '旧回复' },
          ];
        }
        return [];
      }),
      upsert: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    const result = await rewriteConversationTailForLiveReply({
      database,
      conversationId: 'conv-1',
      committedText: '',
      logger: { warn: vi.fn() },
    });

    expect(result.kind).toBe('deleted');
    expect(database.remove).toHaveBeenCalledWith('chathub_message', { id: 'msg-ai-1' });
  });

  it('truncates the latest ai tail to committed visible text', async () => {
    const database = {
      get: vi.fn(async (table: string, query: Record<string, unknown>) => {
        if (table === 'chathub_conversation') {
          return [{ id: query.id, latestId: 'msg-ai-1' }];
        }
        if (table === 'chathub_message') {
          return [
            { id: 'msg-human-1', role: 'human', parent: null, conversation: query.conversation ?? 'conv-2', text: '介绍春夏秋冬' },
            { id: 'msg-ai-1', role: 'ai', parent: 'msg-human-1', conversation: query.conversation ?? 'conv-2', text: '春夏秋冬都在这里' },
          ];
        }
        return [];
      }),
      upsert: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    const result = await rewriteConversationTailForLiveReply({
      database,
      conversationId: 'conv-2',
      committedText: '春夏秋',
      logger: { warn: vi.fn() },
    });

    expect(result.kind).toBe('truncated');
    expect(database.upsert).toHaveBeenCalledTimes(2);
  });

  it('falls back when the latest tail contains tool metadata', async () => {
    const database = {
      get: vi.fn(async (table: string, query: Record<string, unknown>) => {
        if (table === 'chathub_conversation') {
          return [{ id: query.id, latestId: 'msg-ai-1' }];
        }
        if (table === 'chathub_message') {
          return [
            { id: 'msg-human-1', role: 'human', parent: null, conversation: query.conversation ?? 'conv-3', text: '查一下液态玻璃' },
            {
              id: 'msg-ai-1',
              role: 'ai',
              parent: 'msg-human-1',
              conversation: query.conversation ?? 'conv-3',
              text: '中间态回复',
              tool_calls: [{ id: 'tool-1' }],
            },
          ];
        }
        return [];
      }),
      upsert: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    const result = await rewriteConversationTailForLiveReply({
      database,
      conversationId: 'conv-3',
      committedText: '液态玻璃是……',
      logger: { warn: vi.fn() },
    });

    expect(result).toEqual({ kind: 'fallback', reason: 'tool-tail' });
    expect(database.upsert).not.toHaveBeenCalled();
  });

  it('treats empty tool metadata as a normal ai tail', async () => {
    const database = {
      get: vi.fn(async (table: string, query: Record<string, unknown>) => {
        if (table === 'chathub_conversation') {
          return [{ id: query.id, latestId: 'msg-ai-1' }];
        }
        if (table === 'chathub_message') {
          return [
            { id: 'msg-human-1', role: 'human', parent: null, conversation: query.conversation ?? 'conv-4', text: '晚安' },
            {
              id: 'msg-ai-1',
              role: 'ai',
              parent: 'msg-human-1',
              conversation: query.conversation ?? 'conv-4',
              text: '（发送语音：晚安）',
              tool_calls: '[]',
            },
          ];
        }
        return [];
      }),
      upsert: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    const result = await rewriteConversationTailForLiveReply({
      database,
      conversationId: 'conv-4',
      committedText: '（发送语音：晚安）',
      logger: { warn: vi.fn() },
    });

    expect(result.kind).toBe('truncated');
    expect(database.upsert).toHaveBeenCalled();
  });
});
