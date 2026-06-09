import { describe, expect, it } from 'vitest';
import { isMemoryVisibleInContext, runDeterministicPrivacyGuard, type ExtractedMemoryCandidate } from '../src/plugins/memory/gates.js';
import type { MemoryAddress } from '../src/types/memory.js';

const groupAddress: MemoryAddress = {
  userKey: 'onebot:user:10001',
  contextKey: 'onebot:bot:20001:group:g1',
  channelType: 'group',
  platform: 'onebot',
  botSelfId: '20001',
  userId: '10001',
  groupId: 'g1',
  channelId: 'g1',
  rawContextId: 'g1',
  conversationId: 'conv',
  observedAt: 1,
};

describe('memory privacy and recall gates', () => {
  it('drops secrets before LLM review', () => {
    const candidate: ExtractedMemoryCandidate = {
      candidateType: 'fact',
      subject: 'target_user',
      kind: 'preference',
      topicKey: 'api-key',
      content: '用户的 token: sk-abcdefghijklmnopqrstuvwxyz123456',
      keywords: [],
      importance: 0.8,
      confidence: 0.9,
      sensitivity: 'low',
      suggestedVisibility: 'global',
    };
    expect(runDeterministicPrivacyGuard(candidate, groupAddress)).toMatchObject({
      status: 'rejected',
      sensitivity: 'secret',
      reason: 'secret_guard',
    });
  });

  it('does not expose private, pending, secret, or other-group source memory in groups', () => {
    expect(isMemoryVisibleInContext({
      visibility: 'private_only',
      sensitivity: 'personal',
      archived: 0,
      sourceContextKey: groupAddress.contextKey,
      address: groupAddress,
      now: 10,
    })).toBe(false);
    expect(isMemoryVisibleInContext({
      visibility: 'pending_review',
      sensitivity: 'low',
      archived: 0,
      sourceContextKey: groupAddress.contextKey,
      address: groupAddress,
      now: 10,
    })).toBe(false);
    expect(isMemoryVisibleInContext({
      visibility: 'source_context_only',
      sensitivity: 'low',
      archived: 0,
      sourceContextKey: 'onebot:bot:20001:group:g2',
      address: groupAddress,
      now: 10,
    })).toBe(false);
    expect(isMemoryVisibleInContext({
      visibility: 'source_context_only',
      sensitivity: 'low',
      archived: 0,
      sourceContextKey: groupAddress.contextKey,
      address: groupAddress,
      now: 10,
    })).toBe(true);
  });
});
