export interface StructuredReplySchemaOptions {
  canMention?: boolean;
  canVoice?: boolean;
  canMeme?: boolean;
}

const QQ_USER_ID_PATTERN = '^\\s*\\d+\\s*$';

function buildMessageMessageSchema(options: StructuredReplySchemaOptions) {
  const properties: Record<string, unknown> = {
    type: {
      title: 'Type',
      type: 'string',
      enum: ['message'],
      description: 'Ordinary chat message.',
    },
    content: {
      title: 'Content',
      type: 'string',
      description: 'Ordinary conversational plain text for this chat message.',
    },
  };
  const required = ['type', 'content'];

  if (options.canMention !== false) {
    properties.mentions = {
      title: 'Mentions',
      type: 'array',
      description: 'QQ user IDs to mention in this chat message. Use [] when no mention is needed.',
      items: {
        type: 'string',
        pattern: QQ_USER_ID_PATTERN,
      },
    };
    required.push('mentions');
  }

  return {
    type: 'object',
    title: 'MessageItem',
    description: 'Ordinary chat message.',
    additionalProperties: false,
    required,
    properties,
  } as const;
}

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

const VOICE_MESSAGE_SCHEMA = {
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
      description: 'Final text to speak in the voice message.',
    },
  },
} as const;

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
    buildMessageMessageSchema(options),
    STRUCTURED_BLOCK_SCHEMA,
  ];

  if (options.canVoice !== false) {
    outboundSchemas.push(VOICE_MESSAGE_SCHEMA);
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
