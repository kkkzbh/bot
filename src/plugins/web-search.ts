import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager';
import { StructuredTool, type ToolRunnableConfig } from '@langchain/core/tools';
import { Context, Logger, Schema } from 'koishi';
import { createProviders } from './web-search/providers.js';
import { WEB_SEARCH_INPUT_SCHEMA, extractSearchQueryInput, summarizeToolInput, type WebSearchToolInput } from './web-search/adapter.js';
import { buildSearchPlan } from './web-search/planner.js';
import { runSearch } from './web-search/orchestrator.js';
import type { SearchProviderId, SearchResult, SearchRuntimeConfig } from './web-search/types.js';

export const name = 'web-search';
export const inject = ['chatluna'];

const logger = new Logger(name);
const DEFAULT_TOP_K = 5;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_PROVIDERS: SearchProviderId[] = ['bing-web', 'duckduckgo-lite', 'wikipedia'];

export interface Config {
  enabled?: boolean;
  topK?: number;
  timeoutMs?: number;
  providers?: SearchProviderId[] | string;
  llmBaseURL?: string;
  llmApiKey?: string;
  llmModel?: string;
  plannerEnabled?: boolean;
  rerankEnabled?: boolean;
  acgnExtensionEnabled?: boolean;
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用本地 web_search 插件。'),
  topK: Schema.number().min(1).max(10).default(DEFAULT_TOP_K).description('返回结果条数。'),
  timeoutMs: Schema.natural().default(DEFAULT_TIMEOUT_MS).description('单次 provider 请求超时（毫秒）。'),
  providers: Schema.union([
    Schema.array(
      Schema.union([
        Schema.const('bing-web'),
        Schema.const('duckduckgo-lite'),
        Schema.const('wikipedia'),
        Schema.const('moegirl'),
      ]),
    )
      .role('select')
      .description('启用的搜索 provider。'),
    Schema.string().description('启用的搜索 provider，逗号分隔。'),
  ]).description('启用的搜索 provider 列表。'),
  llmBaseURL: Schema.string().default('').description('搜索规划与重排使用的 OpenAI 兼容 Base URL。'),
  llmApiKey: Schema.string().default('').description('搜索规划与重排使用的 API Key。'),
  llmModel: Schema.string().default('').description('搜索规划与重排使用的模型。'),
  plannerEnabled: Schema.boolean().default(true).description('是否启用 LLM 搜索规划。'),
  rerankEnabled: Schema.boolean().default(true).description('是否启用 LLM 二次重排。'),
  acgnExtensionEnabled: Schema.boolean().default(false).description('是否启用 ACGN 扩展 provider。'),
});

type HotfixToolDescriptor = {
  createTool: (params: unknown) => unknown;
  selector: () => boolean;
};

type PlatformLike = {
  registerTool?: (name: string, tool: HotfixToolDescriptor) => unknown;
};

type ChatLunaLike = {
  platform?: PlatformLike;
};

type ContextWithChatLuna = Context & { chatluna?: ChatLunaLike };

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeProviders(raw: Config['providers']): SearchProviderId[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
    ? raw.split(',').map((item) => item.trim())
    : DEFAULT_PROVIDERS;

  const normalized = values.filter((item): item is SearchProviderId =>
    item === 'bing-web' || item === 'duckduckgo-lite' || item === 'wikipedia' || item === 'moegirl',
  );

  const unique = [...new Set(normalized)];
  return unique.length ? unique : DEFAULT_PROVIDERS;
}

function toRuntimeConfig(config: Config): SearchRuntimeConfig {
  const topK = Number(config.topK ?? DEFAULT_TOP_K);
  const timeoutMs = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    topK: Number.isFinite(topK) ? clampInteger(topK, 1, 10) : DEFAULT_TOP_K,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(3_000, Math.floor(timeoutMs)) : DEFAULT_TIMEOUT_MS,
    providers: normalizeProviders(config.providers),
    acgnExtensionEnabled: config.acgnExtensionEnabled === true,
    llm: {
      baseURL: String(config.llmBaseURL ?? '').trim(),
      apiKey: String(config.llmApiKey ?? '').trim(),
      model: String(config.llmModel ?? '').trim(),
      plannerEnabled: config.plannerEnabled !== false,
      rerankEnabled: config.rerankEnabled !== false,
    },
  };
}

function formatToolResults(results: SearchResult[]): string {
  return JSON.stringify(
    results.map(({ title, url, description, content, source, evidence, opened }) => ({
      title,
      url,
      description,
      ...(content ? { content } : {}),
      ...(source ? { source } : {}),
      ...(evidence?.length ? { evidence } : {}),
      ...(opened ? { opened } : {}),
    })),
    null,
    2,
  );
}

class WebSearchTool extends StructuredTool<typeof WEB_SEARCH_INPUT_SCHEMA, WebSearchToolInput, WebSearchToolInput, string> {
  name = 'web_search';
  description =
    'A reliable web search tool that can search, open result pages, read page content, and return a JSON array with title, url, description, and optional content.';
  schema = WEB_SEARCH_INPUT_SCHEMA;

  constructor(private runtime: SearchRuntimeConfig) {
    super();
  }

  protected async _call(
    input: WebSearchToolInput,
    _runManager?: CallbackManagerForToolRun,
    _parentConfig?: ToolRunnableConfig,
  ): Promise<string> {
    const originalQuery = extractSearchQueryInput(input);
    if (!originalQuery) {
      logger.warn('web_search received empty or unparseable input: %s', summarizeToolInput(input));
      return '[]';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.runtime.timeoutMs);
    try {
      const plan = await buildSearchPlan(originalQuery, this.runtime, controller.signal);
      const results = await runSearch(plan, this.runtime, createProviders(), controller.signal);
      return formatToolResults(results);
    } finally {
      clearTimeout(timer);
    }
  }
}

function registerWebSearch(platform: PlatformLike | undefined, runtime: SearchRuntimeConfig): boolean {
  if (!platform?.registerTool) return false;
  platform.registerTool('web_search', {
    createTool: () => new WebSearchTool(runtime),
    selector: () => true,
  });
  return true;
}

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return;

  const runtime = toRuntimeConfig(config);
  let registered = false;

  const ensureRegistered = (trigger: string) => {
    if (registered) return;
    const platform = (ctx as ContextWithChatLuna).chatluna?.platform;
    if (!registerWebSearch(platform, runtime)) {
      if (trigger === 'ready') {
        logger.warn('chatluna platform not available yet for web_search registration.');
      }
      return;
    }

    registered = true;
    logger.info('registered local web_search plugin (topK=%d providers=%s).', runtime.topK, runtime.providers.join(','));
  };

  ctx.on('ready', () => ensureRegistered('ready'));
  ctx.setInterval(() => ensureRegistered('interval'), 15_000);
}
