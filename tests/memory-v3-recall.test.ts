import { describe, expect, it } from 'vitest';
import { retrieveMemoryForContext } from '../src/plugins/memory/recall.js';
import { MemoryV3Store } from '../src/plugins/memory/store.js';
import type { MemoryAddress, MemoryEpisodeV3Record, MemoryFactV3Record } from '../src/types/memory-v3.js';

class MemoryDbMock {
  tables: Record<string, any[]> = {
    memory_fact_v3: [],
    memory_episode_v3: [],
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

function fact(overrides: Partial<MemoryFactV3Record>): MemoryFactV3Record {
  return {
    id: 1,
    userKey: groupA.userKey,
    kind: 'preference',
    topicKey: 'answer-style',
    content: '用户喜欢简洁直接的技术回答',
    keywords: '["技术","回答"]',
    importance: 0.9,
    confidence: 0.9,
    sensitivity: 'low',
    visibility: 'global',
    sourceContextKey: groupA.contextKey,
    allowedContextKeys: null,
    deniedContextKeys: null,
    applicability: null,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
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

function episode(overrides: Partial<MemoryEpisodeV3Record>): MemoryEpisodeV3Record {
  return {
    id: 1,
    userKey: groupA.userKey,
    title: 'A 群偏好',
    summary: '用户在 A 群讨论 memory-v3',
    keywords: '["memory-v3"]',
    importance: 0.9,
    confidence: 0.9,
    sensitivity: 'low',
    visibility: 'source_context_only',
    sourceContextKey: groupA.contextKey,
    allowedContextKeys: null,
    deniedContextKeys: null,
    applicability: null,
    periodStart: null,
    periodEnd: null,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
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

describe('memory-v3 recall', () => {
  it('recalls global facts and same-context episodes but not private or other-context memory in groups', async () => {
    const db = new MemoryDbMock();
    db.tables.memory_fact_v3.push(
      fact({ id: 1, visibility: 'global', content: '用户喜欢简洁直接的技术回答' }),
      fact({ id: 2, visibility: 'private_only', content: '用户的私密计划' }),
    );
    db.tables.memory_episode_v3.push(
      episode({ id: 1, sourceContextKey: groupA.contextKey, summary: '用户在 A 群讨论 memory-v3' }),
      episode({ id: 2, sourceContextKey: 'onebot:bot:20001:group:g-b', summary: '用户在 B 群说了一个梗' }),
    );

    const result = await retrieveMemoryForContext(new MemoryV3Store(db as any), groupA, '你还记得 memory-v3 吗', {
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
});
