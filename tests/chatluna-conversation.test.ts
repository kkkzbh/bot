import { describe, expect, it } from 'vitest';
import { resolveChatLunaRoomLike } from '../src/plugins/shared/chatluna-conversation.js';

describe('chatluna conversation resolution adapter', () => {
  it('uses effective conversation runtime fields instead of stale room or conversation values', () => {
    const context = {
      conversation: {
        conversationId: 'conv-effective',
        effectiveModel: 'effective-model',
        effectivePreset: 'effective-preset',
        effectiveChatMode: 'plugin',
        conversation: {
          id: 'conv-effective',
          legacyRoomId: 7,
          model: 'stale-conversation-model',
          preset: 'stale-conversation-preset',
          chatMode: 'chat',
        },
      },
    };

    const room = resolveChatLunaRoomLike(context);

    expect(room).toEqual(expect.objectContaining({
      conversationId: 'conv-effective',
      model: 'effective-model',
      preset: 'effective-preset',
      chatMode: 'plugin',
    }));
    expect(room).not.toHaveProperty('roomId');
  });
});
