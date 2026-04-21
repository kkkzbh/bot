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

export interface MainChatConsoleDescription {
  description: string;
  modelHint: string;
}

export interface CopilotModelOption {
  modelId: string;
  label: string;
  rateLabel: string;
  requestMode: MainChatRequestMode;
  structuredOutputProtocol: StructuredOutputProtocol;
  deprecated?: boolean;
}

export interface MainChatProviderStrategy {
  id: 'siliconflow-kimi-main-chat' | 'openai-gpt54-main-chat' | 'copilot-github-oauth-main-chat';
  platform: MainChatProvider;
  supportsModel: (model?: string | null) => boolean;
  buildRequestOverride: (model?: string | null) => Record<string, unknown> | null;
  buildStructuredOutputSpec: (model?: string | null) => MainChatStructuredOutputSpec;
  normalizeModel: (model?: string | null) => string | null;
  transportModel: (model?: string | null) => string | null;
  resolveRequestMode: (model?: string | null) => MainChatRequestMode;
  resolveStructuredOutputProtocol: (model?: string | null) => StructuredOutputProtocol;
  describeForConsole: (model?: string | null) => MainChatConsoleDescription;
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
export const SILICONFLOW_DEFAULT_MODEL = 'Pro/moonshotai/Kimi-K2.5';
export const COPILOT_BRIDGE_DEFAULT_BASE_URL = 'http://127.0.0.1:5140/api/internal/copilot/v1';
export const COPILOT_DEFAULT_MODEL = 'openai/gpt-5.4-mini';
export const MAIN_CHAT_BUILTIN_TAB_IDS = ['siliconflow', 'openai', 'copilot'] as const satisfies readonly MainChatBuiltinTabId[];
export const COPILOT_MODEL_OPTIONS = [
  {
    modelId: 'gpt-5.4',
    label: 'GPT-5.4',
    rateLabel: '1x',
    requestMode: 'responses',
    structuredOutputProtocol: 'responses_text_format',
  },
  {
    modelId: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    rateLabel: '0.33x',
    requestMode: 'responses',
    structuredOutputProtocol: 'responses_text_format',
  },
  {
    modelId: 'gpt-5-mini',
    label: 'GPT-5 mini',
    rateLabel: '0x',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'chat_completions_json_schema',
  },
  {
    modelId: 'gpt-4.1',
    label: 'GPT-4.1',
    rateLabel: '0x',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'chat_completions_json_schema',
  },
  {
    modelId: 'gpt-4o',
    label: 'GPT-4o',
    rateLabel: '0x',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'chat_completions_json_schema',
    deprecated: true,
  },
  {
    modelId: 'claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    rateLabel: '0.33x',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'chat_completions_json_schema',
  },
  {
    modelId: 'claude-sonnet-4.5',
    label: 'Claude Sonnet 4.5',
    rateLabel: '1x',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'chat_completions_json_schema',
  },
  {
    modelId: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash',
    rateLabel: '0.33x',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'chat_completions_json_schema',
  },
  {
    modelId: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro',
    rateLabel: '1x',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'chat_completions_json_schema',
  },
] as const satisfies readonly CopilotModelOption[];

export function formatCopilotModelOptionLabel(option: CopilotModelOption): string {
  return option.deprecated
    ? `${option.label} (${option.rateLabel}, 可能弃用)`
    : `${option.label} (${option.rateLabel})`;
}

export function getCopilotModelOption(model?: string | null): CopilotModelOption | null {
  const normalized = normalizeCopilotModelId(model);
  if (!normalized) return null;
  return COPILOT_MODEL_OPTIONS.find((option) => option.modelId === normalized) ?? null;
}

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
        requestMode: this.resolveRequestMode(model),
        structuredOutputProtocol: this.resolveStructuredOutputProtocol(model),
        finalResponseSchema: buildStructuredReplyJsonSchema(),
        overrideRequestParams: this.buildRequestOverride(model),
      };
    },
    normalizeModel(model) {
      return normalizeSiliconFlowKimiK25ModelId(model);
    },
    transportModel(model) {
      return normalizeSiliconFlowKimiK25ModelId(model);
    },
    resolveRequestMode() {
      return 'chat_completions';
    },
    resolveStructuredOutputProtocol() {
      return 'chat_completions_json_schema';
    },
    describeForConsole() {
      return {
        description: '当前主聊天固定走硅基流动 provider，接口地址锁定为官方 API，默认使用 Kimi-K2.5。',
        modelHint: '当前仅支持 Pro/moonshotai/Kimi-K2.5。',
      };
    },
  },
  {
    id: 'openai-gpt54-main-chat',
    platform: 'openai',
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
        requestMode: this.resolveRequestMode(model),
        structuredOutputProtocol: this.resolveStructuredOutputProtocol(model),
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
    resolveRequestMode() {
      return 'chat_completions';
    },
    resolveStructuredOutputProtocol() {
      return 'chat_completions_json_schema';
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
    supportsModel: isCopilotModelId,
    buildRequestOverride(model) {
      if (!isCopilotModelId(model)) return null;
      const canonicalModel = this.normalizeModel(model);
      const transportModel = this.transportModel(canonicalModel);
      const requestMode = this.resolveRequestMode(canonicalModel);
      return {
        ...(requestMode === 'responses' ? { qqbot_request_mode: 'responses' } : {}),
        qqbot_canonical_model: canonicalModel,
        qqbot_transport_model: transportModel,
        qqbot_tool_profile: 'qqbot_openai_main_chat',
      };
    },
    buildStructuredOutputSpec(model) {
      return {
        requestMode: this.resolveRequestMode(model),
        structuredOutputProtocol: this.resolveStructuredOutputProtocol(model),
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
    resolveRequestMode(model) {
      return getCopilotRequestMode(model);
    },
    resolveStructuredOutputProtocol(model) {
      return getCopilotStructuredOutputProtocol(model);
    },
    describeForConsole(model) {
      const option = getCopilotModelOption(model);
      const mode = this.resolveRequestMode(model) === 'responses' ? 'Responses API' : 'chat/completions';
      return {
        description: `当前按 GitHub Copilot OAuth 设备登录接入，运行时通过本地 bridge 使用 ${option ? formatCopilotModelOptionLabel(option) : '固定模型目录'}，并走 ${mode}。`,
        modelHint: option
          ? `当前固定从下拉选择，已选 ${formatCopilotModelOptionLabel(option)}。`
          : '当前固定从下拉选择 Copilot 模型，并按模型静态路由到 responses 或 chat/completions。',
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
    id === 'siliconflow'
      ? definition.defaultBaseUrl
      : (
        trimOptionalEnvValue(env[definition.envKeys.baseUrl]) ||
        (activeTab === id ? trimOptionalEnvValue(env.CHATLUNA_BASE_URL) : null) ||
        definition.defaultBaseUrl
      );
  const apiKey =
    trimOptionalEnvValue(env[definition.envKeys.apiKey]) ||
    (activeTab === id ? trimOptionalEnvValue(env.CHATLUNA_API_KEY) : null) ||
    (id === 'openai' ? WYZAI_DEFAULT_API_KEY : '');
  const defaultModel =
    trimOptionalEnvValue(env[definition.envKeys.defaultModel]) ||
    (activeTab === id ? trimOptionalEnvValue(env.CHATLUNA_DEFAULT_MODEL) : null) ||
    definition.defaultModel;
  const canonicalModel = strategy.normalizeModel(defaultModel) ?? definition.defaultModel;
  const { description, modelHint } = strategy.describeForConsole(canonicalModel);

  return {
    id,
    tabId: id,
    title: definition.title,
    provider: definition.provider,
    strategyId: strategy.id,
    requestMode: strategy.resolveRequestMode(canonicalModel),
    structuredOutputProtocol: strategy.resolveStructuredOutputProtocol(canonicalModel),
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
  const canonicalModel =
    strategy.normalizeModel(activeConfig.canonicalModel ?? activeConfig.defaultModel) ?? definition.defaultModel;
  const { description, modelHint } = strategy.describeForConsole(canonicalModel);

  return {
    tabId: activeTab,
    title: definition.title,
    provider: definition.provider,
    strategyId: strategy.id,
    requestMode: strategy.resolveRequestMode(canonicalModel),
    structuredOutputProtocol: strategy.resolveStructuredOutputProtocol(canonicalModel),
    authKind: activeTab === 'copilot' ? 'oauth_device' : 'manual',
    authStatus: activeConfig.apiKey.trim() ? 'ready' : activeTab === 'copilot' ? 'unauthenticated' : 'ready',
    accountLabel: null,
    authError: null,
    baseUrl: activeTab === 'siliconflow' ? definition.defaultBaseUrl : activeConfig.baseUrl.trim(),
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
    CHATLUNA_SILICONFLOW_BASE_URL: SILICONFLOW_DEFAULT_BASE_URL,
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
  const value = normalizeSiliconFlowKimiK25ModelId(model);
  if (!value) return false;
  return value === SILICONFLOW_DEFAULT_MODEL;
}

function normalizeSiliconFlowKimiK25ModelId(model?: string | null): string | null {
  const value = model?.trim();
  if (!value) return null;
  if (/^siliconflow\/pro\/moonshotai\/kimi-k2\.5$/iu.test(value)) return SILICONFLOW_DEFAULT_MODEL;
  if (/^pro\/moonshotai\/kimi-k2\.5$/iu.test(value)) return SILICONFLOW_DEFAULT_MODEL;
  return value;
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
  return getCopilotModelOption(model) != null;
}

function getCopilotRequestMode(model?: string | null): MainChatRequestMode {
  return getCopilotModelOption(model)?.requestMode ?? 'responses';
}

function getCopilotStructuredOutputProtocol(model?: string | null): StructuredOutputProtocol {
  return getCopilotModelOption(model)?.structuredOutputProtocol ?? 'responses_text_format';
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
    requestMode: strategy.resolveRequestMode(canonicalModel),
    canonicalModel,
    transportModel,
  };
}
