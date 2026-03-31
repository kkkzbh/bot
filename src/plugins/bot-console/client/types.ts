// Client-side type definitions
// Mirrors src/types/bot-console.ts + src/types/memory-v2.ts without koishi dependency

export type ServiceAction = "start" | "stop" | "restart" | "enable";

export type BotServiceUnit =
  | "qqbot.target"
  | "qqbot-koishi.service"
  | "qqbot-stack.service"
  | "qqbot-voice-tts.service"
  | "qqbot-voice-tts-tailnet.service";

export interface BotServiceStatus {
  unit: BotServiceUnit;
  description: string;
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string;
  canStart: boolean;
  canStop: boolean;
  canRestart: boolean;
  canEnable: boolean;
}

export interface PresetPrompt {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface PresetSummary {
  name: string;
  path: string;
}

export interface PresetDocument {
  name: string;
  originalName?: string;
  path?: string;
  keywords: string[];
  prompts: PresetPrompt[];
  raw?: string;
}

export type BotConsoleModelTabId = "siliconflow" | "openai";

export interface BotConsoleBuiltinModelTab {
  id: BotConsoleModelTabId;
  title: string;
  provider: "siliconflow" | "openai";
  strategyId: "siliconflow-kimi-main-chat" | "openai-gpt54-main-chat";
  requestMode: "chat_completions" | "responses";
  structuredOutputProtocol: "chat_completions_json_schema" | "responses_text_format";
  description: string;
  modelHint: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

export interface BotConsoleModelTabsState {
  activeTab: BotConsoleModelTabId;
  tabs: BotConsoleBuiltinModelTab[];
}

export interface ReorderPresetsResponse {
  presets: PresetSummary[];
}

// ─── Memory V2 ───────────────────────────────────────────────────────────────

export type MemoryStatusState = "never" | "success" | "failed";
export type MemoryStatusSource = "runtime" | "probe" | null;

export interface MemoryV2QueueSummary {
  extractPending: number;
  extractProcessing: number;
  embedPending: number;
  embedProcessing: number;
}

export interface MemoryV2OperationSnapshot {
  configured: boolean;
  state: MemoryStatusState;
  lastSource: MemoryStatusSource;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface MemoryV2StatusSnapshot {
  available: boolean;
  enabled: boolean;
  extractConfigured: boolean;
  embedConfigured: boolean;
  extractModel: string;
  embedBaseUrl: string;
  embedModel: string;
  jobs: MemoryV2QueueSummary;
  lastArchiveAt: number | null;
  extract: MemoryV2OperationSnapshot;
  embed: MemoryV2OperationSnapshot;
}

export interface MemoryV2ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
  snapshot: MemoryV2StatusSnapshot;
}

// ─── Scoped Feature Policy ────────────────────────────────────────────────────

export type ScopedFeatureKey =
  | "QQ_VOICE_ENABLED"
  | "QQ_VOICE_INPUT_ENABLED"
  | "QQ_VOICE_OUTPUT_ENABLED"
  | "CHAT_NATURAL_TRIGGER_ENABLED"
  | "TASK_AUTOMATION_INTENT_ENABLED"
  | "QQBOT_REPLY_INTERRUPT_ENABLED";

export type FeatureScopeKind = "private_default" | "group";
export type ConversationTargetScopeKind = "private" | "group";

export interface FeatureScopeOverrideRecord {
  id: number;
  featureKey: ScopedFeatureKey;
  scopeKind: FeatureScopeKind;
  scopeId: string;
  enabled: number;
  updatedAt: number;
}

export interface FeatureOverrideInput {
  featureKey: ScopedFeatureKey;
  scopeKind: FeatureScopeKind;
  scopeId: string;
  enabled: boolean;
}

export interface ConsoleFeatureScope {
  scopeKind: FeatureScopeKind;
  scopeId: string;
  roomId: number | null;
  roomName: string;
  groupId: string | null;
  conversationId: string | null;
  visibility: string | null;
  updatedAt: number | null;
}

export interface ConversationTarget {
  roomId: number;
  roomName: string;
  scopeKind: ConversationTargetScopeKind;
  scopeId: string;
  groupId: string | null;
  conversationId: string;
  updatedAt: number | null;
}

export interface ClearConversationHistoryResult {
  ok: true;
  roomId: number;
  conversationId: string;
  deletedMessages: number;
  updatedAt: number;
}

export interface DeleteConversationRoomResult {
  ok: true;
  roomId: number;
  conversationId: string;
  deletedMessages: number;
  deletedConversation: boolean;
  deletedRoom: boolean;
  clearedDefaultUsers: number;
  updatedAt: number;
}

// ─── Tool Policy ─────────────────────────────────────────────────────────────

export type ToolRouteProfile = "agent" | "automation";
export type ToolPolicyScopeKind =
  | "global_default"
  | "private_default"
  | "private_conversation"
  | "group";
export type ToolCompatibility = "compatible" | "conditional" | "incompatible";
export type ToolRiskLevel = "low" | "medium" | "high";
export type ToolCategoryKey = "builtin" | "file" | "web" | "geo";
export type ToolOverrideMode = "inherit" | "enabled" | "disabled";

export interface ToolCatalogEntry {
  toolName: string;
  title: string;
  category: ToolCategoryKey;
  description: string;
  compatibility: ToolCompatibility;
  compatibilityNote: string;
  hardDependencies: string[];
  relatedTools: string[];
  riskLevel: ToolRiskLevel;
  source?: "project" | "chatluna_runtime";
  availableRoutes: ToolRouteProfile[];
  defaultEnabledByRoute?: Record<ToolRouteProfile, boolean>;
}

export interface ToolPolicyScope {
  scopeKind: ToolPolicyScopeKind;
  scopeId: string;
  roomId: number | null;
  roomName: string;
  groupId: string | null;
  conversationId: string | null;
  visibility: string | null;
  updatedAt: number | null;
}

export interface ToolPolicyOverrideRecord {
  id: number;
  toolName: string;
  routeProfile: ToolRouteProfile;
  scopeKind: ToolPolicyScopeKind;
  scopeId: string;
  enabled: number;
  updatedAt: number;
}

export interface ToolPolicyOverrideInput {
  toolName: string;
  routeProfile: ToolRouteProfile;
  scopeKind: ToolPolicyScopeKind;
  scopeId: string;
  enabled: boolean;
}

export interface BotConsoleToolPolicyState {
  routeProfiles: ToolRouteProfile[];
  catalog: ToolCatalogEntry[];
  routeProfileInfo?: Array<{
    id: ToolRouteProfile;
    title: string;
    description: string;
    note?: string;
  }>;
  defaultScopes?: Array<{
    scopeKind: ToolPolicyScopeKind;
    scopeId: string;
    title: string;
    description: string;
  }>;
  scopes: ToolPolicyScope[];
  overrides: ToolPolicyOverrideRecord[];
  conversationTargets?: ConversationTarget[];
}

// ─── Bot Console State ────────────────────────────────────────────────────────

export interface BotConsoleState {
  env: Record<string, string>;
  services: BotServiceStatus[];
  presets: PresetSummary[];
  defaultPreset: string;
  featureScopes: ConsoleFeatureScope[];
  featureOverrides: FeatureScopeOverrideRecord[];
  conversationTargets: ConversationTarget[];
  toolPolicy?: BotConsoleToolPolicyState | null;
  modelTabs: BotConsoleModelTabsState;
  runtimeStatus: {
    memoryV2: MemoryV2StatusSnapshot;
  };
}

export interface BotConsoleProbeResponse {
  target: "embedding";
  memoryV2: MemoryV2ProbeResult;
}

export interface SaveEnvResponse {
  env: Record<string, string>;
  restartRequired: boolean;
}

export interface SaveModelTabsRequest {
  activeTab: BotConsoleModelTabId;
  tabs: BotConsoleBuiltinModelTab[];
}

export interface SaveModelTabsResponse {
  env: Record<string, string>;
  modelTabs: BotConsoleModelTabsState;
  restartRequired: boolean;
}

export interface SavePresetResponse {
  preset: PresetDocument;
  restartRequired: boolean;
}

export interface SaveFeatureOverridesResponse {
  overrides: FeatureScopeOverrideRecord[];
}

export interface SaveToolOverridesResponse {
  overrides: ToolPolicyOverrideRecord[];
}

export interface ServiceActionResponse {
  status: BotServiceStatus;
}

export interface GetRecentLogsResponse {
  lines: string[];
}

export interface ClearConversationHistoryResponse {
  result: ClearConversationHistoryResult;
}

export interface DeleteConversationRoomResponse {
  result: DeleteConversationRoomResult;
}
