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
      description: 'A normal chat message.',
    },
    content: {
      title: 'Content',
      type: 'string',
      description:
        'Plain chat message body only. Use this for ordinary conversational text, not for lists, code blocks, or quotes. Mention targets belong in the mentions field, not in content.',
    },
  };
  const required = ['type', 'content'];

  if (options.canMention !== false) {
    properties.mentions = {
      title: 'Mentions',
      type: 'array',
      description:
        'QQ group @mentions for this message. Put mentioned QQ ids here instead of inside content. Use an empty array [] when no mention is needed.',
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
    description: 'A normal chat message.',
    additionalProperties: false,
    required,
    properties,
  } as const;
}

const STRUCTURED_BLOCK_SCHEMA = {
  type: 'object',
  title: 'StructuredBlockItem',
  description: 'A structured plain-text block that should stay together in one message, such as a list, code block, or quote.',
  additionalProperties: false,
  required: ['type', 'content'],
  properties: {
    type: {
      title: 'Type',
      type: 'string',
      enum: ['structured_block'],
      description: 'A structured plain-text block that should stay together in one message.',
    },
    content: {
      title: 'Content',
      type: 'string',
      description: 'Structured plain-text content that must stay together, for example a list, code snippet, or quote.',
    },
  },
} as const;

const VOICE_MESSAGE_SCHEMA = {
  type: 'object',
  title: 'VoiceItem',
  description: 'Send a voice message.',
  additionalProperties: false,
  required: ['type', 'content'],
  properties: {
    type: {
      title: 'Type',
      type: 'string',
      enum: ['voice'],
      description: 'Send a voice message.',
    },
    content: {
      title: 'Content',
      type: 'string',
      description: 'The final text that should be spoken in the voice message.',
    },
  },
} as const;

const MEME_MESSAGE_SCHEMA = {
  type: 'object',
  title: 'MemeItem',
  description: 'Send a meme image.',
  additionalProperties: false,
  required: ['type', 'content'],
  properties: {
    type: {
      title: 'Type',
      type: 'string',
      enum: ['meme'],
      description: 'Send a meme when it helps express mood, attitude, or emotional nuance better than plain text.',
    },
    content: {
      title: 'Content',
      type: 'string',
      description: 'Natural-language meme meaning or intent, not a sticker id, filename, or tag.',
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
