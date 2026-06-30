import { describe, expect, it, vi } from 'vitest';
import { createChatLunaHistoryWriter } from '../src/plugins/shared/chatluna-history.js';

describe('ChatLuna history writer runtime boundary', () => {
  it('loads ChatLuna message history through the runtime CommonJS export', async () => {
    const writer = await createChatLunaHistoryWriter({
      database: {
        get: vi.fn(),
        create: vi.fn(),
        remove: vi.fn(),
        upsert: vi.fn(),
      },
      logger: {
        warn: vi.fn(),
      },
      conversationId: 'conv-runtime-boundary',
      chatluna: {},
    });

    expect(writer.addMessages).toBeTypeOf('function');
  });
});
