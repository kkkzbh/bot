import { describe, expect, it } from 'vitest';
import { buildGroupSessionScopeKey } from '../src/plugins/shared/group-id.js';

describe('group session scope key', () => {
  it('builds a stable group scope from complete session identity', () => {
    expect(buildGroupSessionScopeKey({
      platform: 'onebot',
      bot: { selfId: 'bot-1' },
      guildId: 'group:100',
      channelId: '200',
      isDirect: false,
    })).toBe('onebot:bot-1:group:100');
  });

  it('rejects incomplete session identity instead of inventing default keys', () => {
    expect(buildGroupSessionScopeKey({
      platform: '',
      bot: { selfId: 'bot-1' },
      guildId: '100',
    })).toBeNull();
    expect(buildGroupSessionScopeKey({
      platform: 'onebot',
      bot: { selfId: '' },
      guildId: '100',
    })).toBeNull();
    expect(buildGroupSessionScopeKey({
      platform: 'onebot',
      bot: { selfId: 'bot-1' },
      guildId: '',
      channelId: '',
    })).toBeNull();
    expect(buildGroupSessionScopeKey({
      platform: 'onebot',
      bot: { selfId: 'bot-1' },
      channelId: 'private-u1',
      isDirect: true,
    })).toBeNull();
  });
});
