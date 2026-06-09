import { describe, expect, it } from 'vitest';
import { parseMemoryV2Scope } from '../src/plugins/memory/migration/parse-v2-scope.js';
import { decideMigratedVisibility } from '../src/plugins/memory/migration/policy.js';

describe('memory-v3 migration helpers', () => {
  it('maps direct and group legacy scopes into userKey plus contextKey', () => {
    expect(parseMemoryV2Scope('user', 'onebot:20001:user:10001')).toMatchObject({
      userKey: 'onebot:user:10001',
      contextKey: 'onebot:bot:20001:dm:10001',
      groupId: null,
    });
    expect(parseMemoryV2Scope('user_group', 'onebot:20001:group:g1:user:10001')).toMatchObject({
      userKey: 'onebot:user:10001',
      contextKey: 'onebot:bot:20001:group:g1',
      groupId: 'g1',
    });
  });

  it('applies conservative migration visibility policy', () => {
    const direct = parseMemoryV2Scope('user', 'onebot:20001:user:10001')!;
    const group = parseMemoryV2Scope('user_group', 'onebot:20001:group:g1:user:10001')!;
    expect(decideMigratedVisibility({ scope: direct, content: '用户喜欢简洁回答' })).toMatchObject({
      visibility: 'global',
      sensitivity: 'low',
      drop: false,
    });
    expect(decideMigratedVisibility({ scope: direct, content: '用户手机号 13800138000' })).toMatchObject({
      visibility: 'private_only',
      sensitivity: 'sensitive',
    });
    expect(decideMigratedVisibility({ scope: group, content: '用户在群里喜欢短回答' })).toMatchObject({
      visibility: 'source_context_only',
    });
  });
});
