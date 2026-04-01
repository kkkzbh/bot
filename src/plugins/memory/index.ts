import { Context, Logger, Schema, type Session } from 'koishi';
import type {
  MemoryJobRecord,
} from '../../types/memory-v2.js';
import {
  type MemoryConversationTurn,
  type MemoryEmbedRuntime,
  type MemoryExtractRuntime,
  embedTexts,
  extractLongMemory,
  isEmbedRuntimeConfigured,
  isExtractRuntimeConfigured,
} from './llm.js';
import {
  MemoryV2Store,
  buildMemoryContextBlock,
  buildMemoryScope,
  extractPlainText,
  buildMemoryDocuments,
  planMemoryRecall,
  rankMemoryDocumentsByVector,
  type MemoryScope,
} from './store.js';
import { consumePromptEnvelope, registerPromptFragment } from '../shared/prompt-context/index.js';
import { MemoryV2StatusService } from './status.js';
export { MemoryV2StatusService, createUnavailableMemoryV2StatusSnapshot } from './status.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
};

export const name = 'memory-v2';
export const inject = ['chatluna', 'database'];

const logger = new Logger(name);
const DEFAULT_EMBED_BASE_URL = 'https://api.siliconflow.cn/v1';

export interface Config {
  enabled?: boolean;
  extractBaseUrl?: string;
  extractApiKey?: string;
  extractModel?: string;
  extractTimeoutMs?: number;
  embedBaseUrl?: string;
  embedApiKey?: string;
  embedModel?: string;
  embedTimeoutMs?: number;
  queryTopK?: number;
  promptBudgetTokens?: number;
  embedBatchSize?: number;
  extractIdleMs?: number;
  extractMessageBatch?: number;
  archiveDays?: number;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用本地长期记忆 v2。'),
  extractBaseUrl: Schema.string().description('长期记忆提炼用 OpenAI 兼容 Base URL。'),
  extractApiKey: Schema.string().role('secret').description('长期记忆提炼用 API Key。'),
  extractModel: Schema.string().description('长期记忆提炼模型。'),
  extractTimeoutMs: Schema.natural().role('time').default(60000).description('长期记忆提炼请求超时（毫秒）。'),
  embedBaseUrl: Schema.string().role('link').default(DEFAULT_EMBED_BASE_URL).description('embedding 服务 Base URL。'),
  embedApiKey: Schema.string().role('secret').description('embedding 服务 API Key。'),
  embedModel: Schema.string().default('Qwen/Qwen3-Embedding-8B').description('embedding 模型。'),
  embedTimeoutMs: Schema.natural().role('time').default(12000).description('embedding 请求超时（毫秒）。'),
  queryTopK: Schema.natural().default(8).description('长期记忆召回条数上限。'),
  promptBudgetTokens: Schema.natural().default(1200).description('长期记忆注入 prompt 预算。'),
  embedBatchSize: Schema.natural().default(16).description('单批 embedding 条数。'),
  extractIdleMs: Schema.natural().role('time').default(90000).description('会话静默多久后触发记忆提炼。'),
  extractMessageBatch: Schema.natural().default(12).description('提炼时读取的最近消息条数。'),
  archiveDays: Schema.natural().default(90).description('低价值 episode 归档天数。'),
});

type ChainHookBuilder = {
  after: (name: string) => ChainHookBuilder;
  before: (name: string) => ChainHookBuilder;
};

type ChatLunaLike = {
  contextManager?: {
    inject: (options: {
      name: string;
      value: unknown;
      once?: boolean;
      conversationId?: string;
      stage?: string;
    }) => void;
  };
  chatChain?: {
    middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => ChainHookBuilder;
  };
};

type ContextServiceView = {
  get?: (name: string) => unknown;
  chatluna?: ChatLunaLike;
  database?: {
    get: (table: string, query: Record<string, unknown>) => Promise<any[]>;
    set: (table: string, query: Record<string, unknown>, data: Record<string, unknown>) => Promise<unknown>;
    upsert: (table: string, rows: Record<string, unknown>[], keys?: string[]) => Promise<unknown>;
    create: (table: string, row: Record<string, unknown>) => Promise<Record<string, unknown>>;
    remove: (table: string, query: Record<string, unknown>) => Promise<unknown>;
  };
};

type RoomLike = {
  conversationId?: string;
};

type MiddlewareContextLike = {
  options?: {
    room?: RoomLike;
    inputMessage?: {
      content?: unknown;
    };
  };
};

interface RuntimeConfig {
  enabled: boolean;
  extract: MemoryExtractRuntime;
  embed: MemoryEmbedRuntime;
  queryTopK: number;
  promptBudgetTokens: number;
  embedBatchSize: number;
  extractIdleMs: number;
  extractMessageBatch: number;
  archiveDays: number;
}

