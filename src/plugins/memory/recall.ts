import type { MemoryAddress, MemoryEpisodeV3Record, MemoryFactV3Record } from '../../types/memory-v3.js';
import { resolveFactConflictSet } from './conflict.js';
import { isMemoryVisibleInContext } from './gates.js';
import { buildMemoryContextBlock, parseJsonArray } from './format.js';
import { buildEpisodeDocument, buildFactDocument, rankMemoryDocuments } from './ranking.js';
import type { MemoryV3Store } from './store.js';

export interface MemoryRecallOptions {
  topK: number;
  promptBudgetTokens: number;
  now?: number;
  queryEmbedding?: number[] | null;
}

export interface MemoryRecallResult {
  prompt: string | null;
  facts: MemoryFactV3Record[];
  episodes: MemoryEpisodeV3Record[];
}

export async function retrieveMemoryForContext(
  store: MemoryV3Store,
  address: MemoryAddress,
  query: string,
  options: MemoryRecallOptions,
): Promise<MemoryRecallResult> {
  const now = options.now ?? Date.now();
  const [facts, episodes] = await Promise.all([
    store.listFactsForUser(address.userKey),
    store.listEpisodesForUser(address.userKey),
  ]);

  const visibleFacts = resolveFactConflictSet(facts.filter((fact) => isMemoryVisibleInContext({
    visibility: fact.visibility,
    sensitivity: fact.sensitivity,
    archived: fact.archived,
    sourceContextKey: fact.sourceContextKey,
    allowedContextKeys: parseJsonArray(fact.allowedContextKeys),
    deniedContextKeys: parseJsonArray(fact.deniedContextKeys),
    address,
    now,
    validUntil: fact.validUntil,
  })));
  const visibleEpisodes = episodes.filter((episode) => isMemoryVisibleInContext({
    visibility: episode.visibility,
    sensitivity: episode.sensitivity,
    archived: episode.archived,
    sourceContextKey: episode.sourceContextKey,
    allowedContextKeys: parseJsonArray(episode.allowedContextKeys),
    deniedContextKeys: parseJsonArray(episode.deniedContextKeys),
    address,
    now,
    validUntil: episode.validUntil,
  }));

  const documents = [
    ...visibleFacts.map(buildFactDocument),
    ...visibleEpisodes.map(buildEpisodeDocument),
  ];
  const selectedDocs = rankMemoryDocuments({
    query,
    documents,
    now,
    topK: options.topK,
    queryEmbedding: options.queryEmbedding,
  });
  const factIds = new Set(selectedDocs.filter((item) => item.type === 'fact').map((item) => item.id));
  const episodeIds = new Set(selectedDocs.filter((item) => item.type === 'episode').map((item) => item.id));
  const selectedFacts = visibleFacts.filter((fact) => factIds.has(fact.id));
  const selectedEpisodes = visibleEpisodes.filter((episode) => episodeIds.has(episode.id));
  const prompt = buildMemoryContextBlock(selectedFacts, selectedEpisodes, options.promptBudgetTokens);
  if (selectedFacts.length) await store.touchMemory('fact', selectedFacts.map((fact) => fact.id));
  if (selectedEpisodes.length) await store.touchMemory('episode', selectedEpisodes.map((episode) => episode.id));
  if (prompt) {
    await store.audit({
      userKey: address.userKey,
      contextKey: address.contextKey,
      eventType: 'recall_selected',
      turnId: address.conversationId,
      detail: {
        facts: selectedFacts.map((fact) => fact.id),
        episodes: selectedEpisodes.map((episode) => episode.id),
      },
    });
  }
  return {
    prompt,
    facts: selectedFacts,
    episodes: selectedEpisodes,
  };
}
