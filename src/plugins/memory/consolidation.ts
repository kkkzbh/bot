import type { MemoryAddress, MemoryCandidateV3Record, MemoryRecordType } from '../../types/memory-v3.js';
import type { MemoryV3Store } from './store.js';

export async function consolidateApprovedCandidate(
  store: MemoryV3Store,
  row: MemoryCandidateV3Record,
  address: MemoryAddress,
): Promise<{ type: MemoryRecordType; id: number } | null> {
  return store.consolidateCandidate(row, address);
}
