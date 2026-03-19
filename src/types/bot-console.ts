export type ServiceAction = 'start' | 'stop' | 'restart' | 'enable';

export type BotServiceUnit =
  | 'qqbot.target'
  | 'qqbot-koishi.service'
  | 'qqbot-stack.service'
  | 'qqbot-voice-tts.service';

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
}
