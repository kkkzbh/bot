import type {
  MemoryOutputProtocolId,
  MemoryStatusSource,
  MemoryV3OperationSnapshot,
  MemoryV3ProbeResult,
  MemoryV3ProviderRouteStats,
  MemoryV3QueueSummary,
  MemoryV3StatusServiceLike,
  MemoryV3StatusSnapshot,
} from '../../types/memory-v3.js';
import { createUnavailableMemoryV3StatusSnapshot } from '../shared/memory-v3-status.js';
import type { MemoryEmbedRuntime } from './providers/embedding-client.js';
import { isEmbedRuntimeConfigured } from './providers/embedding-client.js';
import type { MemoryProviderProfile } from './providers/router.js';
import { isMemoryProviderConfigured } from './providers/router.js';

export { createUnavailableMemoryV3StatusSnapshot };

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

export interface MemoryV3StatusRuntimeLike {
  enabled: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
  extract: MemoryProviderProfile;
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

function toOperationSnapshot(draft: OperationStatusDraft, configured: boolean): MemoryV3OperationSnapshot {
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

export class MemoryV3StatusService implements MemoryV3StatusServiceLike {
  private readonly extract = createEmptyOperationStatus();
  private readonly embed = createEmptyOperationStatus();
  private lastMaintenanceAt: number | null = null;
  private readonly routeStats = new Map<MemoryOutputProtocolId, MemoryV3ProviderRouteStats>();

  constructor(
    private readonly runtime: MemoryV3StatusRuntimeLike,
    private readonly store: { getJobSummary: () => Promise<MemoryV3QueueSummary> },
    private readonly embedProbe: () => Promise<void>,
    private readonly extractionProbe?: () => Promise<void>,
  ) {}

  recordAttempt(kind: 'extract' | 'embed', source: Exclude<MemoryStatusSource, null>, at = Date.now()): void {
    const target = kind === 'extract' ? this.extract : this.embed;
    target.lastSource = source;
    target.lastAttemptAt = at;
  }

  recordSuccess(kind: 'extract' | 'embed', source: Exclude<MemoryStatusSource, null>, latencyMs: number, at = Date.now()): void {
    const target = kind === 'extract' ? this.extract : this.embed;
    target.state = 'success';
    target.lastSource = source;
    target.lastAttemptAt = at;
    target.lastSuccessAt = at;
    target.lastLatencyMs = latencyMs;
    target.lastError = null;
    target.consecutiveFailures = 0;
  }

  recordFailure(kind: 'extract' | 'embed', source: Exclude<MemoryStatusSource, null>, error: unknown, latencyMs: number | null = null, at = Date.now()): void {
    const target = kind === 'extract' ? this.extract : this.embed;
    target.state = 'failed';
    target.lastSource = source;
    target.lastAttemptAt = at;
    target.lastFailureAt = at;
    target.lastLatencyMs = latencyMs;
    target.lastError = toErrorSummary(error);
    target.consecutiveFailures += 1;
  }

  recordRoute(route: MemoryOutputProtocolId, ok: boolean, error: string | null = null): void {
    const current = this.routeStats.get(route) ?? { route, success: 0, failure: 0, lastError: null };
    if (ok) {
      current.success += 1;
      current.lastError = null;
    } else {
      current.failure += 1;
      current.lastError = error;
    }
    this.routeStats.set(route, current);
  }

  recordMaintenance(at = Date.now()): void {
    this.lastMaintenanceAt = at;
  }

  async getSnapshot(): Promise<MemoryV3StatusSnapshot> {
    const jobs = await this.store.getJobSummary();
    return {
      available: true,
      enabled: this.runtime.enabled,
      readEnabled: this.runtime.readEnabled,
      writeEnabled: this.runtime.writeEnabled,
      extractConfigured: isMemoryProviderConfigured(this.runtime.extract),
      embedConfigured: isEmbedRuntimeConfigured(this.runtime.embed),
      extractModel: this.runtime.extract.model,
      embedBaseUrl: this.runtime.embed.baseUrl,
      embedModel: this.runtime.embed.model,
      jobs,
      providerRoutes: [...this.routeStats.values()],
      lastMaintenanceAt: this.lastMaintenanceAt,
      extract: toOperationSnapshot(this.extract, isMemoryProviderConfigured(this.runtime.extract)),
      embed: toOperationSnapshot(this.embed, isEmbedRuntimeConfigured(this.runtime.embed)),
    };
  }

  async probeEmbedding(): Promise<MemoryV3ProbeResult> {
    return this.runProbe('embedding', 'embed', this.embedProbe, isEmbedRuntimeConfigured(this.runtime.embed));
  }

  async probeExtraction(): Promise<MemoryV3ProbeResult> {
    return this.runProbe(
      'extraction',
      'extract',
      this.extractionProbe ?? (async () => {}),
      isMemoryProviderConfigured(this.runtime.extract),
    );
  }

  async probeProvider(): Promise<MemoryV3ProbeResult> {
    return this.probeExtraction();
  }

  private async runProbe(
    target: MemoryV3ProbeResult['target'],
    kind: 'extract' | 'embed',
    probe: () => Promise<void>,
    configured: boolean,
  ): Promise<MemoryV3ProbeResult> {
    const checkedAt = Date.now();
    if (!this.runtime.enabled) {
      return {
        target,
        ok: false,
        checkedAt,
        latencyMs: null,
        error: 'memory-v3 disabled',
        snapshot: await this.getSnapshot(),
      };
    }
    if (!configured) {
      return {
        target,
        ok: false,
        checkedAt,
        latencyMs: null,
        error: `${target} runtime is not configured`,
        snapshot: await this.getSnapshot(),
      };
    }

    this.recordAttempt(kind, 'probe', checkedAt);
    const startedAt = Date.now();
    try {
      await probe();
      const latencyMs = Math.max(0, Date.now() - startedAt);
      this.recordSuccess(kind, 'probe', latencyMs, Date.now());
      return {
        target,
        ok: true,
        checkedAt: Date.now(),
        latencyMs,
        error: null,
        snapshot: await this.getSnapshot(),
      };
    } catch (error) {
      const latencyMs = Math.max(0, Date.now() - startedAt);
      this.recordFailure(kind, 'probe', error, latencyMs, Date.now());
      return {
        target,
        ok: false,
        checkedAt: Date.now(),
        latencyMs,
        error: toErrorSummary(error),
        snapshot: await this.getSnapshot(),
      };
    }
  }
}
