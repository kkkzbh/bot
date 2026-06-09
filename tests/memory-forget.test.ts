import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/plugins/memory/store.js';

class MemoryDbMock {
  tables: Record<string, any[]> = {
    memory_fact: [],
    memory_episode: [],
    memory_provenance: [],
    memory_tombstone: [],
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

describe('memory forget', () => {
  it('removes final memory, provenance, pending embed job and writes memory/source tombstones', async () => {
    const db = new MemoryDbMock();
    db.tables.memory_fact.push({
      id: 7,
      ownerUserKey: 'onebot:user:10001',
      sourceContextKey: 'onebot:bot:20001:group:g1',
      topicKey: 'answer-style',
    });
    db.tables.memory_provenance.push({
      id: 1,
      ownerUserKey: 'onebot:user:10001',
      contextKey: 'onebot:bot:20001:group:g1',
      memoryType: 'fact',
      memoryId: 7,
      messageIds: '["m1","m2"]',
    });
    db.tables.memory_job.push({
      id: 5,
      payload: '{"recordType":"fact","recordId":7}',
    });

    const ok = await new MemoryStore(db as any).forgetMemory({
      userKey: 'onebot:user:10001',
      type: 'fact',
      id: 7,
    });

    expect(ok).toBe(true);
    expect(db.tables.memory_fact).toEqual([]);
    expect(db.tables.memory_provenance).toEqual([]);
    expect(db.tables.memory_job).toEqual([]);
    expect(db.tables.memory_tombstone).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memoryType: 'fact', memoryId: 7, topicKey: 'answer-style' }),
        expect.objectContaining({ memoryType: 'topic', topicKey: 'answer-style' }),
        expect.objectContaining({ memoryType: 'source', sourceMessageId: 'm1' }),
        expect.objectContaining({ memoryType: 'source', sourceMessageId: 'm2' }),
      ]),
    );
  });
});
