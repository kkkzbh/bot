import { describe, expect, it } from 'vitest';
import { LEGACY_MEMORY_TABLES, runLegacyMemoryMigration } from '../src/plugins/memory/migration.js';

class MemoryDbMock {
  tables: Record<string, any[]> = {
    [LEGACY_MEMORY_TABLES.fact]: [],
    [LEGACY_MEMORY_TABLES.episode]: [],
    [LEGACY_MEMORY_TABLES.profile]: [],
    [LEGACY_MEMORY_TABLES.job]: [],
    memory_fact: [],
    memory_episode: [],
    memory_profile: [],
    memory_job: [],
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

describe('memory legacy migration', () => {
  it('migrates old direct rows into canonical memory tables and discards old group rows/jobs', async () => {
    const db = new MemoryDbMock();
    db.tables[LEGACY_MEMORY_TABLES.fact].push(
      {
        id: 1,
        userKey: 'onebot:user:10001',
        kind: 'preference',
        topicKey: 'answer-style',
        content: '用户私聊里喜欢直接回答',
        keywords: '["回答风格"]',
        importance: 0.9,
        confidence: 0.9,
        sensitivity: 'low',
        visibility: 'global',
        sourceContextKey: 'onebot:bot:20001:dm:10001',
        firstSeenAt: 1,
        lastSeenAt: 2,
        version: 1,
        archived: 0,
      },
      {
        id: 2,
        userKey: 'onebot:user:10002',
        kind: 'preference',
        topicKey: 'group-style',
        content: '群聊里 B 喜欢长篇解释',
        keywords: '["群聊"]',
        importance: 0.9,
        confidence: 0.9,
        sensitivity: 'low',
        visibility: 'source_context_only',
        sourceContextKey: 'onebot:bot:20001:group:g1',
        firstSeenAt: 1,
        lastSeenAt: 2,
        version: 1,
        archived: 0,
      },
    );
    db.tables[LEGACY_MEMORY_TABLES.episode].push({
      id: 3,
      userKey: 'onebot:user:10001',
      title: '私聊讨论 memory',
      summary: '用户在私聊里讨论长期记忆方案',
      keywords: '["memory"]',
      importance: 0.85,
      confidence: 0.88,
      sensitivity: 'low',
      visibility: 'private_only',
      sourceContextKey: 'onebot:bot:20001:dm:10001',
      firstSeenAt: 1,
      lastSeenAt: 2,
      version: 1,
      archived: 0,
    });
    db.tables[LEGACY_MEMORY_TABLES.profile].push({
      id: 4,
      ownerUserKey: 'onebot:user:10001',
      profileKey: 'answer-style',
      kind: 'response_policy',
      content: '用户偏好直接、可落地的技术方案',
      valueJson: null,
      importance: 0.9,
      confidence: 0.9,
      sensitivity: 'low',
      scopeType: 'owner_all_contexts',
      scopeKey: null,
      sourceContextKey: 'onebot:bot:20001:dm:10001',
      firstSeenAt: 1,
      lastSeenAt: 2,
      version: 1,
      archived: 0,
    });
    db.tables[LEGACY_MEMORY_TABLES.job].push({
      id: 5,
      jobKey: 'extract:legacy',
      jobType: 'extract',
      status: 'pending',
      payload: '{}',
      retryCount: 0,
      nextRunAt: 1,
      lockedAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const result = await runLegacyMemoryMigration(db as any);

    expect(result).toMatchObject({
      factsMigrated: 1,
      episodesMigrated: 1,
      profilesMigrated: 1,
      groupRowsDiscarded: 1,
    });
    expect(db.tables.memory_fact).toEqual([
      expect.objectContaining({
        ownerUserKey: 'onebot:user:10001',
        content: '用户私聊里喜欢直接回答',
        sourceKind: 'direct',
        targetSpeakerId: '10001',
        attributionStatus: 'verified',
      }),
    ]);
    expect(db.tables.memory_episode).toEqual([
      expect.objectContaining({
        ownerUserKey: 'onebot:user:10001',
        summary: '用户在私聊里讨论长期记忆方案',
        sourceKind: 'direct',
        targetSpeakerId: '10001',
      }),
    ]);
    expect(db.tables.memory_profile).toEqual([
      expect.objectContaining({
        ownerUserKey: 'onebot:user:10001',
        profileKey: 'answer-style',
        kind: 'response_policy',
        sourceContextKey: 'onebot:bot:20001:dm:10001',
      }),
    ]);
    expect(db.tables.memory_fact).not.toEqual([
      expect.objectContaining({ content: '群聊里 B 喜欢长篇解释' }),
    ]);
    expect(db.tables.memory_job).toEqual([]);
  });
});
