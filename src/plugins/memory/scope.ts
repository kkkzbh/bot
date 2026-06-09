import { createHash } from 'node:crypto';
import type {
  MemoryChannelType,
  MemoryEpisodeRecord,
  MemoryFactRecord,
  MemoryScopeType,
  MemoryVisibility,
} from '../../types/memory.js';
import { parseJsonArray, slugify } from './format.js';

export type MemoryKeyLayer = 'profile' | 'fact' | 'episode' | 'edge';

const SCOPE_TYPES = new Set<MemoryScopeType>([
  'owner_all_contexts',
  'dm_only',
  'source_context_only',
  'allowed_contexts',
  'denied_contexts',
  'pending_review',
  'archived',
]);

export function isMemoryScopeType(value: unknown): value is MemoryScopeType {
  return typeof value === 'string' && SCOPE_TYPES.has(value as MemoryScopeType);
}

export function scopeTypeFromVisibility(visibility: MemoryVisibility): MemoryScopeType {
  switch (visibility) {
    case 'global':
      return 'owner_all_contexts';
    case 'private_only':
      return 'dm_only';
    case 'source_context_only':
      return 'source_context_only';
    case 'allowed_contexts':
      return 'allowed_contexts';
    case 'denied_contexts':
      return 'denied_contexts';
    case 'pending_review':
      return 'pending_review';
    case 'archived':
      return 'archived';
    default:
      return 'pending_review';
  }
}

export function visibilityFromScopeType(scopeType: MemoryScopeType): MemoryVisibility {
  switch (scopeType) {
    case 'owner_all_contexts':
      return 'global';
    case 'dm_only':
      return 'private_only';
    case 'source_context_only':
      return 'source_context_only';
    case 'allowed_contexts':
      return 'allowed_contexts';
    case 'denied_contexts':
      return 'denied_contexts';
    case 'pending_review':
      return 'pending_review';
    case 'archived':
      return 'archived';
    default:
      return 'pending_review';
  }
}

export function sourceKindFromContextKey(contextKey: string | null | undefined): MemoryChannelType {
  return String(contextKey ?? '').includes(':group:') ? 'group' : 'direct';
}

export function resolveRecordScopeType(row: {
  scopeType?: string | null;
  visibility: MemoryVisibility;
}): MemoryScopeType {
  return isMemoryScopeType(row.scopeType) ? row.scopeType : scopeTypeFromVisibility(row.visibility);
}

export function resolveRecordScopeKey(row: {
  scopeType?: string | null;
  scopeKey?: string | null;
  visibility: MemoryVisibility;
  sourceContextKey: string;
}): string | null {
  const scopeType = resolveRecordScopeType(row);
  if (typeof row.scopeKey === 'string' && row.scopeKey.trim()) return row.scopeKey.trim();
  return scopeType === 'source_context_only' ? row.sourceContextKey : null;
}

export function scopeKeyForType(scopeType: MemoryScopeType, sourceContextKey: string): string | null {
  return scopeType === 'source_context_only' ? sourceContextKey : null;
}

export function buildMemoryKey(input: {
  userKey: string;
  layer: MemoryKeyLayer;
  kind: string;
  topicKey: string;
  scopeType: MemoryScopeType;
  scopeKey: string | null;
}): string {
  return createHash('sha256')
    .update([
      input.userKey,
      input.layer,
      input.kind,
      input.topicKey,
      input.scopeType,
      input.scopeKey ?? '*',
    ].join('\0'))
    .digest('hex');
}

export function buildSourceId(input: {
  userKey: string;
  contextKey: string;
  conversationId: string;
  messageIds: readonly string[];
}): string {
  return createHash('sha256')
    .update([
      input.userKey,
      input.contextKey,
      input.conversationId,
      ...input.messageIds,
    ].join('\0'))
    .digest('hex');
}

export function episodeTopicKey(record: Pick<MemoryEpisodeRecord, 'title' | 'keywords'>): string {
  return slugify([record.title, ...parseJsonArray(record.keywords).slice(0, 3)].join('-')) || 'episode';
}

export function buildStoredMemoryKey(
  layer: 'fact',
  row: Pick<MemoryFactRecord, 'ownerUserKey' | 'kind' | 'topicKey' | 'visibility' | 'scopeType' | 'scopeKey' | 'sourceContextKey'>,
): string;
export function buildStoredMemoryKey(
  layer: 'episode',
  row: Pick<MemoryEpisodeRecord, 'ownerUserKey' | 'title' | 'keywords' | 'visibility' | 'scopeType' | 'scopeKey' | 'sourceContextKey'>,
): string;
export function buildStoredMemoryKey(
  layer: 'fact' | 'episode',
  row:
    | Pick<MemoryFactRecord, 'ownerUserKey' | 'kind' | 'topicKey' | 'visibility' | 'scopeType' | 'scopeKey' | 'sourceContextKey'>
    | Pick<MemoryEpisodeRecord, 'ownerUserKey' | 'title' | 'keywords' | 'visibility' | 'scopeType' | 'scopeKey' | 'sourceContextKey'>,
): string {
  const scopeType = resolveRecordScopeType(row);
  const scopeKey = resolveRecordScopeKey(row);
  if (layer === 'fact') {
    const fact = row as Pick<MemoryFactRecord, 'ownerUserKey' | 'kind' | 'topicKey'>;
    return buildMemoryKey({
      userKey: fact.ownerUserKey,
      layer,
      kind: fact.kind,
      topicKey: fact.topicKey,
      scopeType,
      scopeKey,
    });
  }
  const episode = row as Pick<MemoryEpisodeRecord, 'ownerUserKey' | 'title' | 'keywords'>;
  return buildMemoryKey({
    userKey: episode.ownerUserKey,
    layer,
    kind: 'episode',
    topicKey: episodeTopicKey(episode),
    scopeType,
    scopeKey,
  });
}
