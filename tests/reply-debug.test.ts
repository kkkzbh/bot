import { describe, expect, it } from 'vitest';
import { buildReplyPlanDebugPayload } from '../src/plugins/reply/pipeline/debug.js';

describe('reply debug payload', () => {
  it('uses ChatLuna conversation resolution fields without legacy room data', () => {
    const payload = buildReplyPlanDebugPayload(
      {
        options: {
          conversation: {
            conversationId: 'conv-debug',
            effectiveModel: 'openai/gpt-5.4-mini',
            effectivePreset: 'sakiko',
            conversation: {
              id: 'conv-debug',
              legacyRoomId: 7,
              model: 'stale-model',
              preset: 'stale-preset',
            },
          },
        },
      },
      { stage: 'unit-test' },
    );

    expect(payload).toEqual(expect.objectContaining({
      conversationId: 'conv-debug',
      roomId: 7,
      roomModel: 'openai/gpt-5.4-mini',
      preset: 'sakiko',
      stage: 'unit-test',
    }));
  });
});
