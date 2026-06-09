import { Context, Logger, Schema, type Session } from 'koishi';
import type { MainChatRuntimeProfile } from '../shared/llm/main-chat-tabs.js';
import { mainChatRuntimeState } from '../shared/llm/main-chat-runtime.js';
import { consumePromptEnvelope, registerPromptFragment } from '../shared/prompt-context/index.js';
import { buildMemoryAddress, type MemoryMiddlewareContextLike } from './address.js';
import { DEFAULT_EMBED_BASE_URL, type MemoryRuntimeConfig } from './config.js';
import { registerMemoryCommands } from './commands.js';
import { hasRecallCue } from './ranking.js';
import { retrieveMemoryForContext } from './recall.js';
import { ensureMemoryV3Tables } from './schema.js';
import { MemoryV3StatusService } from './status.js';
export { MemoryV3StatusService, createUnavailableMemoryV3StatusSnapshot } from './status.js';
import { embedTexts, isEmbedRuntimeConfigured } from './providers/embedding-client.js';
import { buildMemoryProviderProfile } from './providers/router.js';
import { runMemoryJobTick, processMaintenanceJob } from './pipeline.js';
import { extractPlainText, MemoryV3Store } from './store.js';
export { MemoryV3Store } from './store.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
};

export const name = 'memory-v3';
export const inject = ['chatluna', 'database'];

const logger = new Logger(name);

export interface Config {
  enabled?: boolean;
  readEnabled?: boolean;
  writeEnabled?: boolean;
  extractBaseUrl?: string;
  extractApiKey?: string;
  extractModel?: string;
  extractTimeoutMs?: number;
  extractRequestMode?: string;
  extractStructuredOutputProtocol?: string;
  extractSupportsJsonMode?: boolean;
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
  maxJobRetries?: number;
  jobLockTimeoutMs?: number;
  maxFacts?: number;
  maxEpisodes?: number;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用本地长期记忆 v3。'),
  readEnabled: Schema.boolean().default(true).description('是否启用长期记忆召回。'),
  writeEnabled: Schema.boolean().default(true).description('是否启用长期记忆提炼写入。'),
  extractBaseUrl: Schema.string().description('长期记忆提炼用 OpenAI 兼容 Base URL；留空时使用主聊天 provider。'),
  extractApiKey: Schema.string().role('secret').description('长期记忆提炼用 API Key；留空时使用主聊天 provider。'),
  extractModel: Schema.string().description('长期记忆提炼模型；留空时使用主聊天模型。'),
  extractTimeoutMs: Schema.natural().role('time').default(60000).description('长期记忆提炼请求超时（毫秒）。'),
  extractRequestMode: Schema.string().default('').description('提炼请求模式：chat_completions / responses；留空跟随主聊天。'),
  extractStructuredOutputProtocol: Schema.string().default('').description('提炼输出协议；留空跟随主聊天。'),
  extractSupportsJsonMode: Schema.boolean().default(false).description('提炼 provider 是否支持 JSON mode + repair。'),
  embedBaseUrl: Schema.string().role('link').default(DEFAULT_EMBED_BASE_URL).description('embedding 服务 Base URL。'),
  embedApiKey: Schema.string().role('secret').description('embedding 服务 API Key。'),
  embedModel: Schema.string().default('Qwen/Qwen3-Embedding-8B').description('embedding 模型。'),
  embedTimeoutMs: Schema.natural().role('time').default(12000).description('embedding 请求超时（毫秒）。'),
  queryTopK: Schema.natural().default(8).description('长期记忆召回条数上限。'),
  promptBudgetTokens: Schema.natural().default(1200).description('长期记忆注入 prompt 预算。'),
  embedBatchSize: Schema.natural().default(16).description('单批 embedding 条数。'),
  extractIdleMs: Schema.natural().role('time').default(90000).description('会话静默多久后触发记忆提炼。'),
  extractMessageBatch: Schema.natural().default(12).description('提炼时读取的最近消息条数。'),
  archiveDays: Schema.natural().default(90).description('低风险 episode 归档天数。'),
  maxJobRetries: Schema.natural().default(5).description('job 最大重试次数。'),
  jobLockTimeoutMs: Schema.natural().role('time').default(300000).description('processing job 锁超时。'),
  maxFacts: Schema.natural().default(8).description('单批最多写入 fact 候选数。'),
  maxEpisodes: Schema.natural().default(8).description('单批最多写入 episode 候选数。'),
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
    upsert?: (table: string, rows: Record<string, unknown>[], keys?: string[]) => Promise<unknown>;
    create: (table: string, row: Record<string, unknown>) => Promise<Record<string, unknown>>;
    remove: (table: string, query: Record<string, unknown>) => Promise<unknown>;
  };
};

