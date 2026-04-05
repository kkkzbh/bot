export const STRUCTURED_REPLY_MULTILINE_SEMANTICS = [
  'plain_block',
  'unordered_list',
  'ordered_list',
  'code_block',
  'quote_block',
] as const;

export interface StructuredReplySchemaOptions {
  canMention?: boolean;
}

const TEXT_MESSAGE_SCHEMA = {
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
      description: 'Send the content as plain visible text only.',
    },
    content: {
      title: 'Content',
      type: 'string',
      description: 'The exact plain text content to send to the user.',
    },
  },
} as const;

const MENTION_ONLY_MESSAGE_SCHEMA = {
  type: 'object',
  title: 'MentionOnlyMessage',
  description: 'A real @mention reply with no visible body text.',
  additionalProperties: false,
  required: ['modality', 'userId'],
  properties: {
    modality: {
      title: 'Modality',
      type: 'string',
      enum: ['mention'],
      description: 'Send a real @mention.',
    },
    userId: {
      title: 'UserId',
      type: 'string',
      description: 'Literal QQ user id to mention.',
      pattern: '^\\s*\\d+\\s*$',
    },
  },
} as const;

const MENTION_MESSAGE_SCHEMA = {
  type: 'object',
  title: 'MentionMessage',
  description: 'A real @mention reply with visible text in the same message.',
  additionalProperties: false,
  required: ['modality', 'userId', 'content'],
  properties: {
    modality: {
      title: 'Modality',
      type: 'string',
      enum: ['mention'],
      description: 'Send a real @mention.',
    },
    userId: {
      title: 'UserId',
      type: 'string',
      description: 'Literal QQ user id to mention.',
      pattern: '^\\s*\\d+\\s*$',
    },
    content: {
      title: 'Content',
      type: 'string',
      description: 'Visible text in the same message after the @mention.',
    },
  },
} as const;

const VOICE_MESSAGE_SCHEMA = {
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
} as const;

const MEME_MESSAGE_SCHEMA = {
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
} as const;

const MULTILINE_MESSAGE_SCHEMA = {
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
} as const;

export function buildStructuredReplyJsonSchema(options: StructuredReplySchemaOptions = {}): Record<string, unknown> {
  const messageSchemas: Record<string, unknown>[] = [TEXT_MESSAGE_SCHEMA];

  if (options.canMention !== false) {
    messageSchemas.push({
      anyOf: [MENTION_ONLY_MESSAGE_SCHEMA, MENTION_MESSAGE_SCHEMA],
    });
  }

  messageSchemas.push(VOICE_MESSAGE_SCHEMA, MEME_MESSAGE_SCHEMA, MULTILINE_MESSAGE_SCHEMA);

  return {
    type: 'object',
    title: 'StructuredReply',
    description: 'Reply decision and outbound messages for one qqbot turn.',
    additionalProperties: false,
    required: ['decision', 'messages'],
    properties: {
      decision: {
        title: 'Decision',
        type: 'string',
        enum: ['reply', 'no_reply'],
        description: 'Whether the assistant should reply to the user in this turn.',
      },
      messages: {
        title: 'Messages',
        description: 'Outbound messages to send when decision is reply. Use null when there is no reply.',
        anyOf: [
          {
            type: 'array',
            items: {
              anyOf: messageSchemas,
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
