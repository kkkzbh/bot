import { describe, expect, it } from 'vitest';
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

describe('memory-v3 provider router', () => {
  it('maps main structured output protocol to memory-specific routes', () => {
    expect(resolveMemoryOutputProtocol(profile({ structuredOutputProtocol: 'native_responses_json_schema' }))).toBe('native_responses_json_schema');
    expect(resolveMemoryOutputProtocol(profile({ structuredOutputProtocol: 'native_chat_json_schema' }))).toBe('native_chat_json_schema');
    expect(resolveMemoryOutputProtocol(profile({ structuredOutputProtocol: 'chat_reply_v1' }))).toBe('plain_text_memory_v1');
    expect(resolveMemoryOutputProtocol(profile({ structuredOutputProtocol: 'json_mode', supportsJsonMode: true }))).toBe('json_mode_with_repair');
    expect(resolveMemoryOutputProtocol(profile({ structuredOutputProtocol: 'json_mode', supportsJsonMode: false }))).toBe('no_write_fallback');
  });
});
