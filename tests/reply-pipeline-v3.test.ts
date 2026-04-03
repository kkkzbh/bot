import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => ({
  h: {
    parse: () => [],
  },
}));

import { normalizeReplyChatMode } from '../src/plugins/reply/compat.js';
import { buildReplyTurnContext, buildReplyTurnInput, normalizeReplyRouteHint } from '../src/plugins/reply/pipeline/context-builder.js';
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
        messages: [
          { modality: 'voice', content: '收到。' },
          { modality: 'meme', content: '无语地看对方一眼' },
        ],
      }),
    });

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') {
      throw new Error('expected ready');
    }
    expect(ready.reply).toEqual({
      decision: 'reply',
      messages: [
        { modality: 'voice', content: '收到。' },
        { modality: 'meme', content: '无语地看对方一眼' },
      ],
    });
    expect(ready.actions).toEqual([
      { kind: 'voice', content: '收到。' },
      { kind: 'sticker', intent: '无语地看对方一眼' },
    ]);
  });

  it('resolves rich_text actions with inline mention segments', async () => {
    const orchestrator = new ReplyOrchestratorService();
    const ready = await orchestrator.handle(createTurnInput('提醒一下对方'), {} as never, {
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
        messages: [
          {
            modality: 'rich_text',
            segments: [
              { kind: 'text', text: '先问下 ' },
              { kind: 'mention', userId: '123456' },
              { kind: 'text', text: ' 这件事。' },
            ],
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
      messages: [
        {
          modality: 'rich_text',
          segments: [
            { kind: 'text', text: '先问下 ' },
            { kind: 'mention', userId: '123456' },
            { kind: 'text', text: ' 这件事。' },
          ],
        },
      ],
    });
    expect(ready.actions).toEqual([
      {
        kind: 'rich_text',
        segments: [
          { kind: 'text', text: '先问下 ' },
          { kind: 'mention', userId: '123456' },
          { kind: 'text', text: ' 这件事。' },
        ],
      },
    ]);
  });

  it('resolves multiline actions when the capability is available', async () => {
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
        messages: [
          { modality: 'multiline', semantic: 'unordered_list', content: '- 牛奶\n- 面包' },
        ],
      }),
    });

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') {
      throw new Error('expected ready');
    }
    expect(ready.reply).toEqual({
      decision: 'reply',
      messages: [
        { modality: 'multiline', semantic: 'unordered_list', content: '- 牛奶\n- 面包' },
      ],
    });
    expect(ready.actions).toEqual([
      { kind: 'multiline', semantic: 'unordered_list', content: '- 牛奶\n- 面包' },
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
    ).rejects.toThrow('must include at least one message');
  });

  it('treats reply outputs with only empty normalized messages as no_reply', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('回一句'), {} as never, {
        routeHint: 'agent',
        responseMessage: createStructuredResponse({
          decision: 'reply',
          messages: [{ modality: 'text', content: '' }],
        }),
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      reply: {
        decision: 'reply',
        messages: [{ modality: 'text', content: '' }],
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
          messages: [{ modality: 'text', content: '收到。' }],
        }),
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      reply: {
        decision: 'reply',
        messages: [{ modality: 'text', content: '收到。' }],
      },
    });

    await expect(
      orchestrator.handle(createTurnInput('回一句'), {} as never, {
        routeHint: 'agent',
        responseMessage: {
          content: '收到，这就去查。',
        },
      }),
    ).rejects.toThrow('structured reply compiler expected JSON');
  });

  it('rejects fenced json and requires the raw model output itself to be JSON', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('回一句'), {} as never, {
        routeHint: 'agent',
        responseMessage: {
          content: ['```json', '{"decision":"reply","messages":[{"modality":"text","content":"收到。"}]}', '```'].join(
            '\n',
          ),
        },
      }),
    ).rejects.toThrow('structured reply compiler expected JSON');
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
          messages: [
            { modality: 'voice', content: '查到了。' },
            { modality: 'meme', content: '无语地看对方一眼' },
          ],
        }),
      }),
    ).rejects.toThrow('voice output but voice capability is unavailable');
  });

  it('rejects multiline messages without semantic', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('列个清单'), {} as never, {
        routeHint: 'agent',
        responseMessage: createStructuredResponse({
          decision: 'reply',
          messages: [{ modality: 'multiline', content: '- 一\n- 二' }],
        }),
      }),
    ).rejects.toThrow('messages.0.semantic Required');
  });

  it('rejects multiline messages with unknown semantic', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('列个清单'), {} as never, {
        routeHint: 'agent',
        responseMessage: createStructuredResponse({
          decision: 'reply',
          messages: [{ modality: 'multiline', semantic: 'table_block', content: 'a | b' }],
        }),
      }),
    ).rejects.toThrow('messages.0.semantic');
  });

  it('rejects unavailable multiline outputs instead of downgrading them', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('列个清单'), {} as never, {
        routeHint: 'agent',
        capabilitySnapshot: {
          canMultiline: false,
          canVoice: false,
          canSticker: false,
          stickerAvailableCount: 0,
          source: 'test',
        },
        responseMessage: createStructuredResponse({
          decision: 'reply',
          messages: [{ modality: 'multiline', semantic: 'ordered_list', content: '1. 一\n2. 二' }],
        }),
      }),
    ).rejects.toThrow('multiline output but multiline capability is unavailable');
  });

  it('rejects rich_text mention segments with non-numeric user ids', async () => {
    const orchestrator = new ReplyOrchestratorService();

    await expect(
      orchestrator.handle(createTurnInput('提醒一下对方'), {} as never, {
        routeHint: 'agent',
        responseMessage: createStructuredResponse({
          decision: 'reply',
          messages: [
            {
              modality: 'rich_text',
              segments: [
                { kind: 'text', text: '先问下 ' },
                { kind: 'mention', userId: 'u1' },
              ],
            },
          ],
        }),
      }),
    ).rejects.toThrow('messages.0.segments.1.userId');
  });
});
