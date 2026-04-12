import { buildStructuredReplyJsonSchema } from './structured-reply-schema.js';

export type MainChatBuiltinTabId = 'siliconflow' | 'openai' | 'copilot';
export type MainChatProvider = 'siliconflow' | 'openai';
export type MainChatRequestMode = 'chat_completions' | 'responses';
export type StructuredOutputProtocol = 'chat_completions_json_schema' | 'responses_text_format';
export type MainChatAuthKind = 'manual' | 'oauth_device';
export type MainChatAuthStatus = 'unauthenticated' | 'pending' | 'ready' | 'expired' | 'error';

export interface MainChatTabEnvKeys {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

export interface BuiltinTabDefinition {
  id: MainChatBuiltinTabId;
  title: string;
  provider: MainChatProvider;
  envKeys: MainChatTabEnvKeys;
  defaultBaseUrl: string;
  defaultModel: string;
  strategyId: MainChatProviderStrategy['id'];
}

export interface MainChatStructuredOutputSpec {
  requestMode: MainChatRequestMode;
  structuredOutputProtocol: StructuredOutputProtocol;
  finalResponseSchema: Record<string, unknown>;
  overrideRequestParams: Record<string, unknown> | null;
  finalResponseInstruction?: string;
}

export interface MainChatProviderStrategy {
  id: 'siliconflow-kimi-main-chat' | 'openai-gpt54-main-chat' | 'copilot-github-oauth-main-chat';
  platform: MainChatProvider;
  requestMode: MainChatRequestMode;
  structuredOutputProtocol: StructuredOutputProtocol;
  supportsModel: (model?: string | null) => boolean;
  buildRequestOverride: (model?: string | null) => Record<string, unknown> | null;
  buildStructuredOutputSpec: (model?: string | null) => MainChatStructuredOutputSpec;
  normalizeModel: (model?: string | null) => string | null;
  transportModel: (model?: string | null) => string | null;
  describeForConsole: () => { description: string; modelHint: string };
}

export interface MainChatModelDescriptor {
  tabId: MainChatBuiltinTabId;
  provider: MainChatProvider;
  strategyId: MainChatProviderStrategy['id'];
  requestMode: MainChatRequestMode;
  canonicalModel: string;
  transportModel: string;
}

export interface MainChatRuntimeProfile {
  tabId: MainChatBuiltinTabId;
  title: string;
  provider: MainChatProvider;
  strategyId: MainChatProviderStrategy['id'];
  requestMode: MainChatRequestMode;
  structuredOutputProtocol: StructuredOutputProtocol;
  authKind: MainChatAuthKind;
  authStatus: MainChatAuthStatus;
  accountLabel?: string | null;
  authError?: string | null;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  canonicalModel: string;
  transportModel: string;
  description: string;
  modelHint: string;
}

export interface MainChatBuiltinTabState extends MainChatRuntimeProfile {
  id: MainChatBuiltinTabId;
}

export const WYZAI_DEFAULT_BASE_URL = 'https://shell.wyzai.top/v1';
export const WYZAI_DEFAULT_API_KEY = 'sk-AU2PaFWvQImSIbTtXkx9t286QyCgUUh8Ith5R0mBa9yOsr43';
export const OPENAI_DEFAULT_MODEL = 'openai/gpt-5.4-medium-thinking';
export const SILICONFLOW_DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';
export const SILICONFLOW_DEFAULT_MODEL = 'siliconflow/Pro/moonshotai/Kimi-K2.5';
export const COPILOT_BRIDGE_DEFAULT_BASE_URL = 'http://127.0.0.1:5140/api/internal/copilot/v1';
export const COPILOT_DEFAULT_MODEL = 'openai/gpt-5.4-mini';
export const MAIN_CHAT_BUILTIN_TAB_IDS = ['siliconflow', 'openai', 'copilot'] as const satisfies readonly MainChatBuiltinTabId[];

export const BUILTIN_MAIN_CHAT_TABS: readonly BuiltinTabDefinition[] = [
  {
    id: 'siliconflow',
    title: '硅基流动',
    provider: 'siliconflow',
    envKeys: {
      baseUrl: 'CHATLUNA_SILICONFLOW_BASE_URL',
      apiKey: 'CHATLUNA_SILICONFLOW_API_KEY',
      defaultModel: 'CHATLUNA_SILICONFLOW_DEFAULT_MODEL',
    },
    defaultBaseUrl: SILICONFLOW_DEFAULT_BASE_URL,
    defaultModel: SILICONFLOW_DEFAULT_MODEL,
    strategyId: 'siliconflow-kimi-main-chat',
  },
  {
    id: 'openai',
    title: 'OpenAI',
    provider: 'openai',
    envKeys: {
      baseUrl: 'CHATLUNA_OPENAI_BASE_URL',
      apiKey: 'CHATLUNA_OPENAI_API_KEY',
      defaultModel: 'CHATLUNA_OPENAI_DEFAULT_MODEL',
    },
    defaultBaseUrl: WYZAI_DEFAULT_BASE_URL,
    defaultModel: OPENAI_DEFAULT_MODEL,
    strategyId: 'openai-gpt54-main-chat',
  },
  {
    id: 'copilot',
    title: 'GitHub Copilot',
    provider: 'openai',
    envKeys: {
      baseUrl: 'CHATLUNA_COPILOT_BASE_URL',
      apiKey: 'CHATLUNA_COPILOT_API_KEY',
      defaultModel: 'CHATLUNA_COPILOT_DEFAULT_MODEL',
    },
    defaultBaseUrl: COPILOT_BRIDGE_DEFAULT_BASE_URL,
    defaultModel: COPILOT_DEFAULT_MODEL,
    strategyId: 'copilot-github-oauth-main-chat',
  },
] as const;

export const MAIN_CHAT_PROVIDER_STRATEGIES: readonly MainChatProviderStrategy[] = [
  {
    id: 'siliconflow-kimi-main-chat',
    platform: 'siliconflow',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'chat_completions_json_schema',
    supportsModel: isSiliconFlowKimiK25Model,
    buildRequestOverride(model) {
      if (!isSiliconFlowKimiK25Model(model)) return null;
      return {
        thinking: {
          type: 'disabled',
        },
      };
    },
    buildStructuredOutputSpec(model) {
      return {
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'chat_completions_json_schema',
        finalResponseSchema: buildStructuredReplyJsonSchema(),
        overrideRequestParams: this.buildRequestOverride(model),
      };
    },
    normalizeModel(model) {
      return model?.trim() || null;
    },
    transportModel(model) {
      return model?.trim() || null;
    },
    describeForConsole() {
      return {
        description: '当前主聊天固定走硅基流动 provider，默认保持现有 Kimi 主链路。',
        modelHint: '当前仅支持 SiliconFlow Kimi-K2.5 主聊天模型族。',
      };
    },
  },
  {
    id: 'openai-gpt54-main-chat',
    platform: 'openai',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'chat_completions_json_schema',
    supportsModel: isOpenAIGpt54ModelFamily,
    buildRequestOverride(model) {
      if (!isOpenAIGpt54ModelFamily(model)) return null;
      const canonicalModel = this.normalizeModel(model);
      const transportModel = this.transportModel(canonicalModel);
      return {
        qqbot_canonical_model: canonicalModel,
        qqbot_transport_model: transportModel,
        qqbot_tool_profile: 'qqbot_openai_main_chat',
        reasoning: {
          effort: resolveOpenAIGpt54ReasoningEffort(model),
        },
      };
    },
    buildStructuredOutputSpec(model) {
      return {
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'chat_completions_json_schema',
        finalResponseSchema: buildStructuredReplyJsonSchema(),
        overrideRequestParams: this.buildRequestOverride(model),
      };
    },
    normalizeModel(model) {
      return normalizeOpenAICanonicalModelId(model);
    },
    transportModel(model) {
      return normalizeProviderTransportModel(model);
    },
    describeForConsole() {
      return {
        description: '当前按 OpenAI 兼容 provider 处理，默认预填 wyzai + gpt-5.4-medium-thinking，并走 chat/completions 结构化输出。',
        modelHint: '推荐填写 openai/gpt-5.4-medium-thinking。当前 OpenAI Tab 默认接入 wyzai。',
      };
    },
  },
  {
    id: 'copilot-github-oauth-main-chat',
    platform: 'openai',
    requestMode: 'responses',
    structuredOutputProtocol: 'responses_text_format',
    supportsModel: isCopilotModelId,
    buildRequestOverride(model) {
      if (!isCopilotModelId(model)) return null;
      const canonicalModel = this.normalizeModel(model);
      const transportModel = this.transportModel(canonicalModel);
      return {
        qqbot_request_mode: 'responses',
        qqbot_canonical_model: canonicalModel,
        qqbot_transport_model: transportModel,
        qqbot_tool_profile: 'qqbot_openai_main_chat',
      };
    },
    buildStructuredOutputSpec(model) {
      return {
        requestMode: 'responses',
        structuredOutputProtocol: 'responses_text_format',
        finalResponseSchema: buildStructuredReplyJsonSchema(),
        overrideRequestParams: this.buildRequestOverride(model),
      };
    },
    normalizeModel(model) {
      return normalizeCopilotCanonicalModelId(model);
    },
    transportModel(model) {
      return normalizeCopilotModelId(model);
    },
    describeForConsole() {
      return {
        description: '当前按 GitHub Copilot OAuth 设备登录接入，运行时通过本地 bridge 交换 Copilot session token 并走 Responses API。',
        modelHint: '推荐填写 openai/gpt-5.4-mini。该 Tab 使用 GitHub device-flow OAuth，不再手填 PAT。',
      };
    },
  },
] as const;

export function getBuiltinMainChatTabDefinition(id: MainChatBuiltinTabId): BuiltinTabDefinition {
  const found = BUILTIN_MAIN_CHAT_TABS.find((item) => item.id === id);
  if (!found) {
    throw new Error(`Unknown main chat tab definition: ${id}`);
  }
  return found;
}

export function getMainChatProviderStrategy(id: MainChatProviderStrategy['id']): MainChatProviderStrategy {
  const found = MAIN_CHAT_PROVIDER_STRATEGIES.find((item) => item.id === id);
  if (!found) {
    throw new Error(`Unknown main chat provider strategy: ${id}`);
  }
  return found;
}

export function getMainChatProviderStrategyForTab(id: MainChatBuiltinTabId): MainChatProviderStrategy {
  return getMainChatProviderStrategy(getBuiltinMainChatTabDefinition(id).strategyId);
}

export function normalizeMainChatBuiltinTabId(value: unknown): MainChatBuiltinTabId {
  const normalized = String(value ?? '').trim();
  if (normalized === 'siliconflow' || normalized === 'openai' || normalized === 'copilot') {
    return normalized;
  }
  throw new Error(`不支持这个模型 Tab：${normalized || 'unknown'}`);
}

export function resolveMainChatRuntimeProfileFromEnv(env: Record<string, string> | NodeJS.ProcessEnv): MainChatRuntimeProfile {
  const activeTab = resolveMainChatActiveTabFromEnv(env);
  return resolveMainChatRuntimeProfileFromTabConfig(
    activeTab,
    MAIN_CHAT_BUILTIN_TAB_IDS.map((id) => resolveMainChatTabStateFromEnv(id, env)),
  );
}

export function resolveMainChatActiveTabFromEnv(env: Record<string, string> | NodeJS.ProcessEnv): MainChatBuiltinTabId {
  const raw = String(env.CHATLUNA_ACTIVE_TAB ?? '').trim();
  if (raw === 'openai' || raw === 'copilot') return raw;
  return 'siliconflow';
}

export function resolveMainChatTabStateFromEnv(
  id: MainChatBuiltinTabId,
  env: Record<string, string> | NodeJS.ProcessEnv,
): MainChatBuiltinTabState {
  const definition = getBuiltinMainChatTabDefinition(id);
  const strategy = getMainChatProviderStrategy(definition.strategyId);
  const activeTab = resolveMainChatActiveTabFromEnv(env);
  const baseUrl =
    trimOptionalEnvValue(env[definition.envKeys.baseUrl]) ||
    (activeTab === id ? trimOptionalEnvValue(env.CHATLUNA_BASE_URL) : null) ||
    definition.defaultBaseUrl;
  const apiKey =
    trimOptionalEnvValue(env[definition.envKeys.apiKey]) ||
    (activeTab === id ? trimOptionalEnvValue(env.CHATLUNA_API_KEY) : null) ||
    (id === 'openai' ? WYZAI_DEFAULT_API_KEY : '');
  const defaultModel =
    trimOptionalEnvValue(env[definition.envKeys.defaultModel]) ||
    (activeTab === id ? trimOptionalEnvValue(env.CHATLUNA_DEFAULT_MODEL) : null) ||
    definition.defaultModel;
  const canonicalModel = strategy.normalizeModel(defaultModel) ?? definition.defaultModel;
  const { description, modelHint } = strategy.describeForConsole();

  return {
    id,
    tabId: id,
    title: definition.title,
    provider: definition.provider,
    strategyId: strategy.id,
    requestMode: strategy.requestMode,
    structuredOutputProtocol: strategy.structuredOutputProtocol,
    authKind: id === 'copilot' ? 'oauth_device' : 'manual',
    authStatus: apiKey ? 'ready' : id === 'copilot' ? 'unauthenticated' : 'ready',
    accountLabel: null,
    authError: null,
    baseUrl,
    apiKey,
    defaultModel: canonicalModel,
    canonicalModel,
    transportModel: strategy.transportModel(canonicalModel) ?? canonicalModel,
    description,
    modelHint,
  };
}

export function resolveMainChatRuntimeProfileFromTabConfig(
  activeTab: MainChatBuiltinTabId,
  tabs: readonly (Pick<MainChatBuiltinTabState, 'id' | 'baseUrl' | 'apiKey' | 'defaultModel'> &
    Partial<Pick<MainChatBuiltinTabState, 'canonicalModel' | 'transportModel'>>)[],
): MainChatRuntimeProfile {
  const activeConfig = tabs.find((item) => item.id === activeTab);
  if (!activeConfig) {
    throw new Error(`缺少内置模型 Tab：${activeTab}`);
  }

  const definition = getBuiltinMainChatTabDefinition(activeTab);
  const strategy = getMainChatProviderStrategy(definition.strategyId);
  const { description, modelHint } = strategy.describeForConsole();
  const canonicalModel =
    strategy.normalizeModel(activeConfig.canonicalModel ?? activeConfig.defaultModel) ?? definition.defaultModel;

  return {
    tabId: activeTab,
    title: definition.title,
    provider: definition.provider,
    strategyId: strategy.id,
    requestMode: strategy.requestMode,
    structuredOutputProtocol: strategy.structuredOutputProtocol,
    authKind: activeTab === 'copilot' ? 'oauth_device' : 'manual',
    authStatus: activeConfig.apiKey.trim() ? 'ready' : activeTab === 'copilot' ? 'unauthenticated' : 'ready',
    accountLabel: null,
    authError: null,
    baseUrl: activeConfig.baseUrl.trim(),
    apiKey: activeConfig.apiKey.trim(),
    defaultModel: canonicalModel,
    canonicalModel,
    transportModel: strategy.transportModel(canonicalModel) ?? canonicalModel,
    description,
    modelHint,
  };
}

export function buildMainChatRuntimeEnvPatch(
  activeTab: MainChatBuiltinTabId,
  tabs: readonly (Pick<MainChatBuiltinTabState, 'id' | 'baseUrl' | 'apiKey' | 'defaultModel'> &
    Partial<Pick<MainChatBuiltinTabState, 'canonicalModel' | 'transportModel'>>)[],
): Record<string, string> {
  const runtimeProfile = resolveMainChatRuntimeProfileFromTabConfig(activeTab, tabs);
  const siliconflowTab = requireMainChatTabConfig(tabs, 'siliconflow');
  const openaiTab = requireMainChatTabConfig(tabs, 'openai');
  const copilotTab = requireMainChatTabConfig(tabs, 'copilot');

  return {
    CHATLUNA_ACTIVE_TAB: activeTab,
    CHATLUNA_PLATFORM: runtimeProfile.provider,
    CHATLUNA_BASE_URL: runtimeProfile.baseUrl,
    CHATLUNA_API_KEY: runtimeProfile.apiKey,
    CHATLUNA_DEFAULT_MODEL: runtimeProfile.canonicalModel,
    CHATLUNA_SILICONFLOW_BASE_URL: siliconflowTab.baseUrl.trim(),
    CHATLUNA_SILICONFLOW_API_KEY: siliconflowTab.apiKey.trim(),
    CHATLUNA_SILICONFLOW_DEFAULT_MODEL: (siliconflowTab.canonicalModel ?? siliconflowTab.defaultModel).trim(),
    CHATLUNA_OPENAI_BASE_URL: openaiTab.baseUrl.trim(),
    CHATLUNA_OPENAI_API_KEY: openaiTab.apiKey.trim(),
    CHATLUNA_OPENAI_DEFAULT_MODEL: (openaiTab.canonicalModel ?? openaiTab.defaultModel).trim(),
    CHATLUNA_COPILOT_BASE_URL: copilotTab.baseUrl.trim(),
    CHATLUNA_COPILOT_API_KEY: copilotTab.apiKey.trim(),
    CHATLUNA_COPILOT_DEFAULT_MODEL: (copilotTab.canonicalModel ?? copilotTab.defaultModel).trim(),
  };
}

export function isSupportedMainChatModelForTab(tabId: MainChatBuiltinTabId, model?: string | null): boolean {
  const strategy = getMainChatProviderStrategyForTab(tabId);
  const normalized = strategy.normalizeModel(model) ?? model ?? null;
  return strategy.supportsModel(normalized);
}

export function supportsStructuredReplyJsonSchema(model?: string | null): boolean {
  return MAIN_CHAT_PROVIDER_STRATEGIES.some((strategy) => strategy.supportsModel(model));
}

export function buildStructuredReplyModelOverride(model?: string | null): Record<string, unknown> | null {
  const strategy = resolveMainChatProviderStrategyForModel(model);
  return strategy?.buildRequestOverride(model) ?? null;
}

export function buildSiliconFlowKimiK25NonThinkingOverride(model?: string | null): Record<string, unknown> | null {
  if (!isSiliconFlowKimiK25Model(model)) return null;
  return getMainChatProviderStrategy('siliconflow-kimi-main-chat').buildRequestOverride(model);
}

export function buildStructuredReplyRequestSpec(args: {
  model?: string | null;
  profile?: MainChatRuntimeProfile | null;
  canMention?: boolean;
  canVoice?: boolean;
  canMeme?: boolean;
}): MainChatStructuredOutputSpec {
  const strategy = args.profile
    ? getMainChatProviderStrategy(args.profile.strategyId)
    : resolveMainChatProviderStrategyForModel(args.model) ?? getMainChatProviderStrategy('siliconflow-kimi-main-chat');
  const model = strategy.normalizeModel(args.model ?? args.profile?.canonicalModel ?? args.profile?.defaultModel ?? null);
  const baseSpec = strategy.buildStructuredOutputSpec(model);
  return {
    ...baseSpec,
    finalResponseSchema: buildStructuredReplyJsonSchema({
      canMention: args.canMention,
      canVoice: args.canVoice,
      canMeme: args.canMeme,
    }),
  };
}

function requireMainChatTabConfig<T extends Pick<MainChatBuiltinTabState, 'id'>>(tabs: readonly T[], id: MainChatBuiltinTabId): T {
  const found = tabs.find((item) => item.id === id);
  if (!found) {
    throw new Error(`缺少内置模型 Tab：${id}`);
  }
  return found;
}

function resolveMainChatProviderStrategyForModel(model?: string | null): MainChatProviderStrategy | null {
  const found = MAIN_CHAT_PROVIDER_STRATEGIES.find((strategy) =>
    strategy.supportsModel(strategy.normalizeModel(model) ?? model ?? null),
  );
  return found ?? null;
}

function isSiliconFlowKimiK25Model(model?: string | null): boolean {
  const value = model?.trim();
  if (!value) return false;
  return value.startsWith('siliconflow/') && /kimi-k2\.5/i.test(value);
}

function isOpenAIGpt54ModelFamily(model?: string | null): boolean {
  const value = normalizeOpenAICanonicalModelId(model);
  if (!value || !value.startsWith('openai/')) return false;
  const normalized = value.slice('openai/'.length);
  return /^gpt-5\.4(?:-(?:non|minimal|low|medium|high|xhigh)-thinking|-thinking)?$/i.test(normalized);
}

function normalizeOpenAICanonicalModelId(model?: string | null): string | null {
  const value = model?.trim();
  if (!value) return null;
  if (value.startsWith('openai/')) return value;
  if (value.startsWith('github-copilot/')) {
    const normalized = value.slice('github-copilot/'.length).trim();
    return normalized ? `openai/${normalized}` : null;
  }
  if (value.includes('/') && !value.startsWith('openai/')) return value;
  return `openai/${value}`;
}

function normalizeCopilotModelId(model?: string | null): string | null {
  const value = model?.trim();
  if (!value) return null;
  if (value.startsWith('openai/')) {
    return value.slice('openai/'.length).trim() || null;
  }
  if (value.startsWith('github-copilot/')) {
    return value.slice('github-copilot/'.length).trim() || null;
  }
  return value;
}

function normalizeCopilotCanonicalModelId(model?: string | null): string | null {
  const normalized = normalizeCopilotModelId(model);
  if (!normalized) return null;
  if (normalized.includes('/')) return normalized;
  return `openai/${normalized}`;
}

function normalizeProviderTransportModel(model?: string | null): string | null {
  const value = model?.trim();
  if (!value) return null;
  if (value.startsWith('openai/')) return value.slice('openai/'.length).trim() || null;
  return value;
}

function isCopilotModelId(model?: string | null): boolean {
  const normalized = normalizeCopilotModelId(model);
  if (!normalized) return false;
  if (normalized.includes('/')) return false;
  if (/\s/.test(normalized)) return false;
  if (normalized.includes('://')) return false;
  // Copilot bridge runs via Responses API. Some upstream Gemini 3.x preview ids
  // are advertised but fail hard on /responses with unsupported_api_for_model.
  if (/^gemini-3\./i.test(normalized)) return false;
  return true;
}

function resolveOpenAIGpt54ReasoningEffort(model?: string | null): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  const value = model?.trim().toLowerCase() ?? '';
  if (value.endsWith('-non-thinking')) return 'none';
  if (value.endsWith('-minimal-thinking')) return 'minimal';
  if (value.endsWith('-low-thinking')) return 'low';
  if (value.endsWith('-high-thinking')) return 'high';
  if (value.endsWith('-xhigh-thinking')) return 'xhigh';
  return 'medium';
}

function trimOptionalEnvValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

export function resolveMainChatModelDescriptor(args: {
  tabId: MainChatBuiltinTabId;
  model?: string | null;
}): MainChatModelDescriptor {
  const definition = getBuiltinMainChatTabDefinition(args.tabId);
  const strategy = getMainChatProviderStrategy(definition.strategyId);
  const canonicalModel = strategy.normalizeModel(args.model ?? definition.defaultModel) ?? definition.defaultModel;
  const transportModel = strategy.transportModel(canonicalModel) ?? canonicalModel;
  return {
    tabId: args.tabId,
    provider: definition.provider,
    strategyId: definition.strategyId,
    requestMode: strategy.requestMode,
    canonicalModel,
    transportModel,
  };
}
