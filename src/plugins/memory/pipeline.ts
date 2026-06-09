import { randomUUID } from 'node:crypto';
import { Logger } from 'koishi';
import type { MemoryJobV3Record, MemoryJobV3Type } from '../../types/memory-v3.js';
import type { MemoryRuntimeConfig } from './config.js';
import { runDeterministicPrivacyGuard } from './gates.js';
import { embedTexts, isEmbedRuntimeConfigured } from './providers/embedding-client.js';
import { extractMemoryCandidates, isMemoryProviderConfigured } from './providers/router.js';
import type { MemoryV3StatusService } from './status.js';
import type {
  ConsolidateJobPayload,
  EmbedJobPayload,
  ExtractJobPayload,
  MemoryV3Store,
  PrivacyReviewJobPayload,
} from './store.js';

const logger = new Logger('memory-v3');

export async function processExtractJob(
  store: MemoryV3Store,
  runtime: MemoryRuntimeConfig,
  status: MemoryV3StatusService,
  job: MemoryJobV3Record,
): Promise<void> {
  const payload = store.parseJobPayload<ExtractJobPayload>(job);
  if (!payload?.address?.conversationId) {
    await store.completeJob(job);
    return;
  }
  if (!isMemoryProviderConfigured(runtime.extract)) {
    await store.audit({
      userKey: payload.address.userKey,
      contextKey: payload.address.contextKey,
      eventType: 'extract_skipped',
      turnId: payload.address.conversationId,
      detail: { reason: 'provider_unconfigured' },
    });
    await store.completeJob(job);
    return;
  }

  const turns = await store.filterTombstonedTurns(
    payload.address.userKey,
    await store.readConversationWindow(payload.address.conversationId, payload.maxMessages),
  );
  if (turns.length < 2) {
    await store.completeJob(job);
    return;
  }

  const output = await extractMemoryCandidates({
    address: payload.address,
    turns,
    providerProfile: runtime.extract,
    maxFacts: runtime.maxFacts,
    maxEpisodes: runtime.maxEpisodes,
  });
  status.recordRoute(output.route, output.ok, output.error);
  if (!output.ok) {
    throw new Error(output.error ?? 'memory_extract_failed');
  }
  if (!output.candidates.length) {
    await store.completeJob(job);
    return;
  }

  const batchId = randomUUID();
  await store.writeCandidateBatch({
    address: payload.address,
    batchId,
    candidates: output.candidates,
    messageIds: turns.map((turn) => turn.id),
    providerRoute: output.route,
    rawTextHash: output.rawTextHash,
  });
  await store.queueJob('privacy_review', { batchId, address: payload.address });
  await store.completeJob(job);
}

export async function processPrivacyReviewJob(
  store: MemoryV3Store,
  job: MemoryJobV3Record,
): Promise<void> {
  const payload = store.parseJobPayload<PrivacyReviewJobPayload>(job);
  if (!payload?.batchId || !payload.address) {
    await store.completeJob(job);
    return;
  }
  const rows = await store.listBatchCandidates(payload.batchId);
  for (const row of rows) {
    if (row.reviewStatus !== 'pending') continue;
    const candidate = JSON.parse(row.payload);
    const decision = runDeterministicPrivacyGuard(candidate, payload.address);
    await store.applyPrivacyDecision(row, decision);
    if (decision.status === 'approved') {
      await store.queueJob('consolidate', { candidateId: row.id, address: payload.address });
    }
  }
  await store.completeJob(job);
}

export async function processConsolidateJob(
  store: MemoryV3Store,
  job: MemoryJobV3Record,
): Promise<void> {
  const payload = store.parseJobPayload<ConsolidateJobPayload>(job);
  if (!payload?.candidateId || !payload.address) {
    await store.completeJob(job);
    return;
  }
  const row = await store.getCandidateById(payload.candidateId);
  if (!row?.id) {
    await store.completeJob(job);
    return;
  }
  await store.consolidateCandidate(row, payload.address);
  await store.completeJob(job);
}

