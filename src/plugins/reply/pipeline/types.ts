import { z } from 'zod';
import { sanitizeStructuredReplySegmentContent } from '../../shared/outbound/index.js';
import type { PromptFragment } from '../../shared/prompt-context/types.js';

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

export const STRUCTURED_REPLY_MULTILINE_SEMANTICS = [
  'plain_block',
  'unordered_list',
  'ordered_list',
  'code_block',
  'quote_block',
] as const;

export type StructuredReplyMultilineSemantic = (typeof STRUCTURED_REPLY_MULTILINE_SEMANTICS)[number];

export type StructuredReplyMessage =
  | {
      modality: 'text';
      content: string;
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

export interface StructuredReplyV1 {
  decision: 'reply' | 'no_reply';
  messages?: StructuredReplyMessage[];
}

export type ResolvedAction =
  | {
      kind: 'text';
      content: string;
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
  STRUCTURED_REPLY_VOICE_MESSAGE_SCHEMA,
  STRUCTURED_REPLY_MEME_MESSAGE_SCHEMA,
  STRUCTURED_REPLY_MULTILINE_MESSAGE_SCHEMA,
]);

export const STRUCTURED_REPLY_V1_SCHEMA = z.object({
  decision: z.enum(['reply', 'no_reply']),
  messages: z.array(STRUCTURED_REPLY_MESSAGE_SCHEMA).nullable().optional(),
}).strict();

export const STRUCTURED_REPLY_V1_JSON_SCHEMA = {
  type: 'object',
  title: 'StructuredReplyV1',
  description: 'Reply decision and outbound messages for one qqbot turn.',
  additionalProperties: false,
  required: ['decision'],
  properties: {
    decision: {
      title: 'Decision',
      type: 'string',
      enum: ['reply', 'no_reply'],
      description: 'Whether the assistant should reply to the user in this turn.',
    },
    messages: {
      title: 'Messages',
      type: 'array',
      description: 'Outbound messages to send when decision is reply.',
      items: {
        anyOf: [
          {
            type: 'object',
            title: 'TextMessage',
            description: 'A normal visible text reply sent to the user.',
            additionalProperties: false,
            required: ['modality', 'content'],
            properties: {
              modality: {
                title: 'Modality',
                type: 'string',
                enum: ['text'],
                description: 'Send the content as a normal text message.',
              },
              content: {
                title: 'Content',
                type: 'string',
                description: 'The exact text content to send to the user.',
              },
            },
          },
          {
            type: 'object',
            title: 'VoiceMessage',
            description: 'A voice reply where content is the final TTS text.',
            additionalProperties: false,
            required: ['modality', 'content'],
            properties: {
              modality: {
                title: 'Modality',
                type: 'string',
                enum: ['voice'],
                description: 'Send the content through TTS as a voice message.',
              },
              content: {
                title: 'Content',
                type: 'string',
                description: 'The exact text that should be spoken by TTS.',
              },
            },
          },
          {
            type: 'object',
            title: 'MemeMessage',
            description: 'A meme reply where content is the meme intent, not an asset id.',
            additionalProperties: false,
            required: ['modality', 'content'],
            properties: {
              modality: {
                title: 'Modality',
                type: 'string',
                enum: ['meme'],
                description: 'Send a meme that matches the described intent.',
              },
              content: {
                title: 'Content',
                type: 'string',
                description: 'Natural-language meme intent text, not a sticker id or filename.',
              },
            },
          },
          {
            type: 'object',
            title: 'MultilineMessage',
            description: 'A multi-line block that must be sent atomically as one message.',
            additionalProperties: false,
            required: ['modality', 'semantic', 'content'],
            properties: {
              modality: {
                title: 'Modality',
                type: 'string',
                enum: ['multiline'],
                description: 'Send the content as one atomic multi-line block.',
              },
              semantic: {
                title: 'Semantic',
                type: 'string',
                enum: [...STRUCTURED_REPLY_MULTILINE_SEMANTICS],
                description: 'High-level block semantic for the multiline content.',
              },
              content: {
                title: 'Content',
                type: 'string',
                description: 'The exact multi-line content to send as one atomic block.',
              },
            },
          },
        ],
      },
    },
  },
} as const;

export function normalizeStructuredReplyV1(raw: unknown): StructuredReplyV1 | null {
  const parsed = STRUCTURED_REPLY_V1_SCHEMA.safeParse(raw);
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
