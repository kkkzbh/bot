import { createHash } from 'node:crypto';
import type { MainChatRuntimeProfile } from '../../shared/llm/main-chat-tabs.js';
import type { MemoryAddress, MemoryOutputProtocolId } from '../../../types/memory.js';
import type { ExtractedMemoryCandidate } from '../gates.js';
import { requestChatMemoryJson, requestChatMemoryPlainText } from './chat-client.js';
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
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  timeoutMs?: number;
  requestMode?: string | null;
  structuredOutputProtocol?: string | null;
  supportsJsonMode?: boolean;
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

export function buildMemoryProviderProfile(
  profile: MainChatRuntimeProfile,
  overrides: Partial<MemoryProviderProfile> = {},
): MemoryProviderProfile {
  return {
    routeId: overrides.routeId ?? `${profile.tabId}:${profile.structuredOutputProtocol}`,
    baseUrl: overrides.baseUrl ?? profile.baseUrl,
    apiKey: overrides.apiKey ?? profile.apiKey,
    model: overrides.model ?? profile.transportModel,
    timeoutMs: overrides.timeoutMs ?? 60_000,
    requestMode: overrides.requestMode ?? profile.requestMode,
    structuredOutputProtocol: overrides.structuredOutputProtocol ?? profile.structuredOutputProtocol,
    supportsJsonMode: overrides.supportsJsonMode ?? false,
  };
}

function normalizeRequestMode(value: unknown, fallback: MainChatRuntimeProfile['requestMode']): MainChatRuntimeProfile['requestMode'] {
  return value === 'responses' || value === 'chat_completions' ? value : fallback;
}

function normalizeStructuredOutputProtocol(
  value: unknown,
  fallback: MainChatRuntimeProfile['structuredOutputProtocol'],
): MemoryProviderProfile['structuredOutputProtocol'] {
  if (
    value === 'native_chat_json_schema' ||
    value === 'native_responses_json_schema' ||
    value === 'chat_reply_v1' ||
    value === 'json_mode'
  ) {
    return value;
  }
  return fallback;
}

export function buildMemoryExtractProviderProfile(
  mainProfile: MainChatRuntimeProfile,
  overrides: MemoryExtractProviderOverrides = {},
): MemoryProviderProfile {
  const baseUrl = String(overrides.baseUrl ?? '').trim();
  const apiKey = String(overrides.apiKey ?? '').trim();
  const model = String(overrides.model ?? '').trim();
  const hasDedicatedProvider = Boolean(baseUrl || apiKey || model);
  return buildMemoryProviderProfile(mainProfile, {
    routeId: overrides.routeId ?? 'memory-extract',
    baseUrl: hasDedicatedProvider ? baseUrl : mainProfile.baseUrl,
    apiKey: hasDedicatedProvider ? apiKey : mainProfile.apiKey,
    model: hasDedicatedProvider ? model : mainProfile.transportModel,
    timeoutMs: overrides.timeoutMs ?? 60_000,
    requestMode: hasDedicatedProvider
      ? normalizeRequestMode(overrides.requestMode, 'chat_completions')
      : normalizeRequestMode(overrides.requestMode, mainProfile.requestMode),
    structuredOutputProtocol: hasDedicatedProvider
      ? normalizeStructuredOutputProtocol(overrides.structuredOutputProtocol, 'chat_reply_v1')
      : normalizeStructuredOutputProtocol(overrides.structuredOutputProtocol, mainProfile.structuredOutputProtocol),
    supportsJsonMode: overrides.supportsJsonMode ?? false,
  });
}

export function resolveMemoryOutputProtocol(profile: MemoryProviderProfile | MainChatRuntimeProfile): MemoryOutputProtocolId {
  if (profile.structuredOutputProtocol === 'native_responses_json_schema') return 'native_responses_json_schema';
  if (profile.structuredOutputProtocol === 'native_chat_json_schema') return 'native_chat_json_schema';
  if ('supportsJsonMode' in profile && profile.supportsJsonMode) return 'json_mode_with_repair';
  if (profile.structuredOutputProtocol === 'chat_reply_v1') return 'plain_text_memory_v1';
  return 'no_write_fallback';
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

  if (route === 'no_write_fallback') {
    return {
      route,
      ok: false,
      candidates: [],
      drops: ['memory_provider_no_write_fallback'],
      rawTextHash: null,
      error: 'memory_provider_no_write_fallback',
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
