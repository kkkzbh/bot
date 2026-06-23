import type {
  AffinityEventType,
  AffinityRandomDirection,
} from '../../types/affinity.js';

export interface AffinityRandomContextTurn {
  role: 'human' | 'ai';
  text: string;
  speakerName?: string | null;
  observedAt?: number | null;
  source: 'history' | 'realtime';
}

export interface AffinityRandomMemoryItem {
  direction: AffinityRandomDirection;
  messageText: string;
  contextSummary: string | null;
  responseSummary: string | null;
  responses?: Array<{
    at: number;
    speakerName: string;
    summary: string;
  }>;
  responderNames: string[];
  createdAt: number;
  lastResponseAt: number | null;
}

export interface AffinityRandomGenerationInput {
  direction: AffinityRandomDirection;
  now: number;
  scopeLabel: string | null;
  relationSummary: Record<string, unknown>;
  recentTurns: AffinityRandomContextTurn[];
  recentMemories: AffinityRandomMemoryItem[];
  materialText: string | null;
  webTopicText: string | null;
  lastRealtimeMessageAt: number | null;
}

export interface AffinityRandomGenerationResult {
  shouldSend: boolean;
  message: string | null;
  contextSeedSummary: string | null;
  eventTypeHint: AffinityEventType | 'none';
  memorySummary: string | null;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  skipReason: string | null;
  outputProtocol?: string | null;
  deliveryHistoryText?: string | null;
}
