import { describe, expect, it } from 'vitest';
import { buildMemoryAddress } from '../src/plugins/memory/address.js';

describe('memory-v3 address', () => {
  it('builds direct address by userKey and dm contextKey', () => {
    const address = buildMemoryAddress(
      {
        isDirect: true,
        platform: 'onebot',
        userId: '10001',
        channelId: 'dm-1',
        bot: { selfId: '20001' },
      } as any,
      { options: { room: { conversationId: 'conv-1' } } },
      123,
    );
    expect(address).toMatchObject({
      userKey: 'onebot:user:10001',
      contextKey: 'onebot:bot:20001:dm:10001',
      channelType: 'direct',
      conversationId: 'conv-1',
      observedAt: 123,
    });
  });

  it('uses guildId then channelId fallback for group contextKey', () => {
    const address = buildMemoryAddress(
      {
        isDirect: false,
        platform: 'onebot',
        userId: '10001',
        channelId: 'channel-9',
        bot: { selfId: '20001' },
      } as any,
      { options: { room: { conversationId: 'conv-2' } } },
      456,
    );
    expect(address).toMatchObject({
      userKey: 'onebot:user:10001',
      contextKey: 'onebot:bot:20001:group:channel-9',
      channelType: 'group',
      channelId: 'channel-9',
      rawContextId: 'channel-9',
    });
  });
});
