import { describe, expect, it } from 'vitest';
import { buildReplyPlanDebugPayload } from '../src/plugins/reply/pipeline/debug.js';

describe('reply debug payload', () => {
  it('uses ChatLuna conversation resolution fields without legacy room projection', () => {
    const context = {
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
    };

    const payload = buildReplyPlanDebugPayload(
      context,
      { stage: 'unit-test' },
    );

    expect(payload).toEqual(expect.objectContaining({
      conversationId: 'conv-debug',
      roomModel: 'openai/gpt-5.4-mini',
      preset: 'sakiko',
      stage: 'unit-test',
    }));
    expect(payload).not.toHaveProperty('roomId');
  });
});
