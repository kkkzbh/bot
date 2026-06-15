import { createHash } from 'node:crypto';
import type { MainChatRuntimeProfile } from '../../shared/llm/main-chat-tabs.js';
import type { MemoryAddress, MemoryOutputProtocolId } from '../../../types/memory.js';
import type { ExtractedMemoryCandidate } from '../gates.js';
import { requestChatMemoryJson, requestChatMemoryPlainText } from './chat-client.js';
import { MemoryProviderHttpError } from './http-error.js';
import { requestJsonModeMemoryWithRepair } from './json-mode-repair.js';
import { parsePlainTextMemoryV1 } from './plain-text-memory-v1.js';
import { requestResponsesMemoryJson } from './responses-client.js';
import type { MemoryConversationTurn, MemoryExtractionTarget } from './schemas.js';

export interface MemoryProviderProfile {
  routeId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  requestMode: 'chat_completions' | 'responses';
  structuredOutputProtocol:
    | 'native_chat_json_schema'
    | 'native_responses_json_schema'
    | 'chat_reply_v1'
    | 'json_mode';
  supportsJsonMode?: boolean;
}

export interface MemoryExtractProviderOverrides {
  routeId?: string;
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  timeoutMs: number;
  requestMode: string;
  structuredOutputProtocol: string;
  supportsJsonMode: boolean;
}

export interface MemoryExtractInput {
  address: MemoryAddress;
  target: MemoryExtractionTarget;
  turns: MemoryConversationTurn[];
  providerProfile: MemoryProviderProfile;
  maxFacts: number;
  maxEpisodes: number;
}

export interface MemoryExtractOutput {
  route: MemoryOutputProtocolId;
  ok: boolean;
  candidates: ExtractedMemoryCandidate[];
  drops: string[];
  rawTextHash: string | null;
  error: string | null;
}

export function isMemoryProviderConfigured(profile: MemoryProviderProfile): boolean {
  return Boolean(profile.baseUrl.trim() && profile.apiKey.trim() && profile.model.trim());
}

function requireRequestMode(value: unknown): MemoryProviderProfile['requestMode'] {
  if (value === 'responses' || value === 'chat_completions') return value;
  throw new Error('memory extract requestMode must be configured as chat_completions or responses.');
}

function requireStructuredOutputProtocol(value: unknown): MemoryProviderProfile['structuredOutputProtocol'] {
  if (
    value === 'native_chat_json_schema' ||
    value === 'native_responses_json_schema' ||
    value === 'chat_reply_v1' ||
    value === 'json_mode'
  ) {
    return value;
  }
  throw new Error('memory extract structuredOutputProtocol must be configured explicitly.');
}

function requireTimeoutMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('memory extract timeoutMs must be configured as a positive number.');
  }
  return Math.floor(parsed);
}

export function buildMemoryExtractProviderProfile(
  mainProfile: MainChatRuntimeProfile,
  overrides: MemoryExtractProviderOverrides,
): MemoryProviderProfile {
  const baseUrl = String(overrides.baseUrl ?? '').trim();
  const apiKey = String(overrides.apiKey ?? '').trim();
  const model = String(overrides.model ?? '').trim();
  const hasDedicatedProvider = Boolean(baseUrl || apiKey || model);
  return {
    routeId: overrides.routeId ?? 'memory-extract',
    baseUrl: hasDedicatedProvider ? baseUrl : '',
    apiKey: hasDedicatedProvider ? apiKey : '',
    model: hasDedicatedProvider ? model : '',
    timeoutMs: requireTimeoutMs(overrides.timeoutMs),
    requestMode: requireRequestMode(overrides.requestMode),
    structuredOutputProtocol: requireStructuredOutputProtocol(overrides.structuredOutputProtocol),
    supportsJsonMode: overrides.supportsJsonMode,
  };
}

export function resolveMemoryOutputProtocol(profile: MemoryProviderProfile | MainChatRuntimeProfile): MemoryOutputProtocolId {
  if (profile.structuredOutputProtocol === 'native_responses_json_schema') return 'native_responses_json_schema';
  if (profile.structuredOutputProtocol === 'native_chat_json_schema') return 'native_chat_json_schema';
  if ('supportsJsonMode' in profile && profile.supportsJsonMode) return 'json_mode_with_repair';
  if (profile.structuredOutputProtocol === 'chat_reply_v1') return 'plain_text_memory_v1';
  return 'unsupported_protocol';
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function extractMemoryCandidates(input: MemoryExtractInput): Promise<MemoryExtractOutput> {
  const route = resolveMemoryOutputProtocol(input.providerProfile);
  if (!isMemoryProviderConfigured(input.providerProfile)) {
    return {
      route,
      ok: false,
      candidates: [],
      drops: ['memory_provider_unconfigured'],
      rawTextHash: null,
      error: 'memory_provider_unconfigured',
    };
  }

  if (route === 'unsupported_protocol') {
    return {
      route,
      ok: false,
      candidates: [],
      drops: ['memory_provider_unsupported_protocol'],
      rawTextHash: null,
      error: 'memory_provider_unsupported_protocol',
    };
  }

  try {
    let candidates: ExtractedMemoryCandidate[] = [];
    let rawText = '';
    if (route === 'native_responses_json_schema') {
      const result = await requestResponsesMemoryJson(input.providerProfile, input.turns, input.target);
      candidates = result.candidates;
      rawText = result.rawText;
    } else if (route === 'native_chat_json_schema') {
      const result = await requestChatMemoryJson(input.providerProfile, input.turns, input.target);
      candidates = result.candidates;
      rawText = result.rawText;
    } else if (route === 'json_mode_with_repair') {
      const result = await requestJsonModeMemoryWithRepair(input.providerProfile, input.turns, input.target);
      candidates = result.candidates;
      rawText = result.rawText;
    } else {
      rawText = await requestChatMemoryPlainText(input.providerProfile, input.turns, input.target);
      candidates = parsePlainTextMemoryV1(rawText);
    }

    const facts = candidates.filter((candidate) => candidate.candidateType === 'fact').slice(0, input.maxFacts);
    const episodes = candidates.filter((candidate) => candidate.candidateType === 'episode').slice(0, input.maxEpisodes);
    const drops = candidates
      .filter((candidate) => candidate.candidateType === 'drop')
      .map((candidate) => candidate.dropReason ?? 'drop');
    return {
      route,
      ok: true,
      candidates: [...facts, ...episodes, ...candidates.filter((candidate) => candidate.candidateType === 'drop')],
      drops,
      rawTextHash: rawText ? hashText(rawText) : null,
      error: null,
    };
  } catch (error) {
    if (error instanceof MemoryProviderHttpError) throw error;
    return {
      route,
      ok: false,
      candidates: [],
      drops: [],
      rawTextHash: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
