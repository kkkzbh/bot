import { afterEach, describe, expect, it } from 'vitest';
import {
  buildGroupRecentContextFallbackContent,
  capturePassiveGroupRecentContext,
  consumePassiveGroupRecentContext,
  groupRecentContextCache,
  toGroupRecentContextHistoryMessage,
} from '../src/plugins/triggers/group-natural/recent-context.js';

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

describe('group recent context cache', () => {
  it('consumes the last twelve same-group passive messages, excludes the current trigger message, and drops older leftovers', () => {
    for (let index = 1; index <= 14; index += 1) {
      capturePassiveGroupRecentContext(
        createGroupSession({
          userId: `u${index}`,
          messageId: `msg-${index}`,
          username: `用户${index}`,
          content: `先前普通消息${index}`,
        }),
      );
    }

    const triggerSession = createGroupSession({
      userId: 'u15',
      messageId: 'msg-15',
      username: '触发者',
      content: '祥子 帮我看看',
    });
    capturePassiveGroupRecentContext(triggerSession);

    const consumed = consumePassiveGroupRecentContext(triggerSession);

    expect(consumed.map((entry) => entry.renderedText)).toEqual([
      '[speaker_id=u3 speaker_name="用户3"] 先前普通消息3',
      '[speaker_id=u4 speaker_name="用户4"] 先前普通消息4',
      '[speaker_id=u5 speaker_name="用户5"] 先前普通消息5',
      '[speaker_id=u6 speaker_name="用户6"] 先前普通消息6',
      '[speaker_id=u7 speaker_name="用户7"] 先前普通消息7',
      '[speaker_id=u8 speaker_name="用户8"] 先前普通消息8',
      '[speaker_id=u9 speaker_name="用户9"] 先前普通消息9',
      '[speaker_id=u10 speaker_name="用户10"] 先前普通消息10',
      '[speaker_id=u11 speaker_name="用户11"] 先前普通消息11',
      '[speaker_id=u12 speaker_name="用户12"] 先前普通消息12',
      '[speaker_id=u13 speaker_name="用户13"] 先前普通消息13',
      '[speaker_id=u14 speaker_name="用户14"] 先前普通消息14',
    ]);
    expect(groupRecentContextCache.get('onebot:bot-1:group:100').map((entry) => entry.messageId)).toEqual(['msg-15']);
  });

  it('keeps groups isolated when consuming passive cache entries', () => {
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

    const consumed = consumePassiveGroupRecentContext(
      createGroupSession({
        guildId: '200',
        channelId: '200',
        userId: 'u3',
        messageId: 'msg-b2',
        username: '丙',
        content: 'B 群触发',
      }),
    );

    expect(consumed.map((entry) => entry.renderedText)).toEqual([
      '[speaker_id=u2 speaker_name="乙"] B 群消息',
    ]);
  });

  it('does not consume passive cache for private chats', () => {
    const consumed = consumePassiveGroupRecentContext(
      createGroupSession({
        isDirect: true,
        guildId: '',
        channelId: 'private-u1',
      }),
    );

    expect(consumed).toEqual([]);
  });

  it('consumes fewer than twelve cached messages when the passive cache is short', () => {
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

    const consumed = consumePassiveGroupRecentContext(
      createGroupSession({
        userId: 'u3',
        messageId: 'msg-3',
        username: '丙',
        content: '触发一下',
      }),
    );

    expect(consumed.map((entry) => entry.renderedText)).toEqual([
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
        imageCount: 1,
      }),
    );
  });

  it('converts a consumed entry into a human chat history message', () => {
    const captured = capturePassiveGroupRecentContext(
      createGroupSession({
        userId: 'u9',
        messageId: 'msg-9',
        username: '阿九',
        content: '主链路历史补写',
      }),
    );

    expect(toGroupRecentContextHistoryMessage(captured!)).toMatchObject({
      content: '[speaker_id=u9 speaker_name="阿九"] 主链路历史补写',
      id: 'u9',
    });
  });

  it('builds multimodal fallback content for cached image messages', () => {
    const captured = capturePassiveGroupRecentContext(
      createGroupSession({
        userId: 'u10',
        messageId: 'msg-10',
        username: '图文',
        content: '帮我看下',
        stripped: { content: '帮我看下' },
        elements: [{ type: 'img', attrs: { src: 'https://example.com/2.png' }, children: [] }],
      }),
    );

    expect(buildGroupRecentContextFallbackContent(captured!)).toEqual([
      { type: 'text', text: '帮我看下' },
      { type: 'image_url', image_url: { url: 'https://example.com/2.png' } },
    ]);
  });

  it('formats multimodal history messages with a speaker line before images', () => {
    const captured = capturePassiveGroupRecentContext(
      createGroupSession({
        userId: 'u11',
        messageId: 'msg-11',
        username: '看图',
        content: '',
        stripped: { content: '' },
        elements: [{ type: 'img', attrs: { src: 'https://example.com/3.png' }, children: [] }],
      }),
    );

    expect(
      toGroupRecentContextHistoryMessage(captured!, {
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/3.png' } }],
      }),
    ).toMatchObject({
      id: 'u11',
      content: [
        { type: 'text', text: '[speaker_id=u11 speaker_name="看图"]' },
        { type: 'image_url', image_url: { url: 'https://example.com/3.png' } },
      ],
      additional_kwargs: {
        qqbot_speaker_format: {
          version: 'speaker_id_v1',
          speakerId: 'u11',
          speakerName: '看图',
          isDirect: false,
          preformatted: true,
        },
      },
    });
  });
});
