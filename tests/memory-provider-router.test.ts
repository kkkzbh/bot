import { describe, expect, it } from 'vitest';
import { parseMemoryExtractionJson } from '../src/plugins/memory/providers/schemas.js';
import { resolveMemoryOutputProtocol, type MemoryProviderProfile } from '../src/plugins/memory/providers/router.js';

function profile(overrides: Partial<MemoryProviderProfile>): MemoryProviderProfile {
  return {
    routeId: 'test',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'sk-test',
    model: 'model',
    timeoutMs: 1000,
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'native_chat_json_schema',
    ...overrides,
  };
}

describe('memory provider router', () => {
  it('maps main structured output protocol to memory-specific routes', () => {
    expect(resolveMemoryOutputProtocol(profile({ structuredOutputProtocol: 'native_responses_json_schema' }))).toBe('native_responses_json_schema');
    expect(resolveMemoryOutputProtocol(profile({ structuredOutputProtocol: 'native_chat_json_schema' }))).toBe('native_chat_json_schema');
    expect(resolveMemoryOutputProtocol(profile({ structuredOutputProtocol: 'chat_reply_v1' }))).toBe('plain_text_memory_v1');
    expect(resolveMemoryOutputProtocol(profile({ structuredOutputProtocol: 'json_mode', supportsJsonMode: true }))).toBe('json_mode_with_repair');
    expect(resolveMemoryOutputProtocol(profile({ structuredOutputProtocol: 'json_mode', supportsJsonMode: false }))).toBe('no_write_fallback');
  });

  it('normalizes JSON fact kind aliases from provider output', () => {
    const [candidate] = parseMemoryExtractionJson(JSON.stringify({
      facts: [{
        subject: 'target_user',
        ownerSpeakerId: '10001',
        kind: 'interest',
        topicKey: 'music',
        content: '用户喜欢钢琴曲',
        keywords: ['钢琴'],
        importance: 0.7,
        confidence: 0.82,
        sensitivity: 'low',
        suggestedVisibility: 'global',
        applicability: null,
        evidence: null,
        evidenceMessageIds: ['m-1'],
        evidenceSpeakerIds: ['10001'],
        conflictHint: null,
        validFrom: null,
        validUntil: null,
        expiresAt: null,
      }],
      episodes: [],
      drops: [],
    }));

    expect(candidate).toMatchObject({
      candidateType: 'fact',
      kind: 'preference',
      topicKey: 'music',
    });
  });
});
