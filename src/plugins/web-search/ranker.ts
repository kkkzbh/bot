import { hasLLM, invokeOpenAICompatible } from './llm.js';
import type { SearchCandidate, SearchPlan, SearchRuntimeConfig } from './types.js';
import { canonicalizeUrl, extractKeywordTokens, normalizeText, parseJsonBlock } from './utils.js';

const HIGH_SIGNAL_DOMAIN_WEIGHTS: Array<[RegExp, number]> = [
  [/wikipedia\.org/i, 7],
  [/baike\.baidu\.com/i, 7],
  [/bangumi\.tv/i, 6],
  [/fandom\.com/i, 5],
  [/bilibili\.com/i, 3],
  [/moegirl\.org\.cn/i, 3],
];

const RERANK_SYSTEM_PROMPT = [
  '你是搜索结果重排器。',
  '你只输出 JSON，不要解释。',
  '输出格式固定为 {"ordered_urls":[]}。',
  '只根据 query 和 candidates 判断相关性；优先保留包含核心实体、能直接回答问题、歧义更小的结果。',
  '如果拿不准，就保持当前顺序。',
].join('\n');

function matchWeight(url: string): number {
  for (const [pattern, weight] of HIGH_SIGNAL_DOMAIN_WEIGHTS) {
    if (pattern.test(url)) return weight;
  }
  return 0;
}

function countMatches(text: string, terms: string[]): number {
  const normalized = normalizeText(text).toLowerCase();
  return terms.reduce((total, term) => (normalized.includes(term) ? total + 1 : total), 0);
}

function scoreCandidate(candidate: SearchCandidate, plan: SearchPlan): SearchCandidate {
  const queryTokens = extractKeywordTokens(plan.normalizedQuery);
  const entityTokens = plan.entities.map((entity) => entity.toLowerCase());
  const titleMatches = countMatches(candidate.title, queryTokens);
  const descriptionMatches = countMatches(candidate.description, queryTokens);
  const entityTitleMatches = countMatches(candidate.title, entityTokens);
  const entityDescriptionMatches = countMatches(candidate.description, entityTokens);

  const evidence: string[] = [];
  let score = 0;

  if (candidate.url) {
    const urlWeight = matchWeight(candidate.url);
    score += urlWeight;
    if (urlWeight) evidence.push(`domain:${urlWeight}`);
  }
  if (titleMatches) {
    score += titleMatches * 3;
    evidence.push(`title:${titleMatches}`);
  }
  if (descriptionMatches) {
    score += descriptionMatches * 2;
    evidence.push(`description:${descriptionMatches}`);
  }
  if (entityTitleMatches) {
    score += entityTitleMatches * 4;
    evidence.push(`entity-title:${entityTitleMatches}`);
  }
  if (entityDescriptionMatches) {
    score += entityDescriptionMatches * 2;
    evidence.push(`entity-description:${entityDescriptionMatches}`);
  }
  if (plan.domain === 'acgn' && candidate.source === 'moegirl') {
    score += 4;
    evidence.push('acgn-extension');
  }
  if (plan.needsDisambiguation && entityTitleMatches >= Math.max(plan.entities.length, 1)) {
    score += 3;
    evidence.push('disambiguation-match');
  }

  return {
    ...candidate,
    score,
    evidence: [...candidate.evidence, ...evidence],
  };
}

export function dedupeCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
  const byKey = new Map<string, SearchCandidate>();

  for (const candidate of candidates) {
    const key = canonicalizeUrl(candidate.url) || normalizeText(candidate.title).toLowerCase();
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || existing.score < candidate.score) {
      byKey.set(key, candidate);
    }
  }

  return [...byKey.values()];
}

export function rankCandidates(candidates: SearchCandidate[], plan: SearchPlan, topK: number): SearchCandidate[] {
  return dedupeCandidates(candidates.map((candidate) => scoreCandidate(candidate, plan)))
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, Math.max(topK, 1));
}

export function isLowConfidence(results: SearchCandidate[], plan: SearchPlan): boolean {
  if (!results.length) return true;
  const [first, second] = results;
  if (first.score < 5) return true;
  if (plan.needsDisambiguation && second && first.score - second.score < 2) return true;
  return false;
}

export async function rerankCandidatesWithLLM(
  results: SearchCandidate[],
  plan: SearchPlan,
  runtime: SearchRuntimeConfig,
  signal?: AbortSignal,
): Promise<SearchCandidate[]> {
  if (!runtime.llm.rerankEnabled || !hasLLM(runtime.llm) || results.length < 2) {
    return results;
  }

  try {
    const payload = await invokeOpenAICompatible(
      runtime.llm,
      RERANK_SYSTEM_PROMPT,
      JSON.stringify({
        query: plan.normalizedQuery,
        candidates: results.slice(0, 8).map(({ title, url, description, source, score }) => ({
          title,
          url,
          description,
          source,
          score,
        })),
      }),
      signal,
    );
    const parsed = parseJsonBlock(payload);
    const orderedUrls = Array.isArray(parsed?.ordered_urls)
      ? parsed.ordered_urls.map((item) => canonicalizeUrl(String(item ?? ''))).filter(Boolean)
      : [];
    if (!orderedUrls.length) return results;

    const order = new Map(orderedUrls.map((url, index) => [url, index]));
    return [...results].sort((left, right) => {
      const leftIndex = order.get(canonicalizeUrl(left.url));
      const rightIndex = order.get(canonicalizeUrl(right.url));
      if (leftIndex == null && rightIndex == null) return right.score - left.score;
      if (leftIndex == null) return 1;
      if (rightIndex == null) return -1;
      return leftIndex - rightIndex;
    });
  } catch {
    return results;
  }
}
