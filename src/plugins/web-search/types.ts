export type SearchIntent = 'lookup' | 'compare' | 'news';

export type SearchDomain = 'general' | 'acgn';

export type SearchProviderId = 'bing-web' | 'duckduckgo-lite' | 'wikipedia' | 'moegirl';

export type SearchPlan = {
  originalQuery: string;
  normalizedQuery: string;
  intent: SearchIntent;
  entities: string[];
  queries: string[];
  providerHints: SearchProviderId[];
  domain: SearchDomain;
  needsDisambiguation: boolean;
};

export type SearchCandidate = {
  title: string;
  url: string;
  description: string;
  source: SearchProviderId;
  score: number;
  tags: string[];
  evidence: string[];
};

export type SearchResult = Pick<SearchCandidate, 'title' | 'url' | 'description'>;

export type SearchRequest = {
  query: string;
  limit: number;
  timeoutMs: number;
  signal: AbortSignal;
};

export interface SearchProvider {
  id: SearchProviderId;
  supports(plan: SearchPlan): boolean;
  search(plan: SearchPlan, request: SearchRequest): Promise<SearchCandidate[]>;
}

export type SearchLLMConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  plannerEnabled: boolean;
  rerankEnabled: boolean;
};

export type SearchRuntimeConfig = {
  topK: number;
  timeoutMs: number;
  providers: SearchProviderId[];
  acgnExtensionEnabled: boolean;
  llm: SearchLLMConfig;
};
