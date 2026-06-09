import type { MemoryRecordType } from '../../types/memory.js';
import type { MemoryStore } from './store.js';

export async function recordMemoryAudit(
  store: MemoryStore,
  input: {
    userKey?: string | null;
    contextKey?: string | null;
    eventType: string;
    memoryType?: MemoryRecordType | null;
    memoryId?: number | null;
    candidateId?: number | null;
    turnId?: string | null;
    detail?: unknown;
  },
): Promise<void> {
  await store.audit(input);
}
