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

export type PresetSource = "runtime" | "bundled";

export interface BotConsoleEnvFilesState {
  mode: "single" | "layered";
  baseFile: string | null;
  overrideFile: string | null;
  editTarget: string;
}

export interface PresetPrompt {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface PresetSummary {
  name: string;
  path: string;
  source: PresetSource;
}

export interface PresetDocument {
  name: string;
  originalName?: string;
  path?: string;
  source?: PresetSource;
  keywords: string[];
  prompts: PresetPrompt[];
  raw?: string;
}

export type BotConsoleModelTabId = "siliconflow" | "openai" | "copilot";
export type BotConsoleAuthKind = "manual" | "oauth_device";
export type BotConsoleAuthStatus = "unauthenticated" | "pending" | "ready" | "expired" | "error";

export interface CopilotAuthAttempt {
  attemptId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSec: number;
  nextPollAt: number;
  state: "pending" | "authorized" | "expired" | "failed" | "cancelled";
  error: string | null;
}

export interface BotConsoleBuiltinModelTab {
  id: BotConsoleModelTabId;
  title: string;
  provider: "siliconflow" | "openai";
  strategyId: "siliconflow-kimi-main-chat" | "openai-gpt54-main-chat" | "copilot-github-oauth-main-chat";
  requestMode: "chat_completions" | "responses";
  structuredOutputProtocol: "chat_completions_json_schema" | "responses_text_format";
  description: string;
  modelHint: string;
  authKind: BotConsoleAuthKind;
  authStatus: BotConsoleAuthStatus;
  accountLabel?: string | null;
  authError?: string | null;
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
  | "QQBOT_REALTIME_MESSAGE_ENABLED"
  | "QQ_VOICE_INPUT_ENABLED"
  | "QQ_VOICE_OUTPUT_ENABLED"
  | "CHAT_NATURAL_TRIGGER_ENABLED"
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
  envFiles: BotConsoleEnvFilesState;
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

export interface BotConsoleMemoryScopeSummary {
  scopeType: "user" | "user_group";
  scopeKey: string;
  platform: string | null;
  botSelfId: string | null;
  userId: string | null;
  groupId: string | null;
  label: string;
  profileItemCount: number;
  episodeCount: number;
  latestSeenAt: number | null;
}

export interface BotConsoleMemoryProfileItem {
  id: number;
  scopeType: "user" | "user_group";
  scopeKey: string;
  kind: "identity" | "preference" | "trait" | "boundary" | "plan" | "relationship";
  topicKey: string;
  content: string;
  keywords: string[];
  importance: number;
  confidence: number;
  firstSeenAt: number;
  lastSeenAt: number;
  hasEmbedding: boolean;
  archived: boolean;
}

export interface BotConsoleMemoryEpisodeItem {
  id: number;
  scopeType: "user" | "user_group";
  scopeKey: string;
  title: string;
  summary: string;
  keywords: string[];
  importance: number;
  confidence: number;
  periodStart: number | null;
  periodEnd: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastAccessedAt: number | null;
  hasEmbedding: boolean;
  archived: boolean;
}

export interface BotConsoleMemoryJobItem {
  id: number;
  jobType: "extract" | "embed";
  status: "pending" | "processing";
  scopeType: "user" | "user_group" | null;
  scopeKey: string | null;
  conversationId: string | null;
  retryCount: number;
  nextRunAt: number;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}

export interface BotConsoleMemorySummary {
  scopeCount: number;
  userScopeCount: number;
  userGroupScopeCount: number;
  profileItemCount: number;
  episodeCount: number;
  pendingJobs: number;
  processingJobs: number;
}

export interface BotConsoleMemoryState {
  available: boolean;
  summary: BotConsoleMemorySummary;
  scopes: BotConsoleMemoryScopeSummary[];
  profileItems: BotConsoleMemoryProfileItem[];
  episodes: BotConsoleMemoryEpisodeItem[];
  jobs: BotConsoleMemoryJobItem[];
}

export interface BotConsoleProbeResponse {
  target: "embedding";
  memoryV2: MemoryV2ProbeResult;
}

export interface GetMemoryStateResponse extends BotConsoleMemoryState {}

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

export interface CopilotAuthState {
  authKind: "oauth_device";
  authStatus: BotConsoleAuthStatus;
  accountLabel: string | null;
  authError: string | null;
  attempt: CopilotAuthAttempt | null;
}

export interface CopilotAuthStartResponse extends CopilotAuthState {}
export interface CopilotAuthPollResponse extends CopilotAuthState {}
export interface CopilotAuthStatusResponse extends CopilotAuthState {}
export interface CopilotAuthCancelResponse extends CopilotAuthState {}
export interface CopilotAuthLogoutResponse extends CopilotAuthState {}

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

export interface ClearConversationHistoryResponse {
  result: ClearConversationHistoryResult;
}

export interface DeleteConversationRoomResponse {
  result: DeleteConversationRoomResult;
}
