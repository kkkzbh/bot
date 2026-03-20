import type {
  MemoryStatusSource,
  MemoryV2OperationSnapshot,
  MemoryV2ProbeResult,
  MemoryV2QueueSummary,
  MemoryV2StatusServiceLike,
  MemoryV2StatusSnapshot,
} from '../types/memory-v2.js';
import type { MemoryEmbedRuntime, MemoryExtractRuntime } from './memory-v2-llm.js';
import { isEmbedRuntimeConfigured, isExtractRuntimeConfigured } from './memory-v2-llm.js';

interface OperationStatusDraft {
  state: 'never' | 'success' | 'failed';
  lastSource: MemoryStatusSource;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface MemoryV2StatusRuntimeLike {
  enabled: boolean;
  extract: MemoryExtractRuntime;
  embed: MemoryEmbedRuntime;
}

function createEmptyOperationStatus(): OperationStatusDraft {
  return {
    state: 'never',
    lastSource: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastLatencyMs: null,
    lastError: null,
    consecutiveFailures: 0,
  };
}

function toErrorSummary(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function createUnavailableQueueSummary(): MemoryV2QueueSummary {
  return {
    extractPending: 0,
    extractProcessing: 0,
    embedPending: 0,
    embedProcessing: 0,
  };
}

function toOperationSnapshot(
  draft: OperationStatusDraft,
  configured: boolean,
): MemoryV2OperationSnapshot {
  return {
    configured,
    state: draft.state,
    lastSource: draft.lastSource,
    lastAttemptAt: draft.lastAttemptAt,
    lastSuccessAt: draft.lastSuccessAt,
    lastFailureAt: draft.lastFailureAt,
    lastLatencyMs: draft.lastLatencyMs,
    lastError: draft.lastError,
    consecutiveFailures: draft.consecutiveFailures,
  };
}

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
    jobs: createUnavailableQueueSummary(),
    lastArchiveAt: null,
    extract: toOperationSnapshot(createEmptyOperationStatus(), false),
    embed: toOperationSnapshot(createEmptyOperationStatus(), false),
    ...overrides,
  };
}

export class MemoryV2StatusService implements MemoryV2StatusServiceLike {
  private readonly extract = createEmptyOperationStatus();
  private readonly embed = createEmptyOperationStatus();
  private lastArchiveAt: number | null = null;

  constructor(
    private readonly runtime: MemoryV2StatusRuntimeLike,
    private readonly store: { getJobSummary: () => Promise<MemoryV2QueueSummary> },
    private readonly embedProbe: () => Promise<void>,
  ) {}

  recordAttempt(kind: 'extract' | 'embed', source: Exclude<MemoryStatusSource, null>, at = Date.now()): void {
    const target = kind === 'extract' ? this.extract : this.embed;
    target.lastSource = source;
    target.lastAttemptAt = at;
  }

  recordSuccess(
    kind: 'extract' | 'embed',
    source: Exclude<MemoryStatusSource, null>,
    latencyMs: number,
    at = Date.now(),
  ): void {
    const target = kind === 'extract' ? this.extract : this.embed;
    target.state = 'success';
    target.lastSource = source;
    target.lastAttemptAt = at;
    target.lastSuccessAt = at;
    target.lastLatencyMs = latencyMs;
    target.lastError = null;
    target.consecutiveFailures = 0;
  }

  recordFailure(
    kind: 'extract' | 'embed',
    source: Exclude<MemoryStatusSource, null>,
    error: unknown,
    latencyMs: number | null = null,
    at = Date.now(),
  ): void {
    const target = kind === 'extract' ? this.extract : this.embed;
    target.state = 'failed';
    target.lastSource = source;
    target.lastAttemptAt = at;
    target.lastFailureAt = at;
    target.lastLatencyMs = latencyMs;
    target.lastError = toErrorSummary(error);
    target.consecutiveFailures += 1;
  }

  recordArchive(at = Date.now()): void {
    this.lastArchiveAt = at;
  }

  async getSnapshot(): Promise<MemoryV2StatusSnapshot> {
    const jobs = await this.store.getJobSummary();
    return {
      available: true,
      enabled: this.runtime.enabled,
      extractConfigured: isExtractRuntimeConfigured(this.runtime.extract),
      embedConfigured: isEmbedRuntimeConfigured(this.runtime.embed),
      extractModel: this.runtime.extract.model,
      embedBaseUrl: this.runtime.embed.baseUrl,
      embedModel: this.runtime.embed.model,
      jobs,
      lastArchiveAt: this.lastArchiveAt,
      extract: toOperationSnapshot(this.extract, isExtractRuntimeConfigured(this.runtime.extract)),
      embed: toOperationSnapshot(this.embed, isEmbedRuntimeConfigured(this.runtime.embed)),
    };
  }

  async probeEmbedding(): Promise<MemoryV2ProbeResult> {
    const checkedAt = Date.now();
    if (!this.runtime.enabled) {
      return {
        target: 'embedding',
        ok: false,
        checkedAt,
        latencyMs: null,
        error: 'memory-v2 disabled',
        snapshot: await this.getSnapshot(),
      };
    }
    if (!isEmbedRuntimeConfigured(this.runtime.embed)) {
      return {
        target: 'embedding',
        ok: false,
        checkedAt,
        latencyMs: null,
        error: 'embedding runtime is not configured',
        snapshot: await this.getSnapshot(),
      };
    }

    this.recordAttempt('embed', 'probe', checkedAt);
    const startedAt = Date.now();
    try {
      await this.embedProbe();
      const latencyMs = Math.max(0, Date.now() - startedAt);
      this.recordSuccess('embed', 'probe', latencyMs, Date.now());
      return {
        target: 'embedding',
        ok: true,
        checkedAt: Date.now(),
        latencyMs,
        error: null,
        snapshot: await this.getSnapshot(),
      };
    } catch (error) {
      const latencyMs = Math.max(0, Date.now() - startedAt);
      this.recordFailure('embed', 'probe', error, latencyMs, Date.now());
      return {
        target: 'embedding',
        ok: false,
        checkedAt: Date.now(),
        latencyMs,
        error: toErrorSummary(error),
        snapshot: await this.getSnapshot(),
      };
    }
  }
}
