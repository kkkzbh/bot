import type { Logger } from 'koishi';

const MAX_TIMER_DELAY_MS = 0x7fffffff;

export interface AffinityRandomPlanSchedulerService {
  runDueRandomPlans(now?: number): Promise<void>;
  getNextPendingRandomPlanAt(now?: number): Promise<number | null>;
}

export interface AffinityRandomPlanSchedulerOptions {
  safetyIntervalMs: number;
  now?: () => number;
  logger?: Pick<Logger, 'warn'>;
}

export class AffinityRandomPlanScheduler {
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private safetyTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private queued = false;
  private disposed = false;
  private readonly now: () => number;

  constructor(
    private readonly service: AffinityRandomPlanSchedulerService,
    private readonly options: AffinityRandomPlanSchedulerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.disposed) return;
    if (!this.safetyTimer) {
      this.safetyTimer = setInterval(() => this.refreshSoon('safety'), this.options.safetyIntervalMs);
    }
    this.refreshSoon('start');
  }

  refreshSoon(reason = 'manual'): void {
    void this.refresh(reason);
  }

  dispose(): void {
    this.disposed = true;
    this.clearWakeTimer();
    if (this.safetyTimer) {
      clearInterval(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  private async refresh(reason: string): Promise<void> {
    if (this.disposed) return;
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    this.clearWakeTimer();
    try {
      await this.service.runDueRandomPlans(this.now());
      const nextAt = await this.service.getNextPendingRandomPlanAt(this.now());
      if (!this.disposed && nextAt != null) {
        this.arm(nextAt);
      }
    } catch (error) {
      this.options.logger?.warn?.(
        'affinity random scheduler refresh failed: reason=%s error=%s',
        reason,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.running = false;
      if (this.queued && !this.disposed) {
        this.queued = false;
        this.refreshSoon('queued');
      }
    }
  }

  private arm(scheduledAt: number): void {
    const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, scheduledAt - this.now()));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.refreshSoon('timer');
    }, delay);
  }
}
