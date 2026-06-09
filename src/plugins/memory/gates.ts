import type {
  MemoryAddress,
  MemoryCandidateReviewStatus,
  MemorySensitivity,
  MemoryVisibility,
} from '../../types/memory-v3.js';

export interface ExtractedMemoryCandidate {
  candidateType: 'fact' | 'episode' | 'drop';
  subject: 'user';
  kind?: 'identity' | 'preference' | 'trait' | 'boundary' | 'plan' | 'relationship';
  topicKey?: string;
  content?: string;
  title?: string;
  summary?: string;
  keywords: string[];
  importance: number;
  confidence: number;
  sensitivity: MemorySensitivity;
  suggestedVisibility: MemoryVisibility;
  applicability?: string | null;
  evidence?: string | null;
  conflictHint?: string | null;
  periodStart?: string | number | null;
  periodEnd?: string | number | null;
  validFrom?: string | number | null;
  validUntil?: string | number | null;
  expiresAt?: string | number | null;
  dropReason?: string | null;
}

export interface PrivacyDecision {
  status: MemoryCandidateReviewStatus;
  sensitivity: MemorySensitivity;
  visibility: MemoryVisibility;
  reason: string | null;
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_\-]{16,}\b/,
  /\b(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{8,}/i,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9_\-./+=]{12,}/i,
];

const PII_PATTERNS = [
  /\b1[3-9]\d{9}\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\d{15}(\d{2}[0-9Xx])?\b/,
];

const THIRD_PARTY_PRIVACY_PATTERN = /(?:他|她|别人|朋友|同学|同事|群友|室友|家人|妈妈|爸爸).{0,16}(?:手机号|电话|地址|密码|身份证|隐私|病|收入|账号)/;
const GROUP_JOKE_PATTERN = /(?:玩笑|开玩笑|梗|外号|乳名|迫害|roleplay|角色扮演|群友说|大家叫|起哄|整活|meme)/i;

function candidateText(candidate: ExtractedMemoryCandidate): string {
  return [candidate.content, candidate.title, candidate.summary, candidate.evidence, candidate.dropReason]
    .filter((item): item is string => typeof item === 'string')
    .join('\n');
}

function maxSensitivity(left: MemorySensitivity, right: MemorySensitivity): MemorySensitivity {
  const rank: Record<MemorySensitivity, number> = {
    low: 0,
    personal: 1,
    sensitive: 2,
    secret: 3,
  };
  return rank[right] > rank[left] ? right : left;
}

export function runDeterministicPrivacyGuard(
  candidate: ExtractedMemoryCandidate,
  address: MemoryAddress,
): PrivacyDecision {
  const text = candidateText(candidate);
  if (!text.trim()) {
    return {
      status: 'rejected',
      sensitivity: candidate.sensitivity,
      visibility: 'archived',
      reason: 'empty_candidate',
    };
  }

  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      status: 'rejected',
      sensitivity: 'secret',
      visibility: 'archived',
      reason: 'secret_guard',
    };
  }

  let sensitivity = candidate.sensitivity;
  let visibility = candidate.suggestedVisibility;
  let status: MemoryCandidateReviewStatus = 'approved';
  let reason: string | null = null;

  if (PII_PATTERNS.some((pattern) => pattern.test(text))) {
    sensitivity = maxSensitivity(sensitivity, 'sensitive');
    visibility = 'private_only';
    status = 'pending_review';
    reason = 'pii_guard';
  }

  if (THIRD_PARTY_PRIVACY_PATTERN.test(text)) {
    sensitivity = maxSensitivity(sensitivity, 'sensitive');
    visibility = 'pending_review';
    status = 'pending_review';
    reason = reason ?? 'third_party_privacy_guard';
  }

  if (address.channelType === 'group') {
    if (GROUP_JOKE_PATTERN.test(text)) {
      sensitivity = maxSensitivity(sensitivity, 'personal');
      visibility = 'pending_review';
      status = 'pending_review';
      reason = reason ?? 'group_joke_guard';
    } else if (visibility === 'global' || visibility === 'private_only') {
      visibility = 'source_context_only';
    }
  }

  if (candidate.candidateType === 'drop') {
    status = 'rejected';
    visibility = 'archived';
    reason = candidate.dropReason ?? 'model_drop';
  }

  if (sensitivity === 'secret') {
    return {
      status: 'rejected',
      sensitivity: 'secret',
      visibility: 'archived',
      reason: reason ?? 'secret_candidate',
    };
  }

  return {
    status,
    sensitivity,
    visibility,
    reason,
  };
}

export function isMemoryVisibleInContext(input: {
  visibility: MemoryVisibility;
  sensitivity: MemorySensitivity;
  archived: number;
  sourceContextKey: string;
  allowedContextKeys?: readonly string[];
  deniedContextKeys?: readonly string[];
  address: MemoryAddress;
  now: number;
  validUntil?: number | null;
}): boolean {
  if (input.archived === 1) return false;
  if (input.visibility === 'archived' || input.visibility === 'pending_review') return false;
  if (input.sensitivity === 'secret') return false;
  if (input.validUntil != null && input.validUntil < input.now) return false;
  if (input.address.channelType === 'group' && input.sensitivity === 'sensitive') return false;
  if (input.address.channelType === 'group' && input.visibility === 'private_only') return false;
  if (input.visibility === 'source_context_only' && input.sourceContextKey !== input.address.contextKey) return false;
  if (input.visibility === 'allowed_contexts' && !(input.allowedContextKeys ?? []).includes(input.address.contextKey)) return false;
  if (input.visibility === 'denied_contexts' && (input.deniedContextKeys ?? []).includes(input.address.contextKey)) return false;
  return true;
}
