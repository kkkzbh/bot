import { hasLLM, invokeOpenAICompatible } from './llm.js';
import type { SearchPlan, SearchProviderId, SearchRuntimeConfig } from './types.js';
import {
  buildFallbackQueries,
  detectDomain,
  detectIntent,
  parseJsonBlock,
  sanitizeSearchQueryInput,
  shouldDisambiguate,
  splitEntityCandidates,
  takeUnique,
} from './utils.js';

const SEARCH_PLANNER_SYSTEM_PROMPT = [
  '你是搜索查询规划器。',
  '你只输出 JSON，不要解释。',
  '输出格式固定为 {"intent":"lookup","entities":[],"queries":[],"provider_hints":[],"domain":"general","needs_disambiguation":false}。',
  'intent 只能是 lookup, compare, news 之一。',
  'provider_hints 只能从 bing-web, duckduckgo-lite, wikipedia, moegirl 中选。',
  'domain 只能是 general 或 acgn。',
  'queries 最多 6 条，必须保留用户原始实体，不要把实体改坏。',
  'needs_disambiguation 只有在同名、多实体、需要消歧时才为 true。',
].join('\n');

function filterProviderHints(value: unknown, allowed: SearchProviderId[]): SearchProviderId[] {
  if (!Array.isArray(value)) return [];
  const allowedSet = new Set<SearchProviderId>(allowed);
  const output: SearchProviderId[] = [];
  for (const item of value) {
    const normalized = typeof item === 'string' ? item.trim() : '';
    if (!allowedSet.has(normalized as SearchProviderId)) continue;
    if (!output.includes(normalized as SearchProviderId)) {
      output.push(normalized as SearchProviderId);
    }
  }
  return output;
}

export function buildFallbackSearchPlan(originalQuery: string, runtime: SearchRuntimeConfig): SearchPlan {
  const normalizedQuery = sanitizeSearchQueryInput(originalQuery);
  const entities = takeUnique(splitEntityCandidates(normalizedQuery), 4);
  const needsDisambiguation = shouldDisambiguate(normalizedQuery, entities);

  return {
    originalQuery,
    normalizedQuery,
    intent: detectIntent(normalizedQuery),
    entities,
    queries: buildFallbackQueries(normalizedQuery, entities, needsDisambiguation),
    providerHints: runtime.providers,
    domain: detectDomain(normalizedQuery),
    needsDisambiguation,
  };
}

export function parsePlannedSearchPayload(
  payload: string,
  fallbackPlan: SearchPlan,
  runtime: SearchRuntimeConfig,
): SearchPlan {
  const parsed = parseJsonBlock(payload);
  if (!parsed) return fallbackPlan;

  const intent = parsed.intent === 'compare' || parsed.intent === 'news' ? parsed.intent : fallbackPlan.intent;
  const domain = parsed.domain === 'acgn' ? 'acgn' : fallbackPlan.domain;
  const entities = takeUnique(
    Array.isArray(parsed.entities)
      ? parsed.entities.map((item) => String(item ?? ''))
      : fallbackPlan.entities,
    4,
  );
  const queries = takeUnique(
    Array.isArray(parsed.queries)
      ? [
          ...parsed.queries.map((item) => String(item ?? '')),
          fallbackPlan.normalizedQuery,
          ...entities,
        ]
      : fallbackPlan.queries,
    6,
  );
  const providerHints = filterProviderHints(parsed.provider_hints, runtime.providers);
  const needsDisambiguation =
    typeof parsed.needs_disambiguation === 'boolean'
      ? parsed.needs_disambiguation
      : shouldDisambiguate(fallbackPlan.normalizedQuery, entities);

  return {
    originalQuery: fallbackPlan.originalQuery,
    normalizedQuery: fallbackPlan.normalizedQuery,
    intent,
    entities: entities.length ? entities : fallbackPlan.entities,
    queries: queries.length ? queries : fallbackPlan.queries,
    providerHints: providerHints.length ? providerHints : fallbackPlan.providerHints,
    domain,
    needsDisambiguation,
  };
}

export async function buildSearchPlan(
  originalQuery: string,
  runtime: SearchRuntimeConfig,
  signal?: AbortSignal,
): Promise<SearchPlan> {
  const fallbackPlan = buildFallbackSearchPlan(originalQuery, runtime);
  if (!runtime.llm.plannerEnabled || !hasLLM(runtime.llm)) {
    return fallbackPlan;
  }

  try {
    const payload = await invokeOpenAICompatible(
      runtime.llm,
      SEARCH_PLANNER_SYSTEM_PROMPT,
      `用户搜索请求：${fallbackPlan.normalizedQuery}`,
      signal,
    );
    return parsePlannedSearchPayload(payload, fallbackPlan, runtime);
  } catch {
    return fallbackPlan;
  }
}
