import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => ({
  h: {
    parse: () => [],
  },
}));

import { normalizeReplyChatMode } from '../src/plugins/reply/compat.js';
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

  it('resolves message actions with inline mentions', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const ready = await orchestrator.handle(createTurnInput('提醒一下对方'), {} as never, {
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
            content: '先问下这件事。',
            mentions: ['123456'],
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
          content: '先问下这件事。',
          mentions: ['123456'],
        },
      ],
    });
    expect(ready.actions).toEqual([
      {
        kind: 'message',
        content: '先问下这件事。',
        mentions: ['123456'],
      },
    ]);
  });

  it('lifts leading handwritten mention tokens into structured mentions and dedupes them', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const ready = await orchestrator.handle(createTurnInput('提醒一下对方'), {} as never, {
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
            content: '[mention:123456] [mention:123456] 先问下这件事。',
            mentions: ['123456'],
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
          content: '先问下这件事。',
          mentions: ['123456'],
        },
      ],
    });
    expect(ready.actions).toEqual([
      {
        kind: 'message',
        content: '先问下这件事。',
        mentions: ['123456'],
      },
    ]);
  });

  it('appends handwritten leading mention tokens after explicit mentions and keeps mention-only replies', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const ready = await orchestrator.handle(createTurnInput('提醒两个人'), {} as never, {
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
            content: '[mention:456789] 继续跟进。',
            mentions: ['123456'],
          },
          {
            type: 'message',
            content: '[mention:789012]',
            mentions: [],
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
          content: '继续跟进。',
          mentions: ['123456', '456789'],
        },
        {
          type: 'message',
          content: '',
          mentions: ['789012'],
        },
      ],
    });
    expect(ready.actions).toEqual([
      {
        kind: 'message',
        content: '继续跟进。',
        mentions: ['123456', '456789'],
      },
      {
        kind: 'message',
        content: '',
        mentions: ['789012'],
      },
    ]);
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
        { type: 'structured_block', content: '- 牛奶\n1. 面包' },
      ],
    });
    expect(ready.actions).toEqual([
      { kind: 'structured_block', content: '- 牛奶\n1. 面包' },
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
          { type: 'message', content: 'liuliu00 目前 rating 896，段位 newbie。', mentions: [] },
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
        { type: 'message', content: 'liuliu00 目前 rating 896，段位 newbie。', mentions: [] },
        { type: 'image', assetRef: 'https://example.com/cf.png', alt: 'liuliu00 的 Codeforces 分数卡' },
      ],
    });
    expect(ready.actions).toEqual([
      { kind: 'image', assetRef: 'https://example.com/cf.png', alt: 'liuliu00 的 Codeforces 分数卡' },
      { kind: 'message', content: 'liuliu00 目前 rating 896，段位 newbie。', mentions: [] },
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
          { type: 'message', content: '# 标题\n- 第一项\n2. 第二项', mentions: [] },
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
        { type: 'message', content: '标题\n第一项\n第二项', mentions: [] },
      ],
    });
    expect(ready.actions).toEqual([
      { kind: 'message', content: '标题\n第一项\n第二项', mentions: [] },
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
          outbound_messages: [{ type: 'message', content: '', mentions: [] }],
        }),
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      reply: {
        decision: 'reply',
        outbound_messages: [{ type: 'message', content: '', mentions: [] }],
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
          outbound_messages: [{ type: 'message', content: '收到。', mentions: [] }],
        }),
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      reply: {
        decision: 'reply',
        outbound_messages: [{ type: 'message', content: '收到。', mentions: [] }],
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
            'MENTIONS none',
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
        outbound_messages: [{ type: 'message', content: '收到。', mentions: [] }],
      },
      actions: [{ kind: 'message', content: '收到。', mentions: [] }],
    });
  });

  it('classifies invalid CHAT_REPLY_V1 output separately from invalid JSON', () => {
    const compiler = new StructuredReplyCompilerService(
      [
        'CHAT_REPLY_V1 abc12345',
        'DECISION reply',
        'BEGIN message',
        'MENTIONS none',
        'CONTENT',
        'missing pipe',
        'END',
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
        protocolErrorCode: 'PAYLOAD_LINE_WITHOUT_PIPE',
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

  it('rejects message mentions with non-numeric user ids', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('列个清单'), {} as never, {
        routeHint: 'agent',
        responseMessage: createStructuredResponse({
          decision: 'reply',
          outbound_messages: [{ type: 'message', content: 'hi', mentions: ['u1'] }],
        }),
      }),
    ).rejects.toThrow('outbound_messages.0.mentions.0');
  });
});