function clampNatural(value: number | undefined, fallback: number, min = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function resolveChatLunaService(ctx: ContextServiceView): ChatLunaLike | undefined {
  const getter = ctx.get;
  if (typeof getter === 'function') {
    const service = getter.call(ctx, 'chatluna');
    if (service) return service as ChatLunaLike;
  }
  return ctx.chatluna;
}

function normalizeRequestMode(value: unknown, fallback: MainChatRuntimeProfile['requestMode']): MainChatRuntimeProfile['requestMode'] {
  return value === 'responses' || value === 'chat_completions' ? value : fallback;
}

function normalizeStructuredOutputProtocol(
  value: unknown,
  fallback: MainChatRuntimeProfile['structuredOutputProtocol'],
): 'native_chat_json_schema' | 'native_responses_json_schema' | 'chat_reply_v1' | 'json_mode' {
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

function toRuntimeConfig(config: Config): MemoryRuntimeConfig {
  const mainProfile = mainChatRuntimeState.getProfile();
  return {
    enabled: config.enabled !== false,
    readEnabled: config.readEnabled !== false,
    writeEnabled: config.writeEnabled !== false,
    extract: buildMemoryProviderProfile(mainProfile, {
      routeId: 'memory-v3-extract',
      baseUrl: String(config.extractBaseUrl ?? '').trim() || mainProfile.baseUrl,
      apiKey: String(config.extractApiKey ?? '').trim() || mainProfile.apiKey,
      model: String(config.extractModel ?? '').trim() || mainProfile.transportModel,
      timeoutMs: clampNatural(config.extractTimeoutMs, 60000, 3000),
      requestMode: normalizeRequestMode(config.extractRequestMode, mainProfile.requestMode),
      structuredOutputProtocol: normalizeStructuredOutputProtocol(
        config.extractStructuredOutputProtocol,
        mainProfile.structuredOutputProtocol,
      ),
      supportsJsonMode: config.extractSupportsJsonMode === true,
    }),
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
    maxJobRetries: clampNatural(config.maxJobRetries, 5, 0),
    jobLockTimeoutMs: clampNatural(config.jobLockTimeoutMs, 300000, 30_000),
    maxFacts: clampNatural(config.maxFacts, 8, 1),
    maxEpisodes: clampNatural(config.maxEpisodes, 8, 1),
  };
}

function resolveInputText(session: Session, context: MemoryMiddlewareContextLike): string {
  return extractPlainText(session.stripped?.content ?? session.content ?? context.options?.inputMessage?.content);
}

function warnOldMemoryConfig(): void {
  const legacyPrefixes = [
    ['MEMORY', '_', 'V2', '_'].join(''),
    ['MEMORY', '_', 'EXTRACT', '_'].join(''),
    ['MEMORY', '_', 'EMBED', '_'].join(''),
  ];
  const oldKeys = Object.keys(process.env).filter((key) => legacyPrefixes.some((prefix) => key.startsWith(prefix)));
  if (oldKeys.length) {
    logger.warn('old memory env vars are ignored by memory-v3: %s', oldKeys.join(','));
  }
}

async function injectMemoryContext(
  store: MemoryV3Store,
  runtime: MemoryRuntimeConfig,
  address: ReturnType<typeof buildMemoryAddress> extends infer T ? NonNullable<T> : never,
  query: string,
): Promise<void> {
  let queryEmbedding: number[] | null = null;
  if (hasRecallCue(query) && isEmbedRuntimeConfigured(runtime.embed)) {
    const [vector] = await embedTexts(runtime.embed, [query]);
    queryEmbedding = vector;
  }
  const result = await retrieveMemoryForContext(store, address, query, {
    topK: runtime.queryTopK,
    promptBudgetTokens: runtime.promptBudgetTokens,
    queryEmbedding,
  });
  if (!result.prompt) return;
  registerPromptFragment(address.conversationId, {
    source: 'qqbot_memory_v3',
    title: 'Long-Term Memory Reference',
    authority: 'reference',
    trust: 'untrusted',
    ttl: 'turn',
    payload: {
      kind: 'text',
      value: result.prompt,
    },
  });
}

export function apply(ctx: Context, config: Config = {}): void {
  warnOldMemoryConfig();
  const services = ctx as unknown as ContextServiceView;
  const database = services.database;
  const runtime = toRuntimeConfig(config);
  if (!runtime.enabled || !database) return;

  ensureMemoryV3Tables(ctx);
  const store = new MemoryV3Store(database);
  const statusService = new MemoryV3StatusService(
    runtime,
    store,
    async () => {
      const [vector] = await embedTexts(runtime.embed, ['healthcheck']);
      if (!vector) throw new Error('empty_embedding_vector');
    },
    async () => {
      if (!runtime.extract.baseUrl || !runtime.extract.model) throw new Error('memory_provider_unconfigured');
    },
  );
  ctx.provide('memoryV3Status');
  ctx.set('memoryV3Status', statusService);
  registerMemoryCommands(ctx, store, statusService);

  let processing = false;
  let lastMaintenanceAt = 0;
  const tick = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    try {
      await runMemoryJobTick(store, runtime, statusService);
      const now = Date.now();
      if (!lastMaintenanceAt || now - lastMaintenanceAt >= 6 * 60 * 60 * 1000) {
        await processMaintenanceJob(store, runtime, statusService);
        lastMaintenanceAt = now;
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
      logger.warn('chatluna service is unavailable, skip memory-v3 middleware registration.');
      return;
    }

    chain
      .middleware('qqbot_memory_v3', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MemoryMiddlewareContextLike;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const address = buildMemoryAddress(session, context);
        const inputText = resolveInputText(session, context);
        if (!address || !inputText) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        await store.upsertAddress(address);
        const flags = await store.getUserFlags(address.userKey);
        if (runtime.writeEnabled && flags.writeEnabled) {
          await store.queueJob(
            'extract',
            {
              address,
              maxMessages: runtime.extractMessageBatch,
            },
            Date.now() + runtime.extractIdleMs,
          );
        }

        if (runtime.readEnabled && flags.readEnabled) {
          try {
            await injectMemoryContext(store, runtime, address, inputText);
          } catch (error) {
            logger.warn('memory recall skipped: %s', error instanceof Error ? error.message : String(error));
          }
        }

        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('read_chat_message')
      .before('lifecycle-handle_command');

    chain
      .middleware('qqbot_prompt_envelope', async (rawSession, rawContext) => {
        const session = rawSession as Session;
        const context = rawContext as MemoryMiddlewareContextLike;
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
      .after('qqbot_memory_v3')
      .after('qqbot_sticker_policy')
      .after('qqbot_reply_transport_policy')
      .after('chatluna_time_context')
      .before('lifecycle-handle_command');

    void (async () => {
      const recovered = await store.requeueStaleProcessingJobs(runtime.jobLockTimeoutMs);
      if (recovered > 0) {
        logger.warn('memory recovered %d stale processing jobs after startup', recovered);
      }
      ctx.setInterval(() => void tick(), 10_000);
      await tick();
    })().catch((error) => {
      logger.warn('memory startup recovery failed: %s', error instanceof Error ? error.message : String(error));
      ctx.setInterval(() => void tick(), 10_000);
      void tick();
    });
  });
}
