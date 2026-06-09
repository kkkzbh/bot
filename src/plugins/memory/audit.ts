import type { MemoryRecordType } from '../../types/memory-v3.js';
import type { MemoryV3Store } from './store.js';

export async function recordMemoryAudit(
  store: MemoryV3Store,
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
