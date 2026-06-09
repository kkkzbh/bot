import type { MemorySensitivity, MemoryVisibility } from '../../../types/memory.js';
import type { ExtractedMemoryCandidate } from '../gates.js';
import { uniqueKeywords } from '../format.js';
import { normalizeProfileKind } from './profile-kind.js';

const VISIBILITIES = new Set<MemoryVisibility>([
  'global',
  'private_only',
  'source_context_only',
  'allowed_contexts',
  'denied_contexts',
  'pending_review',
  'archived',
]);
const SENSITIVITIES = new Set<MemorySensitivity>(['low', 'personal', 'sensitive', 'secret']);

function splitEscapedPipe(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '|') {
      fields.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  fields.push(current);
  return fields;
}

function parseKvFields(fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of fields) {
    const index = field.indexOf('=');
    if (index <= 0) throw new Error(`malformed_field:${field}`);
    result[field.slice(0, index).trim()] = field.slice(index + 1).trim();
  }
  return result;
}

function parseVisibility(value: string | undefined): MemoryVisibility {
  if (value && VISIBILITIES.has(value as MemoryVisibility)) return value as MemoryVisibility;
  throw new Error(`invalid_visibility:${value ?? ''}`);
}

function parseList(value: string | undefined): string[] {
  return uniqueKeywords((value ?? '').split(',').map((item) => item.trim()));
}

function parseSubject(value: string | undefined): ExtractedMemoryCandidate['subject'] {
  if (
    value === 'target_user' ||
    value === 'other_speaker' ||
    value === 'group_shared' ||
    value === 'assistant' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'unknown';
}

function parseSensitivity(value: string | undefined): MemorySensitivity {
  if (value && SENSITIVITIES.has(value as MemorySensitivity)) return value as MemorySensitivity;
  throw new Error(`invalid_sensitivity:${value ?? ''}`);
}

function requireScore(kv: Record<string, string>, key: 'confidence' | 'importance'): number {
  if (!(key in kv)) throw new Error(`missing_${key}`);
  const parsed = Number(kv[key]);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`invalid_${key}`);
  return parsed;
}

function parseFact(fields: string[]): ExtractedMemoryCandidate {
  if (fields.length < 3) throw new Error('malformed_fact');
  const content = fields[fields.length - 1]?.trim();
  const kv = parseKvFields(fields.slice(1, -1));
  const kind = normalizeProfileKind(kv.kind);
  if (!kind) throw new Error(`invalid_kind:${kv.kind ?? ''}`);
  if (!kv.topic?.trim() || !content) throw new Error('missing_fact_required_field');
  return {
    candidateType: 'fact',
    subject: parseSubject(kv.subject),
    ownerSpeakerId: kv.owner?.trim() || null,
    kind,
    topicKey: kv.topic.trim(),
    content,
    keywords: uniqueKeywords((kv.keywords ?? '').split(',').map((item) => item.trim())),
    importance: requireScore(kv, 'importance'),
    confidence: requireScore(kv, 'confidence'),
    suggestedVisibility: parseVisibility(kv.visibility),
    sensitivity: parseSensitivity(kv.sensitivity),
    applicability: kv.applicability || null,
    evidenceMessageIds: parseList(kv.evidenceMessages),
    evidenceSpeakerIds: parseList(kv.evidenceSpeakers),
  };
}

function parseEpisode(fields: string[]): ExtractedMemoryCandidate {
  if (fields.length < 3) throw new Error('malformed_episode');
  const summary = fields[fields.length - 1]?.trim();
  const kv = parseKvFields(fields.slice(1, -1));
  if (!kv.title?.trim() || !summary) throw new Error('missing_episode_required_field');
  return {
    candidateType: 'episode',
    subject: parseSubject(kv.subject),
    ownerSpeakerId: kv.owner?.trim() || null,
    title: kv.title.trim(),
    summary,
    keywords: uniqueKeywords((kv.keywords ?? '').split(',').map((item) => item.trim())),
    importance: requireScore(kv, 'importance'),
    confidence: requireScore(kv, 'confidence'),
    suggestedVisibility: parseVisibility(kv.visibility),
    sensitivity: parseSensitivity(kv.sensitivity),
    periodStart: kv.date || kv.periodStart || null,
    periodEnd: kv.periodEnd || null,
    applicability: kv.applicability || null,
    evidenceMessageIds: parseList(kv.evidenceMessages),
    evidenceSpeakerIds: parseList(kv.evidenceSpeakers),
  };
}

function parseDrop(fields: string[]): ExtractedMemoryCandidate {
  if (fields.length !== 2 || !fields[1]?.trim()) throw new Error('malformed_drop');
  return {
    candidateType: 'drop',
    subject: 'unknown',
    dropReason: fields[1].trim(),
    keywords: [],
    importance: 0,
    confidence: 1,
    suggestedVisibility: 'archived',
    sensitivity: 'low',
  };
}

export function parsePlainTextMemoryV1(text: string): ExtractedMemoryCandidate[] {
  const matches = [...text.matchAll(/<memory_extraction>\s*([\s\S]*?)\s*<\/memory_extraction>/g)];
  if (matches.length !== 1) throw new Error(matches.length === 0 ? 'missing_memory_block' : 'multiple_memory_blocks');
  const body = matches[0]?.[1] ?? '';
  const candidates: ExtractedMemoryCandidate[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = splitEscapedPipe(line);
    const tag = fields[0];
    if (tag === 'FACT') {
      candidates.push(parseFact(fields));
    } else if (tag === 'EPISODE') {
      candidates.push(parseEpisode(fields));
    } else if (tag === 'DROP') {
      candidates.push(parseDrop(fields));
    } else {
      throw new Error(`unknown_memory_line:${tag}`);
    }
  }
  return candidates;
}
