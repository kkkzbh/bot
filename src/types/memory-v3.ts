import 'koishi';

export type MemoryChannelType = 'direct' | 'group';

export type MemoryVisibility =
  | 'global'
  | 'private_only'
  | 'source_context_only'
  | 'allowed_contexts'
  | 'denied_contexts'
  | 'pending_review'
  | 'archived';

export type MemorySensitivity = 'low' | 'personal' | 'sensitive' | 'secret';

export type MemoryProfileKind =
  | 'identity'
  | 'preference'
  | 'trait'
  | 'boundary'
  | 'plan'
  | 'relationship';

export type MemoryCandidateType = 'fact' | 'episode' | 'drop';
export type MemoryCandidateReviewStatus = 'pending' | 'approved' | 'rejected' | 'pending_review';
export type MemoryRecordType = 'fact' | 'episode';

export type MemoryJobV3Type =
  | 'extract'
  | 'privacy_review'
  | 'consolidate'
  | 'embed'
  | 'reembed'
  | 'maintenance'
  | 'forget'
  | 'migration_backfill'
  | 'eval_probe';

export type MemoryJobV3Status = 'pending' | 'processing' | 'done' | 'failed' | 'dead_letter';
export type MemoryStatusSource = 'runtime' | 'probe' | null;
export type MemoryStatusState = 'never' | 'success' | 'failed';

export type MemoryOutputProtocolId =
  | 'native_responses_json_schema'
  | 'native_chat_json_schema'
  | 'json_mode_with_repair'
  | 'plain_text_memory_v1'
  | 'no_write_fallback';

export interface MemoryAddress {
  userKey: string;
  contextKey: string;
  channelType: MemoryChannelType;
  platform: string;
  botSelfId: string;
  userId: string;
  groupId?: string | null;
  channelId?: string | null;
  rawContextId?: string | null;
  conversationId: string;
  observedAt: number;
}

export interface MemoryUserRecord {
  id: number;
  userKey: string;
  platform: string;
  userId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  readEnabled: number;
  writeEnabled: number;
}

export interface MemoryContextRecord {
  id: number;
  contextKey: string;
  platform: string;
  botSelfId: string;
  channelType: MemoryChannelType;
  groupId: string | null;
  channelId: string | null;
  rawContextId: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface MemoryCandidateV3Record {
  id: number;
  batchId: string;
  candidateType: MemoryCandidateType;
  userKey: string;
  contextKey: string;
  conversationId: string;
  messageIds: string | null;
  payload: string;
  reviewStatus: MemoryCandidateReviewStatus;
  sensitivity: MemorySensitivity;
  suggestedVisibility: MemoryVisibility;
  finalVisibility: MemoryVisibility | null;
  dropReason: string | null;
  providerRoute: MemoryOutputProtocolId;
  rawTextHash: string | null;
  createdAt: number;
  reviewedAt: number | null;
  consolidatedAt: number | null;
}

export interface MemoryFactV3Record {
  id: number;
  userKey: string;
  kind: MemoryProfileKind;
  topicKey: string;
  content: string;
  keywords: string | null;
  importance: number;
  confidence: number;
  sensitivity: MemorySensitivity;
  visibility: MemoryVisibility;
  sourceContextKey: string;
  allowedContextKeys: string | null;
  deniedContextKeys: string | null;
  applicability: string | null;
  validFrom: number | null;
  validUntil: number | null;
  expiresAt: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastAccessedAt: number | null;
  embeddingModel: string | null;
  embedding: string | null;
  version: number;
  archived: number;
  supersedesId: number | null;
  conflictSetId: string | null;
}

export interface MemoryEpisodeV3Record {
  id: number;
  userKey: string;
  title: string;
  summary: string;
  keywords: string | null;
  importance: number;
  confidence: number;
  sensitivity: MemorySensitivity;
  visibility: MemoryVisibility;
  sourceContextKey: string;
  allowedContextKeys: string | null;
  deniedContextKeys: string | null;
  applicability: string | null;
  periodStart: number | null;
  periodEnd: number | null;
  validFrom: number | null;
  validUntil: number | null;
  expiresAt: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastAccessedAt: number | null;
  embeddingModel: string | null;
  embedding: string | null;
  version: number;
  archived: number;
  supersedesId: number | null;
  conflictSetId: string | null;
}

export interface MemoryProvenanceRecord {
  id: number;
  userKey: string;
  contextKey: string;
  memoryType: MemoryRecordType;
  memoryId: number;
  candidateId: number | null;
  conversationId: string | null;
  messageIds: string | null;
  source: string;
  createdAt: number;
}

export interface MemoryJobV3Record {
  id: number;
  jobKey: string;
  jobType: MemoryJobV3Type;
  status: MemoryJobV3Status;
  payload: string;
  retryCount: number;
  nextRunAt: number;
  lockedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryAuditEventRecord {
  id: number;
  userKey: string | null;
  contextKey: string | null;
  eventType: string;
  memoryType: MemoryRecordType | null;
  memoryId: number | null;
  candidateId: number | null;
  turnId: string | null;
  detail: string | null;
  createdAt: number;
}

export interface MemoryTombstoneRecord {
  id: number;
  userKey: string;
  contextKey: string | null;
  memoryType: MemoryRecordType | 'candidate' | 'source' | 'topic';
  memoryId: number | null;
  topicKey: string | null;
  sourceMessageId: string | null;
  reason: string | null;
  createdAt: number;
}

export interface MemoryV3QueueSummary {
  extractPending: number;
  extractProcessing: number;
  privacyReviewPending: number;
  consolidatePending: number;
  embedPending: number;
  embedProcessing: number;
  deadLetter: number;
}

export interface MemoryV3OperationSnapshot {
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

export interface MemoryV3ProviderRouteStats {
  route: MemoryOutputProtocolId;
  success: number;
  failure: number;
  lastError: string | null;
}

export interface MemoryV3StatusSnapshot {
  available: boolean;
  enabled: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
  extractConfigured: boolean;
  embedConfigured: boolean;
  extractModel: string;
  embedBaseUrl: string;
  embedModel: string;
  jobs: MemoryV3QueueSummary;
  providerRoutes: MemoryV3ProviderRouteStats[];
  lastMaintenanceAt: number | null;
  extract: MemoryV3OperationSnapshot;
  embed: MemoryV3OperationSnapshot;
}

export interface MemoryV3ProbeResult {
  target: 'embedding' | 'extraction' | 'provider';
  ok: boolean;
  checkedAt: number;
  latencyMs: number | null;
  error: string | null;
  snapshot: MemoryV3StatusSnapshot;
}

export interface MemoryV3StatusServiceLike {
  getSnapshot(): Promise<MemoryV3StatusSnapshot>;
  probeEmbedding(): Promise<MemoryV3ProbeResult>;
  probeExtraction?(): Promise<MemoryV3ProbeResult>;
  probeProvider?(): Promise<MemoryV3ProbeResult>;
}

declare module 'koishi' {
  interface Tables {
    memory_user: MemoryUserRecord;
    memory_context: MemoryContextRecord;
    memory_candidate_v3: MemoryCandidateV3Record;
    memory_fact_v3: MemoryFactV3Record;
    memory_episode_v3: MemoryEpisodeV3Record;
    memory_provenance: MemoryProvenanceRecord;
    memory_job_v3: MemoryJobV3Record;
    memory_audit_event: MemoryAuditEventRecord;
    memory_tombstone: MemoryTombstoneRecord;
  }

  interface Context {
    memoryV3Status?: MemoryV3StatusServiceLike;
  }
}
