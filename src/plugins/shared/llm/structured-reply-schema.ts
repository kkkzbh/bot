import {
  normalizeVoiceOutputLanguage,
  VOICE_OUTPUT_LANGUAGE_LABELS,
  type VoiceOutputLanguage,
} from '../voice/language.js';

export interface StructuredReplySchemaOptions {
  canMention?: boolean;
  canVoice?: boolean;
  canMeme?: boolean;
  voiceOutputLanguage?: VoiceOutputLanguage;
}

const MESSAGE_MESSAGE_SCHEMA = {
  type: 'object',
  title: 'MessageItem',
  description: 'Ordinary chat message.',
  additionalProperties: false,
  required: ['type', 'content'],
  properties: {
    type: {
      title: 'Type',
      type: 'string',
      enum: ['message'],
      description: 'Ordinary chat message.',
    },
    content: {
      title: 'Content',
      type: 'string',
      description: 'Ordinary conversational plain text for this chat message. To mention a group member, write @name followed by a space directly in this text.',
    },
  },
} as const;

const STRUCTURED_BLOCK_SCHEMA = {
  type: 'object',
  title: 'StructuredBlockItem',
  description: 'Structured text that should stay intact in one message.',
  additionalProperties: false,
  required: ['type', 'content'],
  properties: {
    type: {
      title: 'Type',
      type: 'string',
      enum: ['structured_block'],
      description: 'Structured text that should stay intact in one message.',
    },
    content: {
      title: 'Content',
      type: 'string',
      description: 'Structured text to keep intact, such as code, lists, or quotes.',
    },
  },
} as const;

function buildVoiceMessageSchema(options: StructuredReplySchemaOptions) {
  const language = normalizeVoiceOutputLanguage(options.voiceOutputLanguage);
  const languageDescription = language === 'auto'
    ? 'Use the most natural spoken language for this turn.'
    : `Write this content directly in ${VOICE_OUTPUT_LANGUAGE_LABELS[language]}.`;

  return {
    type: 'object',
    title: 'VoiceItem',
    description: 'Voice message to send.',
    additionalProperties: false,
    required: ['type', 'content'],
    properties: {
      type: {
        title: 'Type',
        type: 'string',
        enum: ['voice'],
        description: 'Voice message to send.',
      },
      content: {
        title: 'Content',
        type: 'string',
        description: `Final text to speak in the voice message. ${languageDescription} TTS reads this text and does not translate it.`,
      },
    },
  } as const;
}

const IMAGE_MESSAGE_SCHEMA = {
  type: 'object',
  title: 'ImageItem',
  description: 'Image message to send.',
  additionalProperties: false,
  required: ['type', 'assetRef', 'alt'],
  properties: {
    type: {
      title: 'Type',
      type: 'string',
      enum: ['image'],
      description: 'Image message to send.',
    },
    assetRef: {
      title: 'AssetRef',
      type: 'string',
      description: 'Resolvable image asset reference returned by a tool.',
    },
    alt: {
      title: 'Alt',
      type: 'string',
      description: 'Short alt text for this image message.',
    },
  },
} as const;

const MEME_MESSAGE_SCHEMA = {
  type: 'object',
  title: 'MemeItem',
  description: 'Meme intent to send.',
  additionalProperties: false,
  required: ['type', 'content'],
  properties: {
    type: {
      title: 'Type',
      type: 'string',
      enum: ['meme'],
      description: 'Meme intent to send.',
    },
    content: {
      title: 'Content',
      type: 'string',
      description: 'Natural-language meme intent for this turn.',
    },
  },
} as const;

export function buildStructuredReplyJsonSchema(options: StructuredReplySchemaOptions = {}): Record<string, unknown> {
  const outboundSchemas: Record<string, unknown>[] = [
    MESSAGE_MESSAGE_SCHEMA,
    STRUCTURED_BLOCK_SCHEMA,
  ];

  if (options.canVoice !== false) {
    outboundSchemas.push(buildVoiceMessageSchema(options));
  }

  outboundSchemas.push(IMAGE_MESSAGE_SCHEMA);

  if (options.canMeme !== false) {
    outboundSchemas.push(MEME_MESSAGE_SCHEMA);
  }

  return {
    type: 'object',
    title: 'StructuredReply',
    description: 'Reply decision and final outbound messages for one qqbot turn.',
    additionalProperties: false,
    required: ['decision', 'outbound_messages'],
    properties: {
      decision: {
        title: 'Decision',
        type: 'string',
        enum: ['reply', 'no_reply'],
        description: 'Whether to reply in this turn.',
      },
      outbound_messages: {
        title: 'OutboundMessages',
        description: 'Final outbound messages to send, in order. Use null when there is no reply.',
        anyOf: [
          {
            type: 'array',
            items: {
              anyOf: outboundSchemas,
            },
          },
          {
            type: 'null',
          },
        ],
      },
    },
  } as const satisfies Record<string, unknown>;
}

export const STRUCTURED_REPLY_JSON_SCHEMA = buildStructuredReplyJsonSchema();
