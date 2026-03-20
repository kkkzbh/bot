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

// ─── Bot Console State ────────────────────────────────────────────────────────

export interface BotConsoleState {
  env: Record<string, string>;
  services: BotServiceStatus[];
  presets: PresetSummary[];
  defaultPreset: string;
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

export interface SavePresetResponse {
  preset: PresetDocument;
  restartRequired: boolean;
}

export interface ServiceActionResponse {
  status: BotServiceStatus;
}

export interface GetRecentLogsResponse {
  lines: string[];
}
