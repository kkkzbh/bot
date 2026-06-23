import { describe, expect, it } from 'vitest';
import { resolveChatLunaRoomLike } from '../src/plugins/shared/chatluna-conversation.js';

describe('chatluna conversation resolution adapter', () => {
  it('uses effective conversation runtime fields instead of stale room or conversation values', () => {
    const room = resolveChatLunaRoomLike({
      room: {
        conversationId: 'stale-room-conv',
        roomId: 9,
        model: 'stale-room-model',
        preset: 'stale-room-preset',
        chatMode: 'chat',
      },
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
    });

    expect(room).toEqual(expect.objectContaining({
      conversationId: 'conv-effective',
      roomId: 7,
      model: 'effective-model',
      preset: 'effective-preset',
      chatMode: 'plugin',
    }));
  });
});