function clampNatural(value: number | undefined, fallback: number, min = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  return {
    enabled: config.enabled !== false,
    extract: {
      baseUrl: String(config.extractBaseUrl ?? '').trim(),
      apiKey: String(config.extractApiKey ?? '').trim(),
      model: String(config.extractModel ?? '').trim(),
      timeoutMs: clampNatural(config.extractTimeoutMs, 60000, 3000),
    },
    embed: {
      baseUrl: String(config.embedBaseUrl ?? DEFAULT_EMBED_BASE_URL).trim(),
      apiKey: String(config.embedApiKey ?? '').trim(),
      model: String(config.embedModel ?? 'Qwen/Qwen3-Embedding-8B').trim(),
      timeoutMs: clampNatural(config.embedTimeoutMs, 12000, 3000),
    },
    queryTopK: clampNatural(config.queryTopK, 8, 1),
    promptBudgetTokens: clampNatural(config.promptBudgetTokens, 1200, 200),
    embedBatchSize: clampNatural(config.embedBatchSize, 16, 1),
    extractIdleMs: clampNatural(config.extractIdleMs, 90000, 10_000),
    extractMessageBatch: clampNatural(config.extractMessageBatch, 12, 4),
    archiveDays: clampNatural(config.archiveDays, 90, 7),
  };
}

function resolveChatLunaService(ctx: ContextServiceView): ChatLunaLike | undefined {
  const getter = ctx.get;
  if (typeof getter === 'function') {
    const service = getter.call(ctx, 'chatluna');
    if (service) return service as ChatLunaLike;
  }
  const attached = (ctx as { chatluna?: unknown }).chatluna;
  return attached as ChatLunaLike | undefined;
}

function resolveInputText(session: Session, context: MiddlewareContextLike): string {
  return extractPlainText(session.stripped?.content ?? session.content ?? context.options?.inputMessage?.content);
}

async function injectMemoryContext(
  store: MemoryV2Store,
  runtime: RuntimeConfig,
  scope: MemoryScope,
  query: string,
  conversationId: string,
): Promise<void> {
  const [profiles, episodes] = await Promise.all([
    store.listScopeFacts(scope),
    store.listScopeEpisodes(scope),
  ]);
  if (!profiles.length && !episodes.length) return;

  const episodeDocs = buildMemoryDocuments([], episodes);
  const recallPlan = planMemoryRecall(query, episodeDocs, Date.now(), runtime.queryTopK);
  let selected = recallPlan.candidates;

  if (episodeDocs.length && recallPlan.needsSemanticSearch && isEmbedRuntimeConfigured(runtime.embed)) {
    try {
      const [queryEmbedding] = await embedTexts(runtime.embed, [query]);
      if (queryEmbedding) {
        selected = rankMemoryDocumentsByVector(episodeDocs, queryEmbedding, Date.now(), runtime.queryTopK);
      }
    } catch (error) {
      logger.warn('memory semantic recall failed: %s', (error as Error).message);
    }
  }

  const selectedEpisodes = selected.length
    ? episodes.filter((episode) => selected.some((item) => item.recordId === episode.id))
    : [];
  const prompt = buildMemoryContextBlock(profiles, selectedEpisodes, runtime.promptBudgetTokens);
  if (!prompt) return;

  registerPromptFragment(conversationId, {
    source: 'qqbot_memory_v2',
    title: 'Long-Term Memory Reference',
    authority: 'reference',
    trust: 'untrusted',
    ttl: 'turn',
    payload: {
      kind: 'text',
      value: prompt,
    },
  });

  const episodeIds = selected.map((item) => item.recordId);
  if (episodeIds.length) {
    await store.touchEpisodes(episodeIds);
  }
}

async function processExtractJob(store: MemoryV2Store, runtime: RuntimeConfig, job: MemoryJobRecord): Promise<void> {
  const payload = store.parseExtractJob(job);
  if (!payload) {
    await store.completeJob(job);
    return;
  }
  if (!isExtractRuntimeConfigured(runtime.extract)) {
    await store.completeJob(job);
    return;
  }

  const turns = await store.readConversationWindow(payload.conversationId, payload.maxMessages);
  if (turns.length < 2) {
    logger.debug('memory extract skipped: conversation %s has %d text turns after content extraction', payload.conversationId, turns.length);
    await store.completeJob(job);
    return;
  }

  const extraction = await extractLongMemory(runtime.extract, turns);
  if (!extraction.profileItems.length && !extraction.episodes.length) {
    await store.completeJob(job);
    return;
  }

  await store.applyExtraction(
    {
      scopeType: payload.scopeType,
      scopeKey: payload.scopeKey,
    },
    extraction,
    turns.map((turn) => turn.id),
  );
  await store.completeJob(job);
}

