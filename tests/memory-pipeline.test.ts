import { describe, expect, it, vi } from 'vitest';
import type { MemoryJobRecord } from '../src/types/memory.js';
import type { MemoryRuntimeConfig } from '../src/plugins/memory/config.js';
import { runMemoryJobTick } from '../src/plugins/memory/pipeline.js';
import type { ExtractJobPayload } from '../src/plugins/memory/store.js';

vi.mock('koishi', () => ({
  Logger: class {
    warn(): void {}
  },
}));

describe('memory pipeline', () => {
  it('dead-letters non-retryable extraction provider failures', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ code: 30001, message: 'Sorry, your account balance is insufficient' }),
      { status: 403, statusText: 'Forbidden' },
    );

    const address = {
      userKey: 'onebot:10001',
      contextKey: 'onebot:group:20001',
      channelType: 'group' as const,
      platform: 'onebot',
      botSelfId: 'bot',
      userId: '10001',
      groupId: '20001',
      conversationId: 'conv-1',
      observedAt: 1,
    };
    const payload: ExtractJobPayload = {
      address,
      ownerUserKey: address.userKey,
      targetSpeakerId: address.userId,
      targetSpeakerName: 'Alice',
      contextKey: address.contextKey,
      conversationId: address.conversationId,
      rangeStartAfterMessageId: null,
      latestAnchorMessageId: 'm1',
      maxMessages: 4,
    };
    const job: MemoryJobRecord = {
      id: 1,
      jobKey: 'extract:onebot:10001',
      jobType: 'extract',
      status: 'pending',
      payload: JSON.stringify(payload),
      retryCount: 0,
      nextRunAt: 1,
      lockedAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const deadLetterJob = vi.fn(async (_job: MemoryJobRecord, _error: unknown) => {});
    const retryJob = vi.fn(async (_job: MemoryJobRecord, _error: unknown) => {});
    const store = {
      listDueJobs: vi.fn(async (jobType: string) => (jobType === 'extract' ? [job] : [])),
      markJobProcessing: vi.fn(async () => {}),
      parseJobPayload: vi.fn(() => payload),
      readConversationWindow: vi.fn(async () => [{
        id: 'm1',
        role: 'human' as const,
        text: 'hello',
        speakerId: '10001',
        speakerName: 'Alice',
        ownerUserKey: address.userKey,
        isTarget: true,
        attributionSource: 'direct_session' as const,
      }]),
      filterTombstonedTurns: vi.fn(async (_ownerUserKey: string, turns: unknown[]) => turns),
      updateExtractCursor: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      retryJob,
      deadLetterJob,
    };
    const runtime: MemoryRuntimeConfig = {
      enabled: true,
      readEnabled: true,
      writeEnabled: true,
      extract: {
        routeId: 'memory-extract',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        timeoutMs: 1000,
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'chat_reply_v1',
      },
      embed: {
        baseUrl: '',
        apiKey: '',
        model: '',
        timeoutMs: 1000,
      },
      queryTopK: 8,
      promptBudgetTokens: 1200,
      embedBatchSize: 16,
      extractIdleMs: 90000,
      extractMessageBatch: 12,
      archiveDays: 90,
      maxJobRetries: 5,
      jobLockTimeoutMs: 300000,
      maxFacts: 8,
      maxEpisodes: 8,
    };
    const status = {
      recordRoute: vi.fn(),
      recordAttempt: vi.fn(),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      recordMaintenance: vi.fn(),
    };

    try {
      await runMemoryJobTick(store as any, runtime, status as any);

      expect(store.deadLetterJob).toHaveBeenCalledTimes(1);
      const deadLetterError = store.deadLetterJob.mock.calls[0]?.[1];
      expect(deadLetterError).toBeInstanceOf(Error);
      expect((deadLetterError as Error).message).toBe(
        'extract_http_403: Sorry, your account balance is insufficient (code 30001)',
      );
      expect(store.retryJob).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
