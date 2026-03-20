import 'koishi';

export type MemoryScopeType = 'user' | 'user_group';
export type MemoryJobType = 'extract' | 'embed';
export type MemoryJobStatus = 'pending' | 'processing';
export type MemoryStatusSource = 'runtime' | 'probe' | null;
export type MemoryStatusState = 'never' | 'success' | 'failed';

export interface MemoryFactRecord {
  id: number;
  scopeType: MemoryScopeType;
  scopeKey: string;
  topicKey: string;
  content: string;
  keywords: string | null;
  importance: number;
  confidence: number;
  firstSeenAt: number;
  lastSeenAt: number;
  sourceMessageIds: string | null;
  embeddingModel: string | null;
  embedding: string | null;
  version: number;
  archived: number;
}

export interface MemoryEpisodeRecord {
  id: number;
  scopeType: MemoryScopeType;
  scopeKey: string;
  title: string;
  summary: string;
  keywords: string | null;
  importance: number;
  confidence: number;
  periodStart: number | null;
  periodEnd: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastAccessedAt: number | null;
  sourceMessageIds: string | null;
  embeddingModel: string | null;
  embedding: string | null;
  archived: number;
}

export interface MemoryJobRecord {
  id: number;
  jobKey: string;
  jobType: MemoryJobType;
  status: MemoryJobStatus;
  payload: string;
  retryCount: number;
  nextRunAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryV2QueueSummary {
  extractPending: number;
  extractProcessing: number;
  embedPending: number;
  embedProcessing: number;
}

export interface MemoryV2OperationSnapshot {
  configured: boolean;
  state: MemoryStatusState;
  lastSource: MemoryStatusSource;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface MemoryV2StatusSnapshot {
  available: boolean;
  enabled: boolean;
  extractConfigured: boolean;
  embedConfigured: boolean;
  extractModel: string;
  embedBaseUrl: string;
  embedModel: string;
  jobs: MemoryV2QueueSummary;
  lastArchiveAt: number | null;
  extract: MemoryV2OperationSnapshot;
  embed: MemoryV2OperationSnapshot;
}

export interface MemoryV2ProbeResult {
  target: 'embedding';
  ok: boolean;
  checkedAt: number;
  latencyMs: number | null;
  error: string | null;
  snapshot: MemoryV2StatusSnapshot;
}

export interface MemoryV2StatusServiceLike {
  getSnapshot(): Promise<MemoryV2StatusSnapshot>;
  probeEmbedding(): Promise<MemoryV2ProbeResult>;
}

declare module 'koishi' {
  interface Tables {
    memory_fact: MemoryFactRecord;
    memory_episode: MemoryEpisodeRecord;
    memory_job: MemoryJobRecord;
  }

  interface Context {
    memoryV2Status?: MemoryV2StatusServiceLike;
  }
}
