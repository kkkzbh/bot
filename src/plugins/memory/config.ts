import type { MemoryEmbedRuntime } from './providers/embedding-client.js';
import type { MemoryProviderProfile } from './providers/router.js';

export interface MemoryRuntimeConfig {
  enabled: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
  extract: MemoryProviderProfile;
  embed: MemoryEmbedRuntime;
  queryTopK: number;
  promptBudgetTokens: number;
  embedBatchSize: number;
  extractIdleMs: number;
  extractMessageBatch: number;
  archiveDays: number;
  maxJobRetries: number;
  jobLockTimeoutMs: number;
  maxFacts: number;
  maxEpisodes: number;
}
