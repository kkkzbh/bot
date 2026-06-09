import type { MemorySensitivity, MemoryVisibility } from '../../../types/memory-v3.js';
import type { ParsedMemoryV2Scope } from './parse-v2-scope.js';

export function inferMigratedSensitivity(content: string): MemorySensitivity {
  if (/\b(?:sk-|token|api[_-]?key|password|secret)\b/i.test(content)) return 'secret';
  if (/\b1[3-9]\d{9}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(content)) return 'sensitive';
  if (/地址|身份证|手机号|电话|学校|公司|家人|健康|收入/.test(content)) return 'personal';
  return 'low';
}

export function decideMigratedVisibility(input: {
  scope: ParsedMemoryV2Scope;
  content: string;
  archived?: number | null;
}): { visibility: MemoryVisibility; sensitivity: MemorySensitivity; drop: boolean; reason: string | null } {
  const sensitivity = inferMigratedSensitivity(input.content);
  if (input.archived === 1) return { visibility: 'archived', sensitivity, drop: false, reason: null };
  if (sensitivity === 'secret') return { visibility: 'archived', sensitivity, drop: true, reason: 'secret_guard' };
  if (input.scope.scopeType === 'user_group') {
    if (sensitivity === 'sensitive') {
      return { visibility: 'pending_review', sensitivity, drop: false, reason: 'group_sensitive_review' };
    }
    return { visibility: 'source_context_only', sensitivity, drop: false, reason: null };
  }
  if (sensitivity === 'low') return { visibility: 'global', sensitivity, drop: false, reason: null };
  return { visibility: 'private_only', sensitivity, drop: false, reason: null };
}
