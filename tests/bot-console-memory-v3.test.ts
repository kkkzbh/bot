import { describe, expect, it } from 'vitest';
import { buildMemoryState } from '../src/plugins/bot-console/memory.js';
import { createUnavailableMemoryV3StatusSnapshot } from '../src/plugins/shared/memory-v3-status.js';

describe('bot-console memory-v3 state', () => {
  it('builds user-centered memory console state from v3 tables', async () => {
    const database = {
      get: async (table: string) => {
        if (table === 'memory_user') {
          return [{ id: 1, userKey: 'onebot:user:10001', platform: 'onebot', userId: '10001', firstSeenAt: 1, lastSeenAt: 10, readEnabled: 1, writeEnabled: 1 }];
        }
        if (table === 'memory_context') return [];
        if (table === 'memory_fact_v3') {
          return [{
            id: 2,
            userKey: 'onebot:user:10001',
            sourceContextKey: 'onebot:bot:20001:dm:10001',
            kind: 'preference',
            topicKey: 'answer-style',
            content: '用户喜欢简洁回答。',
            keywords: '["回答"]',
            importance: 0.8,
            confidence: 0.9,
            sensitivity: 'low',
            visibility: 'global',
            firstSeenAt: 1,
            lastSeenAt: 10,
            lastAccessedAt: null,
            embedding: null,
            archived: 0,
            conflictSetId: null,
          }];
        }
        if (table === 'memory_episode_v3') return [];
        if (table === 'memory_candidate_v3') {
          return [{
            id: 3,
            batchId: 'batch',
            candidateType: 'fact',
            userKey: 'onebot:user:10001',
            contextKey: 'onebot:bot:20001:group:g1',
            conversationId: 'conv',
            payload: '{"content":"候选"}',
            reviewStatus: 'pending_review',
            sensitivity: 'personal',
            suggestedVisibility: 'pending_review',
            finalVisibility: null,
            dropReason: null,
            providerRoute: 'plain_text_memory_v1',
            createdAt: 12,
          }];
        }
        if (table === 'memory_job_v3') {
          return [{ id: 4, jobType: 'extract', status: 'dead_letter', payload: '{}', retryCount: 5, nextRunAt: 1, lockedAt: null, createdAt: 1, updatedAt: 2, lastError: 'boom' }];
        }
        if (table === 'memory_audit_event') return [];
        if (table === 'memory_provenance') return [{ id: 1 }];
        return [];
      },
    };

    const state = await buildMemoryState(database, createUnavailableMemoryV3StatusSnapshot({ available: true }));
    expect(state.summary).toMatchObject({
      userCount: 1,
      factCount: 1,
      pendingReviewCount: 1,
      deadLetterJobs: 1,
    });
    expect(state.users[0]).toMatchObject({
      userKey: 'onebot:user:10001',
      factCount: 1,
      pendingReviewCount: 1,
    });
    expect(state.recentFailures).toEqual(['extract: boom']);
  });
});