export async function processEmbedJobs(
  store: MemoryV3Store,
  runtime: MemoryRuntimeConfig,
  jobs: MemoryJobV3Record[],
): Promise<void> {
  if (!jobs.length) return;
  if (!isEmbedRuntimeConfigured(runtime.embed)) {
    for (const job of jobs) await store.completeJob(job);
    return;
  }

  const resolved: Array<{ job: MemoryJobV3Record; payload: EmbedJobPayload; text: string }> = [];
  for (const job of jobs) {
    const item = await store.resolveEmbedJob(job);
    if (!item || !item.text.trim()) {
      await store.completeJob(job);
      continue;
    }
    resolved.push({ job, payload: item.payload, text: item.text });
  }
  if (!resolved.length) return;

  const vectors = await embedTexts(runtime.embed, resolved.map((item) => item.text));
  for (const [index, item] of resolved.entries()) {
    const vector = vectors[index];
    if (!vector) {
      throw new Error('empty_embedding_vector');
    }
    await store.applyEmbedding(item.payload, runtime.embed.model, vector);
    await store.completeJob(item.job);
  }
}

export async function processMaintenanceJob(
  store: MemoryV3Store,
  runtime: MemoryRuntimeConfig,
  status: MemoryV3StatusService,
  job?: MemoryJobV3Record,
): Promise<void> {
  await store.requeueStaleProcessingJobs(runtime.jobLockTimeoutMs);
  await store.archiveExpired();
  await store.archiveLowRiskOldEpisodes(runtime.archiveDays);
  status.recordMaintenance(Date.now());
  if (job) await store.completeJob(job);
}

export async function runMemoryJobTick(
  store: MemoryV3Store,
  runtime: MemoryRuntimeConfig,
  status: MemoryV3StatusService,
): Promise<void> {
  const now = Date.now();
  const jobTypes: MemoryJobV3Type[] = ['extract', 'privacy_review', 'consolidate', 'embed', 'reembed', 'maintenance'];
  for (const jobType of jobTypes) {
    const jobs = await store.listDueJobs(jobType, now);
    if (!jobs.length) continue;
    if (jobType === 'embed' || jobType === 'reembed') {
      const batch = jobs.slice(0, runtime.embedBatchSize);
      for (const job of batch) await store.markJobProcessing(job);
      const startedAt = Date.now();
      status.recordAttempt('embed', 'runtime', startedAt);
      try {
        await processEmbedJobs(store, runtime, batch);
        status.recordSuccess('embed', 'runtime', Math.max(0, Date.now() - startedAt), Date.now());
      } catch (error) {
        status.recordFailure('embed', 'runtime', error, Math.max(0, Date.now() - startedAt), Date.now());
        for (const job of batch) await store.retryJob(job, error, 60_000, runtime.maxJobRetries);
      }
      continue;
    }

    const job = jobs[0];
    await store.markJobProcessing(job);
    const startedAt = Date.now();
    try {
      if (jobType === 'extract') {
        status.recordAttempt('extract', 'runtime', startedAt);
        await processExtractJob(store, runtime, status, job);
        status.recordSuccess('extract', 'runtime', Math.max(0, Date.now() - startedAt), Date.now());
      } else if (jobType === 'privacy_review') {
        await processPrivacyReviewJob(store, job);
      } else if (jobType === 'consolidate') {
        await processConsolidateJob(store, job);
      } else if (jobType === 'maintenance') {
        await processMaintenanceJob(store, runtime, status, job);
      }
    } catch (error) {
      if (jobType === 'extract') {
        status.recordFailure('extract', 'runtime', error, Math.max(0, Date.now() - startedAt), Date.now());
      }
      logger.warn('memory %s job failed: %s', jobType, error instanceof Error ? error.message : String(error));
      await store.retryJob(job, error, 60_000, runtime.maxJobRetries);
    }
  }
}
