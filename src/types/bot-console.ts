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

export interface PresetPrompt {
  role: 'system' | 'user' | 'assistant' | 'tool';
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

export interface BotConsoleState {
  env: Record<string, string>;
  services: BotServiceStatus[];
  presets: PresetSummary[];
  defaultPreset: string;
  featureScopes: ConsoleFeatureScope[];
  featureOverrides: FeatureScopeOverrideRecord[];
  conversationTargets: import('./feature-policy.js').ConversationTarget[];
  runtimeStatus: {
    memoryV2: MemoryV2StatusSnapshot;
  };
}

export interface BotConsoleBaseState {
  env: Record<string, string>;
  services: BotServiceStatus[];
  presets: PresetSummary[];
  defaultPreset: string;
}

export interface BotConsoleProbeResult {
  target: 'embedding';
  memoryV2: MemoryV2ProbeResult;
}

export interface GetRecentLogsResponse {
  lines: string[];
}

export interface SaveFeatureOverridesRequest {
  overrides: FeatureOverrideInput[];
}

export interface SaveFeatureOverridesResponse {
  overrides: FeatureScopeOverrideRecord[];
}

export interface ClearConversationHistoryRequest extends ClearConversationHistoryTarget {}

export interface ClearConversationHistoryResponse {
  result: ClearConversationHistoryResult;
}

export interface DeleteConversationRoomRequest extends DeleteConversationRoomTarget {}

export interface DeleteConversationRoomResponse {
  result: DeleteConversationRoomResult;
}
