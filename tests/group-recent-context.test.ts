import { afterEach, describe, expect, it } from 'vitest';
import {
  capturePassiveGroupRecentContext,
  groupRecentContextCache,
  mergeRuntimeChatHistoryWithGroupRecentContext,
} from '../src/plugins/triggers/group-natural/recent-context.js';

function createHumanMessage(content: string, id?: string) {
  return {
    content,
    ...(id ? { id } : {}),
    additional_kwargs: {},
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

describe('group recent context runtime merge', () => {
  it('keeps original chat history and appends same-group passive cache tail without the current trigger message', () => {
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
        userId: 'u0',
        messageId: 'msg-0',
        username: '零',
        content: '更早的一条普通消息',
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
    capturePassiveGroupRecentContext(
      createGroupSession({
        userId: 'u4',
        messageId: 'msg-4',
        username: '丁',
        content: '先前普通消息三',
      }),
    );
    capturePassiveGroupRecentContext(
      createGroupSession({
        userId: 'u5',
        messageId: 'msg-5',
        username: '戊',
        content: '先前普通消息四',
      }),
    );
    capturePassiveGroupRecentContext(
      createGroupSession({
        userId: 'u6',
        messageId: 'msg-6',
        username: '己',
        content: '先前普通消息五',
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
      chatHistory: [
        createHumanMessage('persisted human history should stay'),
        {
          content: 'persisted ai reply should stay',
          additional_kwargs: {},
          getType: () => 'ai',
        },
      ],
    };

    mergeRuntimeChatHistoryWithGroupRecentContext(runtime);

    expect(runtime.chatHistory.map((message) => message.content)).toEqual([
      'persisted human history should stay',
      'persisted ai reply should stay',
      '[speaker_id=u2 speaker_name="乙"] 先前普通消息二',
      '[speaker_id=u4 speaker_name="丁"] 先前普通消息三',
      '[speaker_id=u5 speaker_name="戊"] 先前普通消息四',
      '[speaker_id=u6 speaker_name="己"] 先前普通消息五',
    ]);
    expect(runtime.chatHistory.at(-4)?.content).toBe(
      '[speaker_id=u2 speaker_name="乙"] 先前普通消息二',
    );
    expect(
      runtime.chatHistory.every(
        (message) => message.additional_kwargs && typeof message.additional_kwargs === 'object',
      ),
    ).toBe(true);
  });

  it('keeps groups isolated when merging runtime chat history', () => {
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
      chatHistory: [createHumanMessage('persisted chat history should stay')],
    };

    mergeRuntimeChatHistoryWithGroupRecentContext(runtime);

    expect(runtime.chatHistory.map((message) => message.content)).toEqual([
      'persisted chat history should stay',
      '[speaker_id=u2 speaker_name="乙"] B 群消息',
    ]);
  });

  it('does not merge into private chat history', () => {
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

    mergeRuntimeChatHistoryWithGroupRecentContext(runtime);

    expect(runtime.chatHistory.map((message) => message.content)).toEqual(['persisted private history']);
  });

  it('appends fewer than four cached messages when the passive cache is short', () => {
    capturePassiveGroupRecentContext(
      createGroupSession({
        userId: 'u1',
        messageId: 'msg-1',
        username: '甲',
        content: '只有一条',
      }),
    );
    capturePassiveGroupRecentContext(
      createGroupSession({
        userId: 'u2',
        messageId: 'msg-2',
        username: '乙',
        content: '只有两条',
      }),
    );

    const runtime = {
      configurable: {
        session: createGroupSession({
          userId: 'u3',
          messageId: 'msg-3',
          username: '丙',
          content: '触发一下',
        }),
      },
      input: createHumanMessage('[speaker_id=u3 speaker_name="丙"] 触发一下', 'u3'),
      chatHistory: [createHumanMessage('persisted history')],
    };

    mergeRuntimeChatHistoryWithGroupRecentContext(runtime);

    expect(runtime.chatHistory.map((message) => message.content)).toEqual([
      'persisted history',
      '[speaker_id=u1 speaker_name="甲"] 只有一条',
      '[speaker_id=u2 speaker_name="乙"] 只有两条',
    ]);
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
