import { describe, expect, it } from 'vitest';
import { retrieveMemoryForContext } from '../src/plugins/memory/recall.js';
import { MemoryStore } from '../src/plugins/memory/store.js';
import type { MemoryAddress, MemoryEpisodeRecord, MemoryFactRecord } from '../src/types/memory.js';

class MemoryDbMock {
  tables: Record<string, any[]> = {
    memory_fact: [],
    memory_episode: [],
    memory_audit_event: [],
  };

  async get(table: string, query: Record<string, unknown>): Promise<any[]> {
    const rows = this.tables[table] ?? [];
    return rows.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value));
  }

  async set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<void> {
    for (const row of await this.get(table, query)) Object.assign(row, data);
  }

  async create(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rows = this.tables[table] ?? (this.tables[table] = []);
    const created = { id: rows.length + 1, ...row };
    rows.push(created);
    return created;
  }

  async remove(table: string, query: Record<string, unknown>): Promise<void> {
    this.tables[table] = (this.tables[table] ?? []).filter((row) => !Object.entries(query).every(([key, value]) => row[key] === value));
  }
}

const groupA: MemoryAddress = {
  userKey: 'onebot:user:10001',
  contextKey: 'onebot:bot:20001:group:g-a',
  channelType: 'group',
  platform: 'onebot',
  botSelfId: '20001',
  userId: '10001',
  groupId: 'g-a',
  channelId: 'g-a',
  rawContextId: 'g-a',
  conversationId: 'conv-a',
  observedAt: 1,
};

const groupAForB: MemoryAddress = {
  ...groupA,
  userKey: 'onebot:user:10002',
  userId: '10002',
};

function fact(overrides: Partial<MemoryFactRecord>): MemoryFactRecord {
  return {
    id: 1,
    ownerUserKey: groupA.userKey,
    kind: 'preference',
    topicKey: 'answer-style',
    content: '用户喜欢简洁直接的技术回答',
    keywords: '["技术","回答"]',
    importance: 0.9,
    confidence: 0.9,
    sensitivity: 'low',
    visibility: 'global',
    scopeType: 'owner_all_contexts',
    scopeKey: null,
    memoryKey: null,
    sourceKind: 'group',
    sourceContextKey: groupA.contextKey,
    targetSpeakerId: '10001',
    targetSpeakerName: null,
    evidenceMessageIds: '["m-1"]',
    evidenceSpeakerIds: '["10001"]',
    attributionStatus: 'verified',
    allowedContextKeys: null,
    deniedContextKeys: null,
    applicability: null,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
    invalidatedAt: null,
    retrievalText: null,
    lastUsedReason: null,
    firstSeenAt: 1,
    lastSeenAt: 10,
    lastAccessedAt: null,
    embeddingModel: null,
    embedding: null,
    version: 1,
    archived: 0,
    supersedesId: null,
    conflictSetId: null,
    ...overrides,
  };
}

function episode(overrides: Partial<MemoryEpisodeRecord>): MemoryEpisodeRecord {
  return {
    id: 1,
    ownerUserKey: groupA.userKey,
    title: 'A 群偏好',
    summary: '用户在 A 群讨论 memory',
    keywords: '["memory"]',
    importance: 0.9,
    confidence: 0.9,
    sensitivity: 'low',
    visibility: 'source_context_only',
    scopeType: 'source_context_only',
    scopeKey: groupA.contextKey,
    memoryKey: null,
    sourceKind: 'group',
    sourceContextKey: groupA.contextKey,
    targetSpeakerId: '10001',
    targetSpeakerName: null,
    evidenceMessageIds: '["m-1"]',
    evidenceSpeakerIds: '["10001"]',
    attributionStatus: 'verified',
    allowedContextKeys: null,
    deniedContextKeys: null,
    applicability: null,
    periodStart: null,
    periodEnd: null,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
    invalidatedAt: null,
    retrievalText: null,
    lastUsedReason: null,
    firstSeenAt: 1,
    lastSeenAt: 10,
    lastAccessedAt: null,
    embeddingModel: null,
    embedding: null,
    version: 1,
    archived: 0,
    supersedesId: null,
    conflictSetId: null,
    ...overrides,
  };
}

describe('memory recall', () => {
  it('recalls global facts and same-context episodes but not private or other-context memory in groups', async () => {
    const db = new MemoryDbMock();
    db.tables.memory_fact.push(
      fact({ id: 1, visibility: 'global', content: '用户喜欢简洁直接的技术回答' }),
      fact({ id: 2, visibility: 'private_only', content: '用户的私密计划' }),
    );
    db.tables.memory_episode.push(
      episode({ id: 1, sourceContextKey: groupA.contextKey, summary: '用户在 A 群讨论 memory' }),
      episode({ id: 2, sourceContextKey: 'onebot:bot:20001:group:g-b', summary: '用户在 B 群说了一个梗' }),
    );

    const result = await retrieveMemoryForContext(new MemoryStore(db as any), groupA, '你还记得 memory 吗', {
      topK: 8,
      promptBudgetTokens: 1200,
      now: 100,
    });

    expect(result.prompt).toContain('简洁直接');
    expect(result.prompt).toContain('A 群讨论');
    expect(result.prompt).not.toContain('私密计划');
    expect(result.prompt).not.toContain('B 群');
    expect(db.tables.memory_audit_event).toEqual([
      expect.objectContaining({ eventType: 'recall_selected', userKey: groupA.userKey }),
    ]);
  });

  it('isolates recalled group memory by current speaker owner key', async () => {
    const db = new MemoryDbMock();
    db.tables.memory_fact.push(
      fact({ id: 1, ownerUserKey: groupA.userKey, content: 'A 喜欢简洁直接的技术回答' }),
      fact({ id: 2, ownerUserKey: groupAForB.userKey, content: 'B 喜欢铺开解释技术细节' }),
    );

    const resultA = await retrieveMemoryForContext(new MemoryStore(db as any), groupA, '怎么回答', {
      topK: 8,
      promptBudgetTokens: 1200,
      now: 100,
    });
    const resultB = await retrieveMemoryForContext(new MemoryStore(db as any), groupAForB, '怎么回答', {
      topK: 8,
      promptBudgetTokens: 1200,
      now: 100,
    });

    expect(resultA.prompt).toContain('A 喜欢简洁直接');
    expect(resultA.prompt).not.toContain('B 喜欢铺开解释');
    expect(resultB.prompt).toContain('B 喜欢铺开解释');
    expect(resultB.prompt).not.toContain('A 喜欢简洁直接');
  });

  it('fails closed when denied-context memory has a corrupted context list', async () => {
    const db = new MemoryDbMock();
    db.tables.memory_fact.push(
      fact({
        id: 9,
        content: '这条 corrupted deny list 记忆不应该进入上下文',
        visibility: 'denied_contexts',
        scopeType: 'denied_contexts',
        deniedContextKeys: '{bad json',
      }),
    );

    const result = await retrieveMemoryForContext(new MemoryStore(db as any), groupA, 'corrupted deny list', {
      topK: 8,
      promptBudgetTokens: 1200,
      now: 100,
    });

    expect(result.prompt ?? '').not.toContain('corrupted deny list');
    expect(result.facts).toEqual([]);
  });
});