async function processEmbedJobs(store: MemoryV2Store, runtime: RuntimeConfig, jobs: MemoryJobRecord[]): Promise<void> {
  if (!jobs.length) return;
  if (!isEmbedRuntimeConfigured(runtime.embed)) {
    for (const job of jobs) {
      await store.completeJob(job);
    }
    return;
  }

  const resolved: Array<{ job: MemoryJobRecord; text: string; payload: { recordType: 'episode'; recordId: number } }> = [];
  for (const job of jobs) {
    const item = await store.resolveEmbedJob(job);
    if (!item || !item.text.trim()) {
      await store.completeJob(job);
      continue;
    }
    resolved.push({ job, text: item.text, payload: item.payload });
  }
  if (!resolved.length) return;

  const vectors = await embedTexts(
    runtime.embed,
    resolved.map((item) => item.text),
  );

  for (const [index, item] of resolved.entries()) {
    const vector = vectors[index];
    if (!vector) {
      await store.retryJob(item.job, new Error('empty_embedding_vector'), 60_000);
      continue;
    }
    await store.applyEmbedding(item.payload, runtime.embed.model, vector);
    await store.completeJob(item.job);
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const services = ctx as unknown as ContextServiceView;
  const database = services.database;
  const runtime = toRuntimeConfig(config);
  if (!runtime.enabled || !database) return;

  MemoryV2Store.ensureTables(ctx);
  const store = new MemoryV2Store(database);
  const statusService = new MemoryV2StatusService(runtime, store, async () => {
    const [vector] = await embedTexts(runtime.embed, ['healthcheck']);
    if (!vector) throw new Error('empty_embedding_vector');
  });
  ctx.provide('memoryV2Status');
  ctx.set('memoryV2Status', statusService);
  let processing = false;
  let lastArchiveAt = 0;

  const tick = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    try {
      const now = Date.now();
      const extractJobs = await store.listDueJobs('extract', now);
      if (extractJobs.length) {
        const job = extractJobs[0];
        await store.markJobProcessing(job);
        const startedAt = Date.now();
        statusService.recordAttempt('extract', 'runtime', startedAt);
        try {
          await processExtractJob(store, runtime, job);
          statusService.recordSuccess('extract', 'runtime', Math.max(0, Date.now() - startedAt), Date.now());
        } catch (error) {
          logger.warn('memory extract job failed: %s', (error as Error).message);
          statusService.recordFailure('extract', 'runtime', error, Math.max(0, Date.now() - startedAt), Date.now());
          await store.retryJob(job, error, 60_000);
        }
      }

      const embedJobs = (await store.listDueJobs('embed', now)).slice(0, runtime.embedBatchSize);
      if (embedJobs.length) {
        for (const job of embedJobs) {
          await store.markJobProcessing(job);
        }
        const startedAt = Date.now();
        statusService.recordAttempt('embed', 'runtime', startedAt);
        try {
          await processEmbedJobs(store, runtime, embedJobs);
          statusService.recordSuccess('embed', 'runtime', Math.max(0, Date.now() - startedAt), Date.now());
        } catch (error) {
          logger.warn('memory embed jobs failed: %s', (error as Error).message);
          statusService.recordFailure('embed', 'runtime', error, Math.max(0, Date.now() - startedAt), Date.now());
          for (const job of embedJobs) {
            await store.retryJob(job, error, 60_000);
          }
        }
      }

      if (!lastArchiveAt || now - lastArchiveAt >= 6 * 60 * 60 * 1000) {
        await store.archiveExpiredEpisodes(runtime.archiveDays);
        lastArchiveAt = now;
        statusService.recordArchive(now);
      }
    } finally {
      processing = false;
    }
  };

  ctx.on('ready', () => {
    const chatluna = resolveChatLunaService(services);
    const chain = chatluna?.chatChain;
    const contextManager = chatluna?.contextManager;
    if (!chain || !contextManager) {
      logger.warn('chatluna service is unavailable, skip memory-v2 middleware registration.');
      return;
    }

    chain
      .middleware('qqbot_memory_v2', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MiddlewareContextLike;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const conversationId = context.options?.room?.conversationId?.trim();
        const scope = buildMemoryScope(session);
        const inputText = resolveInputText(session, context);
        if (!conversationId || !scope || !inputText) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        await store.queueExtractJob(
          {
            conversationId,
            scopeType: scope.scopeType,
            scopeKey: scope.scopeKey,
            maxMessages: runtime.extractMessageBatch,
          },
          Date.now() + runtime.extractIdleMs,
        );

        try {
          await injectMemoryContext(store, runtime, scope, inputText, conversationId);
        } catch (error) {
          logger.warn('memory recall skipped: %s', (error as Error).message);
        }

        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('read_chat_message')
      .before('lifecycle-handle_command');

    chain
      .middleware('qqbot_prompt_envelope', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MiddlewareContextLike;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const conversationId = context.options?.room?.conversationId?.trim();
        if (!conversationId) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;

        const envelope = consumePromptEnvelope(conversationId);
        if (!envelope?.messages.length) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        contextManager.inject({
          name: 'qqbot_prompt_envelope',
          value: envelope.messages,
          once: true,
          conversationId,
          stage: 'after_scratchpad',
        });
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('qqbot_memory_v2')
      .after('qqbot_sticker_policy')
      .after('qqbot_reply_transport_policy')
      .after('chatluna_time_context')
      .before('lifecycle-handle_command');

    void (async () => {
      const recovered = await store.requeueProcessingJobs();
      if (recovered > 0) {
        logger.warn('memory recovered %d orphaned processing jobs after startup', recovered);
      }
      ctx.setInterval(() => void tick(), 10_000);
      await tick();
    })().catch((error) => {
      logger.warn('memory startup recovery failed: %s', (error as Error).message);
      ctx.setInterval(() => void tick(), 10_000);
      void tick();
    });
  });
}
