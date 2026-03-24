import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplyRuntime } from '../src/plugins/reply/runtime/index.js';

function createArgs(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    queueKey: 'queue:group-1',
    actorKey: 'queue:group-1:user:u1',
    conversationId: 'conv-1',
    room: { conversationId: 'conv-1' },
    input: { text: '第一条', displayName: '用户', userId: 'u1', isDirect: true },
    ...overrides,
  };
}

describe('ReplyRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues the next run until the previous run finishes in queue mode', async () => {
    const runtime = new ReplyRuntime({
      stopChat: vi.fn(async () => undefined),
    });

    const first = await runtime.prepareRun({
      ...createArgs(),
      mode: 'queue',
    });
    expect(first.action).toBe('continue');

    let resolved = false;
    const nextRunPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        input: { text: '第二条', displayName: '用户', userId: 'u1', isDirect: true },
      }),
      mode: 'queue',
    }).then((result) => {
      resolved = true;
      return result;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    runtime.finishRun('run-1');
    const nextRun = await nextRunPromise;

    expect(nextRun.action).toBe('continue');
    expect(nextRun.run?.id).toBe('run-2');
    expect(runtime.isCurrentRun('run-2')).toBe(true);
  });

  it('queues a different group speaker instead of interrupting the current run', async () => {
    const stopChat = vi.fn(async () => undefined);
    const runtime = new ReplyRuntime({
      stopChat,
      collectWindowMs: 50,
    });

    const first = await runtime.prepareRun({
      ...createArgs({
        input: { text: 'A', displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });
    expect(first.action).toBe('continue');

    let secondResolved = false;
    const secondPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        actorKey: 'queue:group-1:user:u2',
        input: { text: 'B', displayName: '乙', userId: 'u2', isDirect: false },
      }),
      mode: 'interrupt',
    }).then((result) => {
      secondResolved = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();

    expect(stopChat).not.toHaveBeenCalled();
    expect(secondResolved).toBe(false);

    runtime.finishRun('run-1');
    await expect(secondPromise).resolves.toMatchObject({
      action: 'continue',
      inputText: 'B',
      continuationContext: undefined,
    });
  });

  it('requeues self-interruption to the group tail behind other queued speakers', async () => {
    const stopChat = vi.fn(async () => undefined);
    const runtime = new ReplyRuntime({
      stopChat,
      collectWindowMs: 50,
    });

    await runtime.prepareRun({
      ...createArgs({
        input: { text: 'A1', displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    const speakerBPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        actorKey: 'queue:group-1:user:u2',
        input: { text: 'B1', displayName: '乙', userId: 'u2', isDirect: false },
      }),
      mode: 'interrupt',
    });

    await vi.advanceTimersByTimeAsync(60);

    let selfRerunResolved = false;
    const selfRerunPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-3',
        input: { text: 'A2', displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    }).then((result) => {
      selfRerunResolved = true;
      return result;
    });

    const speakerB = await speakerBPromise;
    expect(speakerB).toMatchObject({
      action: 'continue',
      run: expect.objectContaining({ id: 'run-2' }),
      inputText: 'B1',
    });
    expect(stopChat).toHaveBeenCalledTimes(1);
    expect(runtime.isCurrentRun('run-1')).toBe(false);
    expect(selfRerunResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(60);
    runtime.finishRun('run-2');
    await expect(selfRerunPromise).resolves.toMatchObject({
      action: 'continue',
      run: expect.objectContaining({ id: 'run-3' }),
      inputText: 'A1\nA2',
      continuationContext: undefined,
    });
  });

  it('merges same-actor queued messages and only lets the latest carrier continue', async () => {
    const runtime = new ReplyRuntime({
      stopChat: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });

    await runtime.prepareRun({
      ...createArgs({
        input: { text: 'A1', displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    const speakerBPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        actorKey: 'queue:group-1:user:u2',
        input: { text: 'B1', displayName: '乙', userId: 'u2', isDirect: false },
      }),
      mode: 'interrupt',
    });

    await vi.advanceTimersByTimeAsync(60);

    const earlierSelfPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-3',
        input: { text: 'A2', displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    const latestSelfPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-4',
        input: { text: 'A3', displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    await speakerBPromise;
    await vi.advanceTimersByTimeAsync(60);

    runtime.finishRun('run-2');
    await expect(earlierSelfPromise).resolves.toEqual({ action: 'stop' });
    await expect(latestSelfPromise).resolves.toMatchObject({
      action: 'continue',
      inputText: 'A1\nA2\nA3',
      continuationContext: undefined,
    });
  });

  it('builds actor-only continuation context when a sent reply is interrupted and requeued', async () => {
    const stopChat = vi.fn(async () => undefined);
    const runtime = new ReplyRuntime({
      stopChat,
      collectWindowMs: 50,
    });

    await runtime.prepareRun({
      ...createArgs({
        input: { text: '第一条', displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });
    runtime.setPlannedUnitHistory('run-1', ['第一句', '第二句', '第三句']);
    const sendSignal = runtime.beginSending('run-1');
    runtime.recordCommittedUnit('run-1', '第一句');

    const speakerBPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-2',
        actorKey: 'queue:group-1:user:u2',
        input: { text: 'B1', displayName: '乙', userId: 'u2', isDirect: false },
      }),
      mode: 'interrupt',
    });

    const earlierSelfPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-3',
        input: { text: '补充一', displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    const latestSelfPromise = runtime.prepareRun({
      ...createArgs({
        runId: 'run-4',
        input: { text: '最新问题', displayName: '甲', userId: 'u1', isDirect: false },
      }),
      mode: 'interrupt',
    });

    await vi.advanceTimersByTimeAsync(60);

    expect(sendSignal?.aborted).toBe(true);
    expect(stopChat).not.toHaveBeenCalled();
    await expect(speakerBPromise).resolves.toMatchObject({
      action: 'continue',
      inputText: 'B1',
    });

    await vi.advanceTimersByTimeAsync(60);
    runtime.finishRun('run-2');

    await expect(earlierSelfPromise).resolves.toEqual({ action: 'stop' });
    await expect(latestSelfPromise).resolves.toMatchObject({
      action: 'continue',
      inputText: '最新问题',
      continuationContext: {
        alreadySentText: '第一句',
        pendingUnitTexts: ['第二句', '第三句'],
        supplementalMessages: ['[甲/u1] 补充一'],
      },
    });
  });
});
