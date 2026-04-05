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
      description: 'Send one final chat message.',
    },
    content: {
      title: 'Content',
      type: 'string',
      description: 'One final chat message. Send multiple messages by outputting multiple message items. Put code blocks, lists, and quotes inside one message item.',
    },
  };

  if (options.canMention !== false) {
    properties.mentions = {
      title: 'Mentions',
      type: 'array',
      description: 'QQ group @mentions. Use this to mention one or more QQ users in a group message.',
      items: {
        type: 'string',
        pattern: QQ_USER_ID_PATTERN,
      },
    };
  }

  return {
    type: 'object',
    title: 'MessageItem',
    description: 'One final chat message. Send multiple messages by outputting multiple message items.',
    additionalProperties: false,
    required: ['type', 'content'],
    properties,
  } as const;
}

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
      description: 'Send a meme image.',
    },
    content: {
      title: 'Content',
      type: 'string',
      description: 'Natural-language meme meaning or intent, not a sticker id, filename, or tag.',
    },
  },
} as const;

export function buildStructuredReplyJsonSchema(options: StructuredReplySchemaOptions = {}): Record<string, unknown> {
  const outboundSchemas: Record<string, unknown>[] = [buildMessageMessageSchema(options)];

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
