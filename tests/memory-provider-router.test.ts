import { describe, expect, it } from 'vitest';
import { requestChatMemoryPlainText } from '../src/plugins/memory/providers/chat-client.js';
import { isNonRetryableMemoryProviderError } from '../src/plugins/memory/providers/http-error.js';
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
    expect(resolveMemoryOutputProtocol(profile({ structuredOutputProtocol: 'json_mode', supportsJsonMode: false }))).toBe('unsupported_protocol');
  });

  it('preserves provider error details for non-retryable extract HTTP failures', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ code: 30001, message: 'Sorry, your account balance is insufficient', data: null }),
      { status: 403, statusText: 'Forbidden' },
    );
    try {
      let caught: unknown = null;
      await requestChatMemoryPlainText(
        profile({ structuredOutputProtocol: 'chat_reply_v1' }),
        [{
          id: 'm1',
          role: 'human',
          text: 'hello',
          speakerId: '10001',
          speakerName: 'Alice',
          ownerUserKey: 'onebot:10001',
          isTarget: true,
          attributionSource: 'direct_fallback',
        }],
        { speakerId: '10001', speakerName: 'Alice' },
      ).catch((error: unknown) => {
        caught = error;
      });

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('extract_http_403: Sorry, your account balance is insufficient (code 30001)');
      expect(isNonRetryableMemoryProviderError(caught)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
