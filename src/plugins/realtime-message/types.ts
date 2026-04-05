export type RealtimeMessageModality = 'text' | 'image' | 'voice';
export type RealtimeMessageEntryKind = RealtimeMessageModality | 'mixed';
export type RealtimeMessageToolOrder = 'latest_first' | 'oldest_first';
export type RealtimeMessageToolModality = 'any' | RealtimeMessageEntryKind;

export type QqVoiceStateLike = {
  transcript?: string;
  durationMs?: number;
  source?: string;
};

export type RealtimeMessageSessionLike = {
  platform?: string;
  bot?: { selfId?: string | null } | undefined;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  isDirect?: boolean;
  messageId?: string | null;
  content?: unknown;
  stripped?: { content?: unknown } | undefined;
  elements?: unknown[] | undefined;
  author?: { nick?: string | null; name?: string | null } | undefined;
  username?: string | null;
  state?: {
    qqVoice?: QqVoiceStateLike;
  } | undefined;
};

export interface RealtimeMessageEntry {
  messageId: string | null;
  groupScopeKey: string;
  userId: string;
  speakerName: string;
  capturedAt: number;
  modalities: RealtimeMessageModality[];
  text: string;
  imageUrls: string[];
  voiceTranscript: string | null;
  sessionSnapshot: RealtimeMessageSessionLike;
}

export interface RealtimeMessageQuery {
  limit: number;
  offset: number;
  order: RealtimeMessageToolOrder;
  speakerIds?: string[];
  keyword?: string;
  since?: number | null;
  until?: number | null;
  modality: RealtimeMessageToolModality;
}
