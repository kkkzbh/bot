import type { MemoryV2StatusSnapshot } from '../../types/memory-v2.js';

export function createUnavailableMemoryV2StatusSnapshot(
  overrides: Partial<MemoryV2StatusSnapshot> = {},
): MemoryV2StatusSnapshot {
  return {
    available: false,
    enabled: false,
    extractConfigured: false,
    embedConfigured: false,
    extractModel: '',
    embedBaseUrl: '',
    embedModel: '',
    jobs: {
      extractPending: 0,
      extractProcessing: 0,
      embedPending: 0,
      embedProcessing: 0,
    },
    lastArchiveAt: null,
    extract: {
      configured: false,
      state: 'never',
      lastSource: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastLatencyMs: null,
      lastError: null,
      consecutiveFailures: 0,
    },
    embed: {
      configured: false,
      state: 'never',
      lastSource: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastLatencyMs: null,
      lastError: null,
      consecutiveFailures: 0,
    },
    ...overrides,
  };
}
