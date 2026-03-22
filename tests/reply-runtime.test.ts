import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ReplyRuntime } from '../src/plugins/reply/runtime/index.js';

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
      runId: 'run-1',
      strandKey: 'strand-1',
      conversationId: 'conv-1',
      room: { conversationId: 'conv-1' },
      input: { text: '第一条', displayName: '用户', userId: 'u1', isDirect: true },
      mode: 'queue',
    });
    expect(first.action).toBe('continue');

    let resolved = false;
    const nextRunPromise = runtime.prepareRun({
      runId: 'run-2',
      strandKey: 'strand-1',
      conversationId: 'conv-1',
      room: { conversationId: 'conv-1' },
      input: { text: '第二条', displayName: '用户', userId: 'u1', isDirect: true },
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

  it('aggregates same-user inputs before model output during interrupt collection', async () => {
    const runtime = new ReplyRuntime({
      stopChat: vi.fn(async () => undefined),
      collectWindowMs: 50,
    });

    const first = await runtime.prepareRun({
      runId: 'run-1',
      strandKey: 'strand-1',
      conversationId: 'conv-1',
      room: { conversationId: 'conv-1' },
      input: { text: 'A', displayName: '用户', userId: 'u1', isDirect: true },
      mode: 'interrupt',
    });
    expect(first.action).toBe('continue');

    const secondPromise = runtime.prepareRun({
      runId: 'run-2',
      strandKey: 'strand-1',
      conversationId: 'conv-1',
      room: { conversationId: 'conv-1' },
      input: { text: 'A补充', displayName: '用户', userId: 'u1', isDirect: true },
      mode: 'interrupt',
    });
    const thirdPromise = runtime.prepareRun({
      runId: 'run-3',
      strandKey: 'strand-1',
      conversationId: 'conv-1',
      room: { conversationId: 'conv-1' },
      input: { text: 'B', displayName: '用户', userId: 'u1', isDirect: true },
      mode: 'interrupt',
    });

    await vi.advanceTimersByTimeAsync(60);

    await expect(secondPromise).resolves.toEqual({ action: 'stop' });
    await expect(thirdPromise).resolves.toMatchObject({
      action: 'continue',
      inputText: 'A\nA补充\nB',
      continuationContext: undefined,
    });
  });

  it('builds send interruption context from committed units, pending units, and supplemental messages', async () => {
    const stopChat = vi.fn(async () => undefined);
    const runtime = new ReplyRuntime({
      stopChat,
      collectWindowMs: 50,
    });

    await runtime.prepareRun({
      runId: 'run-1',
      strandKey: 'strand-1',
      conversationId: 'conv-1',
      room: { conversationId: 'conv-1' },
      input: { text: '第一条', displayName: '甲', userId: 'u1', isDirect: false },
      mode: 'interrupt',
    });
    runtime.setPlannedUnitHistory('run-1', ['第一句', '第二句', '第三句']);
    const sendSignal = runtime.beginSending('run-1');
    runtime.recordCommittedUnit('run-1', '第一句');

    const secondPromise = runtime.prepareRun({
      runId: 'run-2',
      strandKey: 'strand-1',
      conversationId: 'conv-1',
      room: { conversationId: 'conv-1' },
      input: { text: '补充一', displayName: '甲', userId: 'u1', isDirect: false },
      mode: 'interrupt',
    });
    const thirdPromise = runtime.prepareRun({
      runId: 'run-3',
      strandKey: 'strand-1',
      conversationId: 'conv-1',
      room: { conversationId: 'conv-1' },
      input: { text: '最新问题', displayName: '乙', userId: 'u2', isDirect: false },
      mode: 'interrupt',
    });

    await vi.advanceTimersByTimeAsync(60);

    expect(sendSignal?.aborted).toBe(true);
    expect(stopChat).not.toHaveBeenCalled();
    await expect(secondPromise).resolves.toEqual({ action: 'stop' });
    await expect(thirdPromise).resolves.toMatchObject({
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
