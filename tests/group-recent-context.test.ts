import { afterEach, describe, expect, it } from 'vitest';
import {
  capturePassiveGroupRecentContext,
  groupRecentContextCache,
  replaceRuntimeChatHistoryWithGroupRecentContext,
} from '../src/plugins/triggers/group-natural/recent-context.js';

function createHumanMessage(content: string, id?: string) {
  return {
    content,
    ...(id ? { id } : {}),
    getType: () => 'human',
  };
}

function createGroupSession(
  overrides: Record<string, unknown> = {},
): {
  platform: string;
  isDirect: boolean;
  channelId: string;
  guildId: string;
  userId: string;
  messageId: string;
  content: string;
  stripped: { content: string };
  bot: { selfId: string };
  elements: unknown[];
  username?: string;
} {
  const content = String(overrides.content ?? '');
  return {
    platform: 'onebot',
    isDirect: false,
    channelId: '100',
    guildId: '100',
    userId: 'u1',
    messageId: 'msg-1',
    content,
    stripped: { content },
    bot: { selfId: 'bot-1' },
    elements: [],
    ...overrides,
  };
}

afterEach(() => {
  groupRecentContextCache.clear();
});

describe('group recent context runtime replacement', () => {
  it('replaces persisted chat history with same-group passive cache and skips the current trigger message', () => {
    capturePassiveGroupRecentContext(
      createGroupSession({
        userId: 'u1',
        messageId: 'msg-1',
        username: '甲',
        content: '先前普通消息一',
      }),
    );
    capturePassiveGroupRecentContext(
      createGroupSession({
        userId: 'u2',
        messageId: 'msg-2',
        username: '乙',
        content: '先前普通消息二',
      }),
    );

    const triggerSession = createGroupSession({
      userId: 'u3',
      messageId: 'msg-3',
      username: '丙',
      content: '祥子 帮我看看',
    });
    capturePassiveGroupRecentContext(triggerSession);

    const runtime = {
      configurable: { session: triggerSession },
      input: createHumanMessage('[speaker_id=u3 speaker_name="丙"] 祥子 帮我看看', 'u3'),
      chatHistory: [createHumanMessage('persisted chat history should be replaced')],
    };

    replaceRuntimeChatHistoryWithGroupRecentContext(runtime);

    expect(runtime.chatHistory.map((message) => message.content)).toEqual([
      '[speaker_id=u1 speaker_name="甲"] 先前普通消息一',
      '[speaker_id=u2 speaker_name="乙"] 先前普通消息二',
    ]);
  });

  it('keeps groups isolated when replacing runtime chat history', () => {
    capturePassiveGroupRecentContext(
      createGroupSession({
        guildId: '100',
        channelId: '100',
        userId: 'u1',
        messageId: 'msg-a1',
        username: '甲',
        content: 'A 群消息',
      }),
    );
    capturePassiveGroupRecentContext(
      createGroupSession({
        guildId: '200',
        channelId: '200',
        userId: 'u2',
        messageId: 'msg-b1',
        username: '乙',
        content: 'B 群消息',
      }),
    );

    const runtime = {
      configurable: {
        session: createGroupSession({
          guildId: '200',
          channelId: '200',
          userId: 'u3',
          messageId: 'msg-b2',
          username: '丙',
          content: 'B 群触发',
        }),
      },
      input: createHumanMessage('[speaker_id=u3 speaker_name="丙"] B 群触发', 'u3'),
      chatHistory: [createHumanMessage('persisted chat history should be replaced')],
    };

    replaceRuntimeChatHistoryWithGroupRecentContext(runtime);

    expect(runtime.chatHistory.map((message) => message.content)).toEqual([
      '[speaker_id=u2 speaker_name="乙"] B 群消息',
    ]);
  });

  it('does not replace private chat history', () => {
    const runtime = {
      configurable: {
        session: {
          ...createGroupSession({
            isDirect: true,
            guildId: '',
            channelId: 'private-u1',
          }),
        },
      },
      input: createHumanMessage('你好'),
      chatHistory: [createHumanMessage('persisted private history')],
    };

    replaceRuntimeChatHistoryWithGroupRecentContext(runtime);

    expect(runtime.chatHistory.map((message) => message.content)).toEqual(['persisted private history']);
  });

  it('captures image-only passive messages as speaker-tagged placeholders', () => {
    const captured = capturePassiveGroupRecentContext(
      createGroupSession({
        userId: 'u8',
        messageId: 'msg-image-1',
        username: '图图',
        content: '',
        stripped: { content: '' },
        elements: [{ type: 'img', attrs: { src: 'https://example.com/1.png' }, children: [] }],
      }),
    );

    expect(captured).toEqual(
      expect.objectContaining({
        renderedText: '[speaker_id=u8 speaker_name="图图"] [图片]',
      }),
    );
  });
});
