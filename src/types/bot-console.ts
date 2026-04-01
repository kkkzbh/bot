import type { MemoryV2ProbeResult, MemoryV2StatusSnapshot } from './memory-v2.js';
import type {
  ClearConversationHistoryResult,
  ClearConversationHistoryTarget,
  ConsoleFeatureScope,
  DeleteConversationRoomResult,
  DeleteConversationRoomTarget,
  FeatureOverrideInput,
  FeatureScopeOverrideRecord,
} from './feature-policy.js';
import type {
  BotConsoleToolPolicyState,
  ToolOverrideInput,
  ToolOverrideRecord,
} from './tool-policy.js';

export type ServiceAction = 'start' | 'stop' | 'restart' | 'enable';

export type BotServiceUnit =
  | 'qqbot.target'
  | 'qqbot-koishi.service'
  | 'qqbot-stack.service'
  | 'qqbot-voice-tts.service'
  | 'qqbot-voice-tts-tailnet.service';

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

export interface EnvPatch {
  [key: string]: string | null | undefined;
}

export type PresetSource = 'runtime' | 'bundled';

export interface BotConsoleEnvFilesState {
  mode: 'single' | 'layered';
  baseFile: string | null;
  overrideFile: string | null;
  editTarget: string;
}

export interface PresetPrompt {
  role: 'system' | 'user' | 'assistant' | 'tool';
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

export type BotConsoleModelTabId = 'siliconflow' | 'openai' | 'copilot';
export type BotConsoleAuthKind = 'manual' | 'oauth_device';
export type BotConsoleAuthStatus = 'unauthenticated' | 'pending' | 'ready' | 'expired' | 'error';

export interface CopilotAuthAttempt {
  attemptId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSec: number;
  nextPollAt: number;
  state: 'pending' | 'authorized' | 'expired' | 'failed' | 'cancelled';
  error: string | null;
}

export interface BotConsoleBuiltinModelTab {
  id: BotConsoleModelTabId;
  title: string;
  provider: 'siliconflow' | 'openai';
  strategyId: 'siliconflow-kimi-main-chat' | 'openai-gpt54-main-chat' | 'copilot-github-oauth-main-chat';
  requestMode: 'chat_completions' | 'responses';
  structuredOutputProtocol: 'chat_completions_json_schema' | 'responses_text_format';
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

export interface BotConsoleState {
  env: Record<string, string>;
  envFiles: BotConsoleEnvFilesState;
  services: BotServiceStatus[];
  presets: PresetSummary[];
  defaultPreset: string;
  featureScopes: ConsoleFeatureScope[];
  featureOverrides: FeatureScopeOverrideRecord[];
  conversationTargets: import('./feature-policy.js').ConversationTarget[];
  toolPolicy: BotConsoleToolPolicyState;
  modelTabs: BotConsoleModelTabsState;
  runtimeStatus: {
    memoryV2: MemoryV2StatusSnapshot;
  };
}

export interface BotConsoleMemoryScopeSummary {
  scopeType: 'user' | 'user_group';
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
  scopeType: 'user' | 'user_group';
  scopeKey: string;
  kind: import('./memory-v2.js').MemoryProfileKind;
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
  scopeType: 'user' | 'user_group';
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
  jobType: 'extract' | 'embed';
  status: 'pending' | 'processing';
  scopeType: 'user' | 'user_group' | null;
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

export interface BotConsoleBaseState {
  env: Record<string, string>;
  envFiles: BotConsoleEnvFilesState;
  services: BotServiceStatus[];
  presets: PresetSummary[];
  defaultPreset: string;
}

export interface BotConsoleProbeResult {
  target: 'embedding';
  memoryV2: MemoryV2ProbeResult;
}

export interface GetMemoryStateResponse extends BotConsoleMemoryState {}

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
  authKind: 'oauth_device';
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

export interface SaveFeatureOverridesRequest {
  overrides: FeatureOverrideInput[];
}

export interface SaveFeatureOverridesResponse {
  overrides: FeatureScopeOverrideRecord[];
}

export interface SaveToolOverridesRequest {
  overrides: ToolOverrideInput[];
}

export interface SaveToolOverridesResponse {
  overrides: ToolOverrideRecord[];
}

export interface ClearConversationHistoryRequest extends ClearConversationHistoryTarget {}

export interface ClearConversationHistoryResponse {
  result: ClearConversationHistoryResult;
}

export interface DeleteConversationRoomRequest extends DeleteConversationRoomTarget {}

export interface DeleteConversationRoomResponse {
  result: DeleteConversationRoomResult;
}
