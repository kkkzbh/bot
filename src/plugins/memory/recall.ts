import type { MemoryAddress, MemoryEpisodeRecord, MemoryFactRecord, MemoryProfileRecord } from '../../types/memory.js';
import { resolveFactConflictSet } from './conflict.js';
import { buildMemoryContextBlock } from './format.js';
import { buildEpisodeDocument, buildFactDocument, hasRecallCue, rankMemoryDocumentsDetailed, type RankedMemoryDocument } from './ranking.js';
import type { MemoryStore } from './store.js';

export interface MemoryRecallOptions {
  topK: number;
  promptBudgetTokens: number;
  now?: number;
  queryEmbedding?: number[] | null;
}

export interface MemoryRecallResult {
  prompt: string | null;
  profiles: MemoryProfileRecord[];
  facts: MemoryFactRecord[];
  episodes: MemoryEpisodeRecord[];
}

function byRankedId(items: RankedMemoryDocument[]): Set<number> {
  return new Set(items.map((item) => item.document.id));
}

function rankedDetail(items: RankedMemoryDocument[], type: 'fact' | 'episode'): Array<{
  id: number;
  score: number;
  reason: string;
  content: string;
}> {
  return items.map((item) => ({
    id: item.document.id,
    score: Number(item.score.toFixed(4)),
    reason: item.reason,
    content: type === 'fact' ? item.document.text : `${item.document.title}: ${item.document.text}`,
  }));
}

export async function retrieveMemoryForContext(
  store: MemoryStore,
  address: MemoryAddress,
  query: string,
  options: MemoryRecallOptions,
): Promise<MemoryRecallResult> {
  const now = options.now ?? Date.now();
  const [profiles, facts, episodes] = await Promise.all([
    store.listProfilesForContext(address, now),
    store.listFactsForContext(address, now),
    store.listEpisodesForContext(address, now),
  ]);

  const visibleFacts = resolveFactConflictSet(facts);
  const visibleEpisodes = hasRecallCue(query) ? episodes : [];
  const selectedProfiles = profiles.slice(0, 6);

  const factDocs = rankMemoryDocumentsDetailed({
    query,
    documents: visibleFacts.map(buildFactDocument),
    now,
    topK: Math.min(6, Math.max(1, options.topK)),
    queryEmbedding: options.queryEmbedding,
    contextKey: address.contextKey,
  });
  const episodeDocs = visibleEpisodes.length
    ? rankMemoryDocumentsDetailed({
        query,
        documents: visibleEpisodes.map(buildEpisodeDocument),
        now,
        topK: Math.min(2, Math.max(1, options.topK)),
        queryEmbedding: options.queryEmbedding,
        contextKey: address.contextKey,
      })
    : [];
  const factIds = byRankedId(factDocs);
  const episodeIds = byRankedId(episodeDocs);
  const selectedFacts = visibleFacts.filter((fact) => factIds.has(fact.id));
  const selectedEpisodes = visibleEpisodes.filter((episode) => episodeIds.has(episode.id));
  const prompt = buildMemoryContextBlock(selectedFacts, selectedEpisodes, options.promptBudgetTokens, selectedProfiles, address.userId);
  if (selectedProfiles.length) await store.touchProfiles(selectedProfiles.map((profile) => profile.id));
  if (selectedFacts.length) await store.touchMemory('fact', selectedFacts.map((fact) => fact.id));
  if (selectedEpisodes.length) await store.touchMemory('episode', selectedEpisodes.map((episode) => episode.id));
  if (prompt) {
    await store.audit({
      userKey: address.userKey,
      contextKey: address.contextKey,
      eventType: 'recall_selected',
      turnId: address.conversationId,
      detail: {
        profile: selectedProfiles.map((profile) => ({
          id: profile.id,
          score: 1,
          reason: `profile:${profile.profileKey}`,
          content: profile.content,
        })),
        facts: rankedDetail(factDocs, 'fact'),
        episodes: rankedDetail(episodeDocs, 'episode'),
      },
    });
  }
  return {
    prompt,
    profiles: selectedProfiles,
    facts: selectedFacts,
    episodes: selectedEpisodes,
  };
}
