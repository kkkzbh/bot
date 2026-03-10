import { isLowConfidence, rankCandidates, rerankCandidatesWithLLM } from './ranker.js';
import type { SearchCandidate, SearchPlan, SearchProvider, SearchProviderId, SearchRuntimeConfig } from './types.js';
import { takeUnique } from './utils.js';

function chooseCoreProviderIds(plan: SearchPlan, runtime: SearchRuntimeConfig): SearchProviderId[] {
  const coreProviders = runtime.providers.filter((provider) => provider !== 'moegirl');
  if (!plan.providerHints.length) return coreProviders;

  const hinted = coreProviders.filter((provider) => plan.providerHints.includes(provider));
  return hinted.length ? hinted : coreProviders;
}

function shouldUseAcgnExtension(
  plan: SearchPlan,
  rankedCoreResults: SearchCandidate[],
  runtime: SearchRuntimeConfig,
): boolean {
  if (!runtime.acgnExtensionEnabled || !runtime.providers.includes('moegirl')) return false;
  if (plan.domain === 'acgn') return true;
  return isLowConfidence(rankedCoreResults, plan);
}

async function searchProviderQueries(
  provider: SearchProvider,
  plan: SearchPlan,
  queries: string[],
  runtime: SearchRuntimeConfig,
  signal?: AbortSignal,
): Promise<SearchCandidate[]> {
  if (!provider.supports(plan)) return [];

  const tasks = queries.map((query) =>
    provider.search(plan, {
      query,
      limit: runtime.topK * 2,
      timeoutMs: runtime.timeoutMs,
      signal: signal ?? new AbortController().signal,
    }),
  );

  return (await Promise.allSettled(tasks)).flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

export async function runSearch(
  plan: SearchPlan,
  runtime: SearchRuntimeConfig,
  providers: SearchProvider[],
  signal?: AbortSignal,
): Promise<SearchCandidate[]> {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const coreProviderIds = chooseCoreProviderIds(plan, runtime);
  const queries = takeUnique(plan.queries.length ? plan.queries : [plan.normalizedQuery], 6);

  const coreResults = (
    await Promise.all(
      coreProviderIds
        .map((id) => providerMap.get(id))
        .filter((provider): provider is SearchProvider => !!provider)
        .map((provider) => searchProviderQueries(provider, plan, queries, runtime, signal)),
    )
  ).flat();

  let ranked = rankCandidates(coreResults, plan, runtime.topK * 3);

  if (shouldUseAcgnExtension(plan, ranked, runtime)) {
    const moegirlProvider = providerMap.get('moegirl');
    if (moegirlProvider) {
      const extensionQueries = takeUnique([plan.normalizedQuery, ...plan.entities], 4);
      const extensionResults = await searchProviderQueries(moegirlProvider, plan, extensionQueries, runtime, signal);
      ranked = rankCandidates([...coreResults, ...extensionResults], plan, runtime.topK * 3);
    }
  }

  if (plan.needsDisambiguation || isLowConfidence(ranked, plan)) {
    ranked = await rerankCandidatesWithLLM(ranked, plan, runtime, signal);
  }

  return ranked.slice(0, runtime.topK);
}
