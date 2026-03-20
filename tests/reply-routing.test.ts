import { describe, expect, it } from 'vitest';
import { resolveReplyRoute } from '../src/plugins/reply/plan/routing.js';

describe('reply routing', () => {
  it('defaults daily chat with sticker capability to structured', () => {
    expect(
      resolveReplyRoute({
        inputText: '今天怎么这么安静',
        turnIntent: { mode: 'explicit_request' },
        capabilities: {
          canMultiline: true,
          canVoice: false,
          canSticker: true,
        },
      }),
    ).toEqual({
      route: 'structured',
      reason: 'daily_chat_with_sticker',
    });
  });

  it('routes code and analysis tasks to plain text', () => {
    expect(
      resolveReplyRoute({
        inputText: '帮我分析这段日志并解释原因',
        turnIntent: { mode: 'explicit_request' },
        capabilities: {
          canMultiline: true,
          canVoice: true,
          canSticker: true,
        },
      }),
    ).toEqual({
      route: 'plain',
      reason: 'plain_text_task',
    });
  });

  it('forces structured mode for explicit rich output requests', () => {
    expect(
      resolveReplyRoute({
        inputText: '给我发个表情包然后再语音说一句晚安',
        turnIntent: { mode: 'explicit_request' },
        capabilities: {
          canMultiline: true,
          canVoice: true,
          canSticker: true,
        },
      }),
    ).toEqual({
      route: 'structured',
      reason: 'explicit_rich_request',
    });
  });
});
