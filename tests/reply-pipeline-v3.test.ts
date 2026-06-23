import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => ({
  h: {
    parse: () => [],
  },
}));

import { normalizeReplyChatMode } from '../src/plugins/shared/reply-chat-mode.js';
import { buildReplyTurnContext, buildReplyTurnInput, normalizeReplyRouteHint } from '../src/plugins/reply/pipeline/context-builder.js';
import {
  StructuredReplyCompilerError,
  StructuredReplyCompilerService,
  StructuredReplyEmptyModelOutputError,
} from '../src/plugins/reply/pipeline/compiler.js';
import { ReplyOrchestratorService } from '../src/plugins/reply/pipeline/orchestrator.js';

function createStructuredResponse(content: unknown) {
  return {
    content: JSON.stringify(content),
  };
}

function createTurnInput(text: string) {
  return {
    text,
    hasImageInput: false,
    imageCount: 0,
    displayName: '小祥',
    userId: 'u1',
    isDirect: true,
    conversationId: 'conv-1',
  };
}

function createGroupTurnInput(text: string) {
  return {
    ...createTurnInput(text),
    isDirect: false,
    channelId: '1019832161',
    guildId: '1019832161',
  };
}

function createGroupSession(
  members: Array<{ user_id: string | number; card?: string; nickname?: string }> = [
    { user_id: 3623807220, card: '刘若希', nickname: '希娃儿' },
  ],
) {
  return {
    isDirect: false,
    channelId: '1019832161',
    guildId: '1019832161',
    bot: {
      selfId: 'bot-1',
      platform: 'onebot',
      internal: {
        getGroupMemberList: vi.fn(async () => members),
      },
    },
  } as never;
}

