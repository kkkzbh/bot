import { describe, expect, it } from 'vitest';
import {
  ChatReplyV1ParseError,
  ChatReplyV1Parser,
  encodeChatReplyV1,
} from '../src/plugins/reply/pipeline/chat-reply-v1.js';

const parser = new ChatReplyV1Parser();

describe('CHAT_REPLY_V1 protocol', () => {
  it('parses no_reply', () => {
    expect(parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION no_reply',
      'DONE abc12345',
    ].join('\n'))).toEqual({
      decision: 'no_reply',
      outbound_messages: null,
    });
  });

  it('parses all supported block types', () => {
    const reply = parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'BEGIN message',
      'MENTIONS 123,456',
      'CONTENT',
      '|第一条',
      '|第二行',
      'END',
      'BEGIN structured_block',
      'CONTENT',
      '|```ts',
      '|console.log("END")',
      '|```',
      'END',
      'BEGIN image',
      'ASSET_REF asset:tool:cf-card:01ABC',
      'ALT',
      '|Codeforces 用户分数卡',
      'END',
      'BEGIN meme',
      'CONTENT',
      '|无语地看对方一眼',
      'END',
      'BEGIN voice',
      'CONTENT',
      '|太好了，我现在真的很高兴。',
      'END',
      'DONE abc12345',
    ].join('\n'));

    expect(reply).toEqual({
      decision: 'reply',
      outbound_messages: [
        { type: 'message', mentions: ['123', '456'], content: '第一条\n第二行' },
        { type: 'structured_block', content: '```ts\nconsole.log("END")\n```' },
        { type: 'image', assetRef: 'asset:tool:cf-card:01ABC', alt: 'Codeforces 用户分数卡' },
        { type: 'meme', content: '无语地看对方一眼' },
        { type: 'voice', content: '太好了，我现在真的很高兴。' },
      ],
    });
  });

  it('treats protocol-looking payload lines as content when prefixed with pipe', () => {
    expect(parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'BEGIN structured_block',
      'CONTENT',
      '|END',
      '|DONE abc12345',
      '|BEGIN image',
      'END',
      'DONE abc12345',
    ].join('\n')).outbound_messages?.[0]).toEqual({
      type: 'structured_block',
      content: 'END\nDONE abc12345\nBEGIN image',
    });
  });

  it('round-trips generated protocol text', () => {
    const original = {
      decision: 'reply' as const,
      outbound_messages: [
        { type: 'message' as const, content: '一\n二\nEND', mentions: [] },
        { type: 'meme' as const, content: '轻轻叹气' },
      ],
    };

    expect(parser.parse(encodeChatReplyV1(original, 'abc12345'))).toEqual(original);
  });

  it('treats omitted message mentions as none', () => {
    expect(parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'BEGIN message',
      'CONTENT',
      '|在我看来算是个不错的成绩筹码',
      'END',
      'DONE abc12345',
    ].join('\n'))).toEqual({
      decision: 'reply',
      outbound_messages: [
        {
          type: 'message',
          mentions: [],
          content: '在我看来算是个不错的成绩筹码',
        },
      ],
    });
  });

  it.each([
    ['MISSING_HEADER', 'hello\nCHAT_REPLY_V1 abc12345\nDECISION no_reply\nDONE abc12345'],
    ['NONCE_MISMATCH', 'CHAT_REPLY_V1 abc12345\nDECISION no_reply\nDONE zzz99999'],
    ['UNKNOWN_COMMAND', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nhello\nDONE abc12345'],
    ['UNKNOWN_BLOCK_TYPE', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN poll\nEND\nDONE abc12345'],
    ['PAYLOAD_LINE_WITHOUT_PIPE', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN message\nMENTIONS none\nCONTENT\nhello\nEND\nDONE abc12345'],
    ['DUPLICATE_FIELD', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN message\nMENTIONS none\nMENTIONS none\nCONTENT\n|hi\nEND\nDONE abc12345'],
    ['UNTERMINATED_BLOCK', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN message\nMENTIONS none\nDONE abc12345'],
    ['TRAILING_TEXT_AFTER_DONE', 'CHAT_REPLY_V1 abc12345\nDECISION no_reply\nDONE abc12345\nextra'],
    ['BAD_MENTION_LIST', 'CHAT_REPLY_V1 abc12345\nDECISION reply\nBEGIN message\nMENTIONS u1\nCONTENT\n|hi\nEND\nDONE abc12345'],
  ])('rejects invalid protocol with %s', (code, text) => {
    expect(() => parser.parse(text)).toThrow(ChatReplyV1ParseError);
    try {
      parser.parse(text);
    } catch (error) {
      expect((error as ChatReplyV1ParseError).code).toBe(code);
    }
  });

  it('rejects no_reply with blocks and reply without blocks', () => {
    expect(() => parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION no_reply',
      'BEGIN message',
      'MENTIONS none',
      'CONTENT',
      '|hi',
      'END',
      'DONE abc12345',
    ].join('\n'))).toThrow(ChatReplyV1ParseError);

    expect(() => parser.parse([
      'CHAT_REPLY_V1 abc12345',
      'DECISION reply',
      'DONE abc12345',
    ].join('\n'))).toThrow(ChatReplyV1ParseError);
  });
});
