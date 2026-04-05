import { z } from 'zod';
import {
  normalizeMention,
  sanitizeStructuredReplySegmentContent,
  type ReplyMention,
} from '../../shared/outbound/index.js';
import type { PromptFragment } from '../../shared/prompt-context/types.js';
import {
  STRUCTURED_REPLY_JSON_SCHEMA,
  STRUCTURED_REPLY_MULTILINE_SEMANTICS,
} from '../../shared/llm/structured-reply-schema.js';

export const REPLY_ROUTES = [
  'no_reply',
  'agent',
  'automation',
] as const;

export type ReplyRoute = (typeof REPLY_ROUTES)[number];
export type ReplyToolRouteProfile = Extract<ReplyRoute, 'agent'>;
export type PromptAssemblyRouteProfile = ReplyToolRouteProfile | 'automation';

export interface TurnInput {
  text: string;
  hasImageInput: boolean;
  imageCount: number;
  displayName: string;
  userId: string;
  isDirect: boolean;
  messageId?: string | null;
  channelId?: string | null;
  guildId?: string | null;
  conversationId?: string | null;
}

export interface TurnContinuationContext {
  alreadySentText: string;
  pendingUnitTexts: string[];
  supplementalMessages: string[];
}

export interface TurnContext {
  input: TurnInput;
  promptFragments: PromptFragment[];
  capabilitySnapshot: {
    canMultiline: boolean;
    canMention?: boolean;
    canVoice: boolean;
    canSticker: boolean;
    stickerAvailableCount: number;
    source: string;
  } | null;
  policySnapshot: {
    route: ReplyRoute;
    toolRouteProfile: ReplyToolRouteProfile | null;
  };
  continuationContext: TurnContinuationContext | null;
}

export type StructuredReplyMultilineSemantic = (typeof STRUCTURED_REPLY_MULTILINE_SEMANTICS)[number];

export type StructuredReplyMessage =
  | {
      modality: 'text';
      content: string;
    }
  | {
      modality: 'mention';
      userId: string;
      content?: string;
    }
  | {
      modality: 'voice';
      content: string;
    }
  | {
      modality: 'meme';
      content: string;
    }
  | {
      modality: 'multiline';
      semantic: StructuredReplyMultilineSemantic;
      content: string;
    };

export interface StructuredReply {
  decision: 'reply' | 'no_reply';
  messages?: StructuredReplyMessage[];
}

export type ResolvedAction =
  | {
      kind: 'text';
      content: string;
    }
  | {
      kind: 'mention';
      mention: ReplyMention;
    }
  | {
      kind: 'multiline';
      semantic: StructuredReplyMultilineSemantic;
      content: string;
    }
  | {
      kind: 'voice';
      content: string;
    }
  | {
      kind: 'sticker';
      intent: string;
    }
  | {
      kind: 'no_reply';
    };

const STRUCTURED_REPLY_TEXT_MESSAGE_SCHEMA = z.object({
  modality: z.literal('text'),
  content: z.string(),
});

const STRUCTURED_REPLY_MENTION_MESSAGE_SCHEMA = z.object({
  modality: z.literal('mention'),
  userId: z.string().regex(/^\s*\d+\s*$/),
  content: z.string().optional(),
});

const STRUCTURED_REPLY_VOICE_MESSAGE_SCHEMA = z.object({
  modality: z.literal('voice'),
  content: z.string(),
});

const STRUCTURED_REPLY_MEME_MESSAGE_SCHEMA = z.object({
  modality: z.literal('meme'),
  content: z.string(),
});

const STRUCTURED_REPLY_MULTILINE_MESSAGE_SCHEMA = z.object({
  modality: z.literal('multiline'),
  semantic: z.enum(STRUCTURED_REPLY_MULTILINE_SEMANTICS),
  content: z.string(),
});

const STRUCTURED_REPLY_MESSAGE_SCHEMA = z.discriminatedUnion('modality', [
  STRUCTURED_REPLY_TEXT_MESSAGE_SCHEMA,
  STRUCTURED_REPLY_MENTION_MESSAGE_SCHEMA,
  STRUCTURED_REPLY_VOICE_MESSAGE_SCHEMA,
  STRUCTURED_REPLY_MEME_MESSAGE_SCHEMA,
  STRUCTURED_REPLY_MULTILINE_MESSAGE_SCHEMA,
]);

export const STRUCTURED_REPLY_SCHEMA = z.object({
  decision: z.enum(['reply', 'no_reply']),
  messages: z.array(STRUCTURED_REPLY_MESSAGE_SCHEMA).nullable().optional(),
}).strict();

export function normalizeStructuredReply(raw: unknown): StructuredReply | null {
  const parsed = STRUCTURED_REPLY_SCHEMA.safeParse(raw);
  if (!parsed.success) return null;

  if (parsed.data.decision === 'no_reply') {
    return {
      decision: 'no_reply',
    };
  }

  return {
    decision: 'reply',
    messages: parsed.data.messages?.map((message) =>
      message.modality === 'multiline'
        ? {
            modality: message.modality,
            semantic: message.semantic,
            content: sanitizeStructuredReplySegmentContent(message.content),
          }
        : message.modality === 'mention'
          ? {
              modality: message.modality,
              ...(normalizeMention({
                userId: message.userId,
                content: message.content,
              }) ?? { userId: message.userId.trim() }),
            }
          : {
              modality: message.modality,
              content: sanitizeStructuredReplySegmentContent(message.content),
            },
    ),
  };
}

export function classifyReplyRoute(input: TurnInput, routeHint?: ReplyRoute | null): ReplyRoute {
  if (!input.text.trim() && !input.hasImageInput) return 'no_reply';
  if (routeHint === 'automation') return 'automation';
  if (routeHint === 'agent') return 'agent';
  return 'agent';
}
