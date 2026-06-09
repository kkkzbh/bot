import type { MemoryFactRecord } from '../../types/memory.js';

export function resolveFactConflictSet(facts: readonly MemoryFactRecord[]): MemoryFactRecord[] {
  const byConflict = new Map<string, MemoryFactRecord>();
  const passthrough: MemoryFactRecord[] = [];
  for (const fact of facts) {
    if (!fact.conflictSetId) {
      passthrough.push(fact);
      continue;
    }
    const current = byConflict.get(fact.conflictSetId);
    if (!current) {
      byConflict.set(fact.conflictSetId, fact);
      continue;
    }
    const currentScore = Number(current.confidence ?? 0) * 0.6 + Number(current.importance ?? 0) * 0.25 + Number(current.lastSeenAt ?? 0) / 1e15;
    const nextScore = Number(fact.confidence ?? 0) * 0.6 + Number(fact.importance ?? 0) * 0.25 + Number(fact.lastSeenAt ?? 0) / 1e15;
    if (nextScore > currentScore) byConflict.set(fact.conflictSetId, fact);
  }
  return [...passthrough, ...byConflict.values()];
}