describe('reply pipeline v3', () => {
  it('maps plugin rooms to the agent route hint without keeping legacy aliases', () => {
    expect(normalizeReplyChatMode('plugin')).toBe('agent');
    expect(normalizeReplyChatMode('reply-agent')).toBeNull();
    expect(normalizeReplyRouteHint('agent')).toBe('agent');
    expect(normalizeReplyRouteHint('plugin')).toBeNull();
    expect(normalizeReplyRouteHint('')).toBeNull();
  });

  it('prefers no_reply for empty input even when an agent hint exists', () => {
    const { route } = buildReplyTurnContext(createTurnInput('   '), {
      routeHint: 'agent',
    });
    expect(route).toBe('no_reply');
  });

  it('keeps image metadata in turn input and routes image-only turns to agent', () => {
    const turnInput = buildReplyTurnInput(
      {
        content: '',
        stripped: { content: '' },
        userId: 'u1',
        isDirect: true,
        messageId: 'msg-1',
      } as never,
      { conversationId: 'conv-1' },
      {
        content: [
          { type: 'text', text: '' },
          { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
        ],
      },
    );

    expect(turnInput).toMatchObject({
      text: '',
      hasImageInput: true,
      imageCount: 1,
    });

    const { route } = buildReplyTurnContext(turnInput, {
      routeHint: 'agent',
    });
    expect(route).toBe('agent');
  });

  it('strips raw image tags from turn input text while preserving image metadata', () => {
    const turnInput = buildReplyTurnInput(
      {
        content: '<img src="https://example.com/1.png"/> 这是什么',
        stripped: { content: '<img src="https://example.com/1.png"/> 这是什么' },
        userId: 'u1',
        isDirect: true,
      } as never,
      { conversationId: 'conv-1' },
      {
        content: [
          { type: 'text', text: '<img src="https://example.com/1.png"/> 这是什么' },
          { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
        ],
      },
    );

    expect(turnInput).toMatchObject({
      text: '这是什么',
      hasImageInput: true,
      imageCount: 1,
    });
  });

  it('normalizes incoming mention tags into readable text on the text route', () => {
    const turnInput = buildReplyTurnInput(
      {
        content: '<at id="3889019833" name="揽探长"/>弟弟回来的时候已经死了吗？',
        stripped: { content: '' },
        userId: 'u1',
        isDirect: true,
      } as never,
      { conversationId: 'conv-1' },
      {
        content: '<at id="3889019833" name="揽探长"/>弟弟回来的时候已经死了吗？',
      },
    );

    expect(turnInput).toMatchObject({
      text: '@揽探长 弟弟回来的时候已经死了吗？',
      hasImageInput: false,
      imageCount: 0,
    });
  });

  it('returns await_model before the structured reply is available', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const result = await orchestrator.handle(createTurnInput('查一下液态玻璃'), {} as never, {
      routeHint: 'agent',
    });

    expect(result.status).toBe('await_model');
    if (result.status !== 'await_model') {
      throw new Error('expected await_model');
    }
    expect(result.route).toBe('agent');
  });

  it('resolves structured reply voice and meme actions against capability snapshot', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const turnInput = createTurnInput('用语音说收到，再配个无语表情包');

    const ready = await orchestrator.handle(turnInput, {} as never, {
      routeHint: 'agent',
      capabilitySnapshot: {
        canMultiline: true,
        canVoice: true,
        canSticker: true,
        stickerAvailableCount: 2,
        source: 'test',
      },
      responseMessage: createStructuredResponse({
        decision: 'reply',
        outbound_messages: [
          { type: 'voice', content: '收到。' },
          { type: 'meme', content: '无语地看对方一眼' },
        ],
      }),
    });

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') {
      throw new Error('expected ready');
    }
    expect(ready.reply).toEqual({
      decision: 'reply',
      outbound_messages: [
        { type: 'voice', content: '收到。' },
        { type: 'meme', content: '无语地看对方一眼' },
      ],
    });
    expect(ready.actions).toEqual([
      { kind: 'voice', content: '收到。' },
      { kind: 'sticker', intent: '无语地看对方一眼' },
    ]);
  });

  it('resolves inline group member mentions by card, nickname, and user id', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const ready = await orchestrator.handle(createGroupTurnInput('提醒一下对方'), createGroupSession(), {
      routeHint: 'agent',
      capabilitySnapshot: {
        canMultiline: true,
        canMention: true,
        canVoice: false,
        canSticker: false,
        stickerAvailableCount: 0,
        source: 'test',
      },
      responseMessage: createStructuredResponse({
        decision: 'reply',
        outbound_messages: [
          {
            type: 'message',
            content: '@刘若希 22:00了。麻烦 @希娃儿 看一下；@3623807220 也同步。',
          },
        ],
      }),
    });

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') {
      throw new Error('expected ready');
    }
    expect(ready.reply).toEqual({
      decision: 'reply',
      outbound_messages: [
        {
          type: 'message',
          content: '@刘若希 22:00了。麻烦 @希娃儿 看一下；@3623807220 也同步。',
        },
      ],
    });
    expect(ready.actions).toEqual([
      {
        kind: 'message',
        parts: [
          { kind: 'at', userId: '3623807220', label: '刘若希' },
          { kind: 'text', content: ' 22:00了。麻烦 ' },
          { kind: 'at', userId: '3623807220', label: '希娃儿' },
          { kind: 'text', content: ' 看一下；' },
          { kind: 'at', userId: '3623807220', label: '3623807220' },
          { kind: 'text', content: ' 也同步。' },
        ],
      },
    ]);
  });

  it('preserves inline mention position in the middle of text', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const ready = await orchestrator.handle(createGroupTurnInput('提醒一下对方'), createGroupSession([
      { user_id: 123456, card: '小祥', nickname: '小祥' },
    ]), {
      routeHint: 'agent',
      capabilitySnapshot: {
        canMultiline: true,
        canMention: true,
        canVoice: false,
        canSticker: false,
        stickerAvailableCount: 0,
        source: 'test',
      },
      responseMessage: createStructuredResponse({
        decision: 'reply',
        outbound_messages: [
          {
            type: 'message',
            content: '麻烦 @小祥 看一下',
          },
        ],
      }),
    });

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') {
      throw new Error('expected ready');
    }
    expect(ready.reply).toEqual({
      decision: 'reply',
      outbound_messages: [
        {
          type: 'message',
          content: '麻烦 @小祥 看一下',
        },
      ],
    });
    expect(ready.actions).toEqual([
      {
        kind: 'message',
        parts: [
          { kind: 'text', content: '麻烦 ' },
          { kind: 'at', userId: '123456', label: '小祥' },
          { kind: 'text', content: ' 看一下' },
        ],
      },
    ]);
  });

  it('resolves adjacent inline mentions separated by a single space', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const ready = await orchestrator.handle(createGroupTurnInput('提醒两个人'), createGroupSession([
      { user_id: 123456, card: '小祥', nickname: '小祥' },
      { user_id: 456789, card: '小月', nickname: '小月' },
    ]), {
      routeHint: 'agent',
      capabilitySnapshot: {
        canMultiline: true,
        canMention: true,
        canVoice: false,
        canSticker: false,
        stickerAvailableCount: 0,
        source: 'test',
      },
      responseMessage: createStructuredResponse({
        decision: 'reply',
        outbound_messages: [{ type: 'message', content: '@小祥 @小月 看一下' }],
      }),
    });

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') {
      throw new Error('expected ready');
    }
    expect(ready.actions).toEqual([
      {
        kind: 'message',
        parts: [
          { kind: 'at', userId: '123456', label: '小祥' },
          { kind: 'text', content: ' ' },
          { kind: 'at', userId: '456789', label: '小月' },
          { kind: 'text', content: ' 看一下' },
        ],
      },
    ]);
  });

  it('keeps unmatched, ambiguous, private, and no-space at text as plain text', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const context = {
      routeHint: 'agent' as const,
      capabilitySnapshot: {
        canMultiline: true,
        canMention: true,
        canVoice: false,
        canSticker: false,
        stickerAvailableCount: 0,
        source: 'test',
      },
      responseMessage: createStructuredResponse({
        decision: 'reply',
        outbound_messages: [{ type: 'message', content: '@小祥 看一下' }],
      }),
    };

    await expect(
      orchestrator.handle(createGroupTurnInput('提醒一下对方'), createGroupSession([]), context),
    ).resolves.toMatchObject({
      status: 'ready',
      actions: [
        {
          kind: 'message',
          parts: [
            { kind: 'text', content: '@小祥' },
            { kind: 'text', content: ' 看一下' },
          ],
        },
      ],
    });

    await expect(
      orchestrator.handle(createGroupTurnInput('提醒一下对方'), createGroupSession([
        { user_id: 123456, card: '小祥', nickname: 'a' },
        { user_id: 456789, card: '小祥', nickname: 'b' },
      ]), context),
    ).resolves.toMatchObject({
      status: 'ready',
      actions: [
        {
          kind: 'message',
          parts: [
            { kind: 'text', content: '@小祥' },
            { kind: 'text', content: ' 看一下' },
          ],
        },
      ],
    });

    await expect(
      orchestrator.handle(createTurnInput('提醒一下对方'), createGroupSession(), context),
    ).resolves.toMatchObject({
      status: 'ready',
      actions: [
        {
          kind: 'message',
          parts: [{ kind: 'text', content: '@小祥 看一下' }],
        },
      ],
    });

    await expect(
      orchestrator.handle(createGroupTurnInput('提醒一下对方'), createGroupSession([
        { user_id: 123456, card: '小祥', nickname: '小祥' },
      ]), {
        ...context,
        responseMessage: createStructuredResponse({
          decision: 'reply',
          outbound_messages: [{ type: 'message', content: '@小祥看一下' }],
        }),
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      actions: [
        {
          kind: 'message',
          parts: [{ kind: 'text', content: '@小祥看一下' }],
        },
      ],
    });
  });

  it('resolves structured block content as a dedicated action', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const ready = await orchestrator.handle(createTurnInput('列个清单'), {} as never, {
      routeHint: 'agent',
      capabilitySnapshot: {
        canMultiline: true,
        canVoice: false,
        canSticker: false,
        stickerAvailableCount: 0,
        source: 'test',
      },
      responseMessage: createStructuredResponse({
        decision: 'reply',
        outbound_messages: [
          { type: 'structured_block', content: '* 牛奶\n2) 面包' },
        ],
      }),
    });

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') {
      throw new Error('expected ready');
    }
    expect(ready.reply).toEqual({
      decision: 'reply',
      outbound_messages: [
        { type: 'structured_block', content: '- 牛奶\n2. 面包' },
      ],
    });
    expect(ready.actions).toEqual([
      { kind: 'structured_block', content: '- 牛奶\n2. 面包' },
    ]);
  });

  it('resolves image outbound messages into image actions', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const ready = await orchestrator.handle(createTurnInput('给我图'), {} as never, {
      routeHint: 'agent',
      capabilitySnapshot: {
        canMultiline: true,
        canVoice: false,
        canSticker: false,
        stickerAvailableCount: 0,
        source: 'test',
      },
      responseMessage: createStructuredResponse({
        decision: 'reply',
        outbound_messages: [
          { type: 'image', assetRef: 'https://example.com/cf.png', alt: 'Codeforces 分数卡' },
        ],
      }),
    });

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') {
      throw new Error('expected ready');
    }
    expect(ready.reply).toEqual({
      decision: 'reply',
      outbound_messages: [
        { type: 'image', assetRef: 'https://example.com/cf.png', alt: 'Codeforces 分数卡' },
      ],
    });
    expect(ready.actions).toEqual([
      { kind: 'image', assetRef: 'https://example.com/cf.png', alt: 'Codeforces 分数卡' },
    ]);
  });

  it('sends Codeforces card images before text evaluation even if the model orders them late', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const ready = await orchestrator.handle(createTurnInput('cf liuliu00'), {} as never, {
      routeHint: 'agent',
      capabilitySnapshot: {
        canMultiline: true,
        canVoice: false,
        canSticker: false,
        stickerAvailableCount: 0,
        source: 'test',
      },
      responseMessage: createStructuredResponse({
        decision: 'reply',
        outbound_messages: [
          { type: 'message', content: 'liuliu00 目前 rating 896，段位 newbie。' },
          { type: 'image', assetRef: 'https://example.com/cf.png', alt: 'liuliu00 的 Codeforces 分数卡' },
        ],
      }),
    });

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') {
      throw new Error('expected ready');
    }
    expect(ready.reply).toEqual({
      decision: 'reply',
      outbound_messages: [
        { type: 'message', content: 'liuliu00 目前 rating 896，段位 newbie。' },
        { type: 'image', assetRef: 'https://example.com/cf.png', alt: 'liuliu00 的 Codeforces 分数卡' },
      ],
    });
    expect(ready.actions).toEqual([
      { kind: 'image', assetRef: 'https://example.com/cf.png', alt: 'liuliu00 的 Codeforces 分数卡' },
      { kind: 'message', parts: [{ kind: 'text', content: 'liuliu00 目前 rating 896，段位 newbie。' }] },
    ]);
  });

  it('sanitizes markdown-like message content into ordinary plain text', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const ready = await orchestrator.handle(createTurnInput('回一句'), {} as never, {
      routeHint: 'agent',
      capabilitySnapshot: {
        canMultiline: true,
        canVoice: false,
        canSticker: false,
        stickerAvailableCount: 0,
        source: 'test',
      },
      responseMessage: createStructuredResponse({
        decision: 'reply',
        outbound_messages: [
          { type: 'message', content: '# 标题\n- 第一项\n2. 第二项' },
        ],
      }),
    });

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') {
      throw new Error('expected ready');
    }
    expect(ready.reply).toEqual({
      decision: 'reply',
      outbound_messages: [
        { type: 'message', content: '标题\n第一项\n第二项' },
      ],
    });
    expect(ready.actions).toEqual([
      { kind: 'message', parts: [{ kind: 'text', content: '标题\n第一项\n第二项' }] },
    ]);
  });

  it('rejects decision=reply when messages are missing', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('回一句'), {} as never, {
        routeHint: 'agent',
        responseMessage: createStructuredResponse({
          decision: 'reply',
        }),
      }),
    ).rejects.toThrow('must include at least one outbound message');
  });

  it('treats reply outputs with only empty normalized messages as no_reply', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('回一句'), {} as never, {
        routeHint: 'agent',
        responseMessage: createStructuredResponse({
          decision: 'reply',
          outbound_messages: [{ type: 'message', content: '' }],
        }),
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      reply: {
        decision: 'reply',
        outbound_messages: [{ type: 'message', content: '' }],
      },
      actions: [{ kind: 'no_reply' }],
    });
  });

  it('accepts strict JSON strings and rejects non-JSON text immediately', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('回一句'), {} as never, {
        routeHint: 'agent',
        responseMessage: createStructuredResponse({
          decision: 'reply',
          outbound_messages: [{ type: 'message', content: '收到。' }],
        }),
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      reply: {
        decision: 'reply',
        outbound_messages: [{ type: 'message', content: '收到。' }],
      },
    });

    await expect(
      orchestrator.handle(createTurnInput('回一句'), {} as never, {
        routeHint: 'agent',
        responseMessage: {
          content: '收到，这就去查。',
        },
      }),
    ).rejects.toMatchObject({
      name: 'StructuredReplyCompilerError',
      diagnostic: expect.objectContaining({
        failureKind: 'invalid_structured_json',
      }),
    });
  });

  it('compiles CHAT_REPLY_V1 text protocol when selected by the route', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('回一句'), {} as never, {
        routeHint: 'agent',
        outputProtocol: 'chat_reply_v1',
        responseMessage: {
          content: [
            'CHAT_REPLY_V1 abc12345',
            'DECISION reply',
            'BEGIN message',
            'CONTENT',
            '|收到。',
            'END',
            'DONE abc12345',
          ].join('\n'),
        },
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      reply: {
        decision: 'reply',
        outbound_messages: [{ type: 'message', content: '收到。' }],
      },
      actions: [{ kind: 'message', parts: [{ kind: 'text', content: '收到。' }] }],
      assistantHistoryText: [
        'CHAT_REPLY_V1 history',
        'DECISION reply',
        'BEGIN message',
        'CONTENT',
        '|收到。',
        'END',
        'DONE history',
      ].join('\n'),
    });
  });

  it('compiles CHAT_REPLY_V1 text protocol with bare blank payload lines from chat models', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('我的性格是怎样的？'), {} as never, {
        routeHint: 'agent',
        outputProtocol: 'chat_reply_v1',
        responseMessage: {
          content: [
            'CHAT_REPLY_V1 a1b2c3d4',
            'DECISION reply',
            'BEGIN message',
            'CONTENT',
            '|你——急性子，嘴快，爱挑刺，但也知道什么时候该收手。',
            '',
            '|对技术话题有热情，喜欢刨根问底，不会满足于敷衍的答案。',
            '',
            '|不算坏人。',
            'END',
            'DONE a1b2c3d4',
          ].join('\n'),
        },
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      reply: {
        decision: 'reply',
        outbound_messages: [
          {
            type: 'message',
            content: [
              '你——急性子，嘴快，爱挑刺，但也知道什么时候该收手。',
              '',
              '对技术话题有热情，喜欢刨根问底，不会满足于敷衍的答案。',
              '',
              '不算坏人。',
            ].join('\n'),
          },
        ],
      },
    });
  });

  it('rejects plain-text CHAT_REPLY_V1 misses instead of repairing them into natural-language history', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const plainText = [
      '就是日语里的"你好"。最简单的打招呼。',
      '',
      '她大概是因为我刚说了偶尔会说日语，就用日语打了声招呼。',
    ].join('\n');

    await expect(
      orchestrator.handle(createTurnInput('他说那句话是什么意思啊'), {} as never, {
        routeHint: 'agent',
        outputProtocol: 'chat_reply_v1',
        responseMessage: {
          content: plainText,
        },
      }),
    ).rejects.toMatchObject({
      name: 'StructuredReplyCompilerError',
      diagnostic: expect.objectContaining({
        failureKind: 'invalid_text_protocol',
        outputProtocol: 'chat_reply_v1',
        protocolErrorCode: 'MISSING_HEADER',
      }),
    });
  });

  it('compiles CHAT_REPLY_V1 output even when payload paragraph lines are not pipe-prefixed', () => {
    const compiler = new StructuredReplyCompilerService(
      [
        'CHAT_REPLY_V1 history',
        'DECISION reply',
        'BEGIN message',
        'CONTENT',
        '|篮球……国一？',
        '',
        '这问题问得没头没脑的。我对篮球没什么兴趣，也不清楚你指的是哪个所谓"国一"。',
        '',
        '如果你是想讨论体育话题，建议你找别人。不过如果是和音乐或演出相关的事，我倒可以听听。',
        'END',
        'DONE history',
      ].join('\n'),
      { outputProtocol: 'chat_reply_v1' },
    );

    expect(compiler.compile()).toEqual({
      decision: 'reply',
      outbound_messages: [
        {
          type: 'message',
          content: [
            '篮球……国一？',
            '',
            '这问题问得没头没脑的。我对篮球没什么兴趣，也不清楚你指的是哪个所谓"国一"。',
            '',
            '如果你是想讨论体育话题，建议你找别人。不过如果是和音乐或演出相关的事，我倒可以听听。',
          ].join('\n'),
        },
      ],
    });
  });

  it('does not repair partial CHAT_REPLY_V1 protocol fragments as plain text', () => {
    const compiler = new StructuredReplyCompilerService(
      [
        'hello',
        'CHAT_REPLY_V1 abc12345',
        'DECISION no_reply',
        'DONE abc12345',
      ].join('\n'),
      { outputProtocol: 'chat_reply_v1' },
    );

    try {
      compiler.compile();
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredReplyCompilerError);
      expect((error as StructuredReplyCompilerError).diagnostic).toMatchObject({
        failureKind: 'invalid_text_protocol',
        outputProtocol: 'chat_reply_v1',
        protocolErrorCode: 'MISSING_HEADER',
      });
    }
  });

  it('throws a dedicated error when the model output is empty', () => {
    const compiler = new StructuredReplyCompilerService('   ');

    expect(() => compiler.compile()).toThrow(StructuredReplyEmptyModelOutputError);
    try {
      compiler.compile();
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredReplyEmptyModelOutputError);
      expect((error as StructuredReplyEmptyModelOutputError).diagnostic).toMatchObject({
        failureKind: 'provider_empty_finish',
        rawTextLength: 0,
      });
    }
  });

  it('rejects fenced json and requires the raw model output itself to be JSON', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('回一句'), {} as never, {
        routeHint: 'agent',
        responseMessage: {
          content: ['```json', '{"decision":"reply","outbound_messages":[{"type":"message","content":"收到。"}]}', '```'].join(
            '\n',
          ),
        },
      }),
    ).rejects.toMatchObject({
      name: 'StructuredReplyCompilerError',
      diagnostic: expect.objectContaining({
        failureKind: 'invalid_structured_json',
      }),
    });
  });

  it('classifies schema-invalid JSON separately from non-JSON text', () => {
    const compiler = new StructuredReplyCompilerService(
      JSON.stringify({
        decision: 'reply',
      }),
    );

    try {
      compiler.compile();
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredReplyCompilerError);
      expect((error as StructuredReplyCompilerError).diagnostic).toMatchObject({
        failureKind: 'invalid_structured_schema',
      });
    }
  });

  it('classifies lost provider tool calls when the diagnostic says they vanished before compilation', () => {
    const compiler = new StructuredReplyCompilerService({
      content: '',
      additional_kwargs: {
        __chatluna_provider_response_diagnostic_v1: {
          requestMode: 'chat_completions',
          providerToolCallCount: 1,
          messageToolCallCount: 0,
          toolCallChunkCount: 0,
          functionCallPresent: false,
        },
      },
    });

    try {
      compiler.compile();
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredReplyEmptyModelOutputError);
      expect((error as StructuredReplyEmptyModelOutputError).diagnostic).toMatchObject({
        failureKind: 'provider_tool_calls_lost',
        requestMode: 'chat_completions',
      });
    }
  });

  it('rejects unavailable voice and meme outputs instead of downgrading them', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('来个语音和表情包'), {} as never, {
        routeHint: 'agent',
        capabilitySnapshot: {
          canMultiline: true,
          canVoice: false,
          canSticker: false,
          stickerAvailableCount: 0,
          source: 'test',
        },
        responseMessage: createStructuredResponse({
          decision: 'reply',
          outbound_messages: [
            { type: 'voice', content: '查到了。' },
            { type: 'meme', content: '无语地看对方一眼' },
          ],
        }),
      }),
    ).rejects.toThrow('voice output but voice capability is unavailable');
  });

  it('rejects obsolete message mentions fields', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('列个清单'), {} as never, {
        routeHint: 'agent',
        responseMessage: createStructuredResponse({
          decision: 'reply',
          outbound_messages: [{ type: 'message', content: 'hi', mentions: ['u1'] }],
        }),
      }),
    ).rejects.toThrow('outbound_messages.0 Unrecognized key');
  });
});
