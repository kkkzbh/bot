import { z } from 'zod';
import { sanitizeStructuredReplyText } from '../../shared/outbound/index.js';
import type { PromptFragment } from '../../shared/prompt-context/types.js';
import { STRUCTURED_REPLY_JSON_SCHEMA } from '../../shared/llm/structured-reply-schema.js';

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

export type StructuredReplyMessage =
  | {
      type: 'message';
      content: string;
      mentions?: string[];
    }
  | {
      type: 'structured_block';
      content: string;
    }
  | {
      type: 'voice';
      content: string;
    }
  | {
      type: 'image';
      assetRef: string;
      alt: string;
    }
  | {
      type: 'meme';
      content: string;
    };

export interface StructuredReply {
  decision: 'reply' | 'no_reply';
  outbound_messages?: StructuredReplyMessage[];
}

export type ResolvedAction =
  | {
      kind: 'message';
      content: string;
      mentions: string[];
    }
  | {
      kind: 'structured_block';
      content: string;
    }
  | {
      kind: 'voice';
      content: string;
    }
  | {
      kind: 'image';
      assetRef: string;
      alt: string;
    }
  | {
      kind: 'sticker';
      intent: string;
    }
  | {
      kind: 'no_reply';
    };

const STRUCTURED_REPLY_MESSAGE_USER_IDS_SCHEMA = z.array(z.string().regex(/^\s*\d+\s*$/));

const STRUCTURED_REPLY_MESSAGE_ITEM_SCHEMA = z.object({
  type: z.literal('message'),
  content: z.string(),
  mentions: STRUCTURED_REPLY_MESSAGE_USER_IDS_SCHEMA.optional(),
});

const STRUCTURED_REPLY_STRUCTURED_BLOCK_ITEM_SCHEMA = z.object({
  type: z.literal('structured_block'),
  content: z.string(),
});

const STRUCTURED_REPLY_VOICE_ITEM_SCHEMA = z.object({
  type: z.literal('voice'),
  content: z.string(),
});

const STRUCTURED_REPLY_IMAGE_ITEM_SCHEMA = z.object({
  type: z.literal('image'),
  assetRef: z.string(),
  alt: z.string(),
});

const STRUCTURED_REPLY_MEME_ITEM_SCHEMA = z.object({
  type: z.literal('meme'),
  content: z.string(),
});

const STRUCTURED_REPLY_OUTBOUND_ITEM_SCHEMA = z.discriminatedUnion('type', [
  STRUCTURED_REPLY_MESSAGE_ITEM_SCHEMA,
  STRUCTURED_REPLY_STRUCTURED_BLOCK_ITEM_SCHEMA,
  STRUCTURED_REPLY_VOICE_ITEM_SCHEMA,
  STRUCTURED_REPLY_IMAGE_ITEM_SCHEMA,
  STRUCTURED_REPLY_MEME_ITEM_SCHEMA,
]);

export const STRUCTURED_REPLY_SCHEMA = z.object({
  decision: z.enum(['reply', 'no_reply']),
  outbound_messages: z.array(STRUCTURED_REPLY_OUTBOUND_ITEM_SCHEMA).nullable().optional(),
}).strict();

function normalizeMentionIds(mentions: string[] | undefined): string[] {
  return (mentions ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
}

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
    outbound_messages: parsed.data.outbound_messages?.map((message) =>
      message.type === 'message'
        ? {
            type: 'message',
            content: sanitizeStructuredReplyText(message.content, 'message'),
            ...(message.mentions ? { mentions: normalizeMentionIds(message.mentions) } : {}),
          }
        : message.type === 'structured_block'
          ? {
              type: 'structured_block',
              content: sanitizeStructuredReplyText(message.content, 'structured_block'),
            }
        : message.type === 'voice'
          ? {
              type: 'voice',
              content: sanitizeStructuredReplyText(message.content, 'voice'),
            }
          : message.type === 'image'
            ? {
                type: 'image',
                assetRef: message.assetRef.trim(),
                alt: sanitizeStructuredReplyText(message.alt, 'image_alt'),
              }
            : {
                type: 'meme',
                content: sanitizeStructuredReplyText(message.content, 'meme'),
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

export { STRUCTURED_REPLY_JSON_SCHEMA };
