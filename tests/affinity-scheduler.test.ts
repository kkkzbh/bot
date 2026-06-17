import { afterEach, describe, expect, it, vi } from 'vitest';
import { AffinityRandomPlanScheduler } from '../src/plugins/affinity/scheduler.js';

vi.mock('koishi', () => ({
  Logger: class {
    warn(): void {}
  },
}));

const NOW = Date.UTC(2026, 5, 17, 1, 0, 0);

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('affinity random plan scheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms the earliest pending plan, fires due plans, re-arms, and clears timers on dispose', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let nextPendingAt: number | null = NOW + 5000;
    const runDueRandomPlans = vi.fn(async () => {
      const calls = runDueRandomPlans.mock.calls.length;
      if (calls === 2) nextPendingAt = NOW + 12_000;
      if (calls === 3) nextPendingAt = null;
    });
    const getNextPendingRandomPlanAt = vi.fn(async () => nextPendingAt);
    const warn = vi.fn();
    const scheduler = new AffinityRandomPlanScheduler(
      {
        runDueRandomPlans,
        getNextPendingRandomPlanAt,
      },
      {
        safetyIntervalMs: 60_000,
        now: () => Date.now(),
        logger: { warn },
      },
    );

    scheduler.start();
    await flushPromises();

    expect(runDueRandomPlans).toHaveBeenCalledTimes(1);
    expect(getNextPendingRandomPlanAt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(4999);
    expect(runDueRandomPlans).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(runDueRandomPlans).toHaveBeenCalledTimes(2);
    expect(getNextPendingRandomPlanAt).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(6999);
    expect(runDueRandomPlans).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(runDueRandomPlans).toHaveBeenCalledTimes(3);
    expect(getNextPendingRandomPlanAt).toHaveBeenCalledTimes(3);

    scheduler.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDueRandomPlans).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });
});
