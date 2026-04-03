import { z } from 'zod';
import {
  normalizeRichTextSegments,
  sanitizeStructuredReplySegmentContent,
  type ReplyRichTextSegment,
} from '../../shared/outbound/index.js';
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
      modality: 'rich_text';
      segments: ReplyRichTextSegment[];
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
      kind: 'rich_text';
      segments: ReplyRichTextSegment[];
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

const STRUCTURED_REPLY_RICH_TEXT_SEGMENT_SCHEMA = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('mention'),
    userId: z.string().regex(/^\s*\d+\s*$/),
  }),
]);

const STRUCTURED_REPLY_RICH_TEXT_MESSAGE_SCHEMA = z.object({
  modality: z.literal('rich_text'),
  segments: z.array(STRUCTURED_REPLY_RICH_TEXT_SEGMENT_SCHEMA),
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
  STRUCTURED_REPLY_RICH_TEXT_MESSAGE_SCHEMA,
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
            description: 'A normal visible text reply sent to the user. Do not use this modality when the message needs a real @mention.',
            additionalProperties: false,
            required: ['modality', 'content'],
            properties: {
              modality: {
                title: 'Modality',
                type: 'string',
                enum: ['text'],
                description: 'Send the content as plain visible text only. If you need to @ someone, do not use text; use rich_text with mention segments.',
              },
              content: {
                title: 'Content',
                type: 'string',
                description: 'The exact plain text content to send to the user. Never represent a required @mention as plain text such as @123456 here.',
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
            title: 'RichTextMessage',
            description: 'A mixed inline message composed of text and real @mentions. Whenever the message needs to @ someone, you must use this modality.',
            additionalProperties: false,
            required: ['modality', 'segments'],
            properties: {
              modality: {
                title: 'Modality',
                type: 'string',
                enum: ['rich_text'],
                description: 'Send one rich-text message with inline text and real @mentions. Use this whenever the message needs to @ someone.',
              },
              segments: {
                title: 'Segments',
                type: 'array',
                description: 'Ordered inline segments for one message. Real @mentions must be encoded as mention segments, not as plain text.',
                items: {
                  anyOf: [
                    {
                      type: 'object',
                      title: 'TextSegment',
                      additionalProperties: false,
                      required: ['kind', 'text'],
                      properties: {
                        kind: {
                          type: 'string',
                          enum: ['text'],
                        },
                        text: {
                          type: 'string',
                          description: 'Visible plain text only. Do not encode @mentions here, and do not output transport tags such as <at .../>.',
                        },
                      },
                    },
                    {
                      type: 'object',
                      title: 'MentionSegment',
                      additionalProperties: false,
                      required: ['kind', 'userId'],
                      properties: {
                        kind: {
                          type: 'string',
                          enum: ['mention'],
                        },
                        userId: {
                          type: 'string',
                          description: 'Literal QQ user id to mention. When you need to @ someone, you must express it with this field instead of writing @123456 in text.',
                          pattern: '^\\s*\\d+\\s*$',
                        },
                      },
                    },
                  ],
                },
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
        : message.modality === 'rich_text'
          ? {
              modality: message.modality,
              segments: normalizeRichTextSegments(
                message.segments.map((segment) =>
                  segment.kind === 'mention'
                    ? {
                        kind: segment.kind,
                        userId: segment.userId.trim(),
                      }
                    : {
                        kind: segment.kind,
                        text: segment.text,
                      },
                ),
              ),
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
