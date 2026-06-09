import type { MemoryAddress, MemoryCandidateRecord, MemoryRecordType } from '../../types/memory.js';
import type { MemoryStore } from './store.js';

export async function consolidateApprovedCandidate(
  store: MemoryStore,
  row: MemoryCandidateRecord,
  address: MemoryAddress,
): Promise<{ type: MemoryRecordType; id: number } | null> {
  return store.consolidateCandidate(row, address);
}
