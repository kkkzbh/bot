import { buildStructuredReplyJsonSchema } from './structured-reply-schema.js';

export type ReplyOutputRequestMode = 'chat_completions' | 'responses';
export type ReplyOutputProtocol = 'native_chat_json_schema' | 'native_responses_json_schema' | 'chat_reply_v1';

export interface ReplyOutputContract {
  name: string;
  protocol: ReplyOutputProtocol;
  requestMode: ReplyOutputRequestMode;
  schema: Record<string, unknown> | null;
  instruction: string | null;
  overrideRequestParams: Record<string, unknown> | null;
}

export function buildReplySemanticContractLines(): string[] {
  return [
    '结构化回复语义规则：',
    '- 普通聊天文本用 `message`。',
    '- 默认不要使用 `mentions`。',
    '- 只有需要呼叫当前未参与该群聊天的人时，才使用 `message.mentions`。',
    '- 即使是在回应当前说话人，也不要默认 mention。',
    '- 代码、列表、引用等需要保留结构的内容用 `structured_block`。',
    '- 发送图片用 `image`，并填写工具返回的 `assetRef` 与 `alt`。',
    '- 如果工具结果里带有 `image.assetRef`，且该图片就是当前答案的一部分，最终回复必须包含对应 `image` 消息，不能只复述文字摘要。',
    '- 需要表达情绪时可使用 `meme`，并用自然意图描述。',
    '- 只有在情绪明显非常强烈，且属于“非常生气”或“非常高兴”时，才使用 `voice`。',
    '- `message.content` 不要手写 `@昵称`、`@QQ号`、`[CQ:at]`、`<at ...>`。',
    '- `decision=no_reply` 表示本轮不发送消息；`decision=reply` 必须至少给出一条 outbound message。',
  ];
}

export function buildNativeJsonOutputContractLines(): string[] {
  const example = {
    decision: 'reply',
    outbound_messages: [
      { type: 'message', content: '收到。', mentions: [] },
      { type: 'message', content: '来群里看一下。', mentions: ['123456'] },
      { type: 'structured_block', content: '1. 第一项\n2. 第二项' },
      { type: 'image', assetRef: 'https://example.com/image.png', alt: '图像说明' },
      { type: 'meme', content: '无语地看对方一眼' },
      { type: 'voice', content: '太好了，我现在真的很高兴。' },
    ],
  };

  return [
    '输出格式规则：',
    '- 最终回复必须是一个 JSON object，不要包裹 markdown fence，不要输出解释文字。',
    '- JSON object 必须符合 StructuredReply：',
    JSON.stringify(example, null, 2),
  ];
}

export function buildChatReplyV1OutputContractLines(): string[] {
  return [
    '输出格式规则：',
    '- 最终回复必须严格使用 CHAT_REPLY_V1 文本协议，不要包裹 markdown fence，不要输出解释文字。',
    '- 第一条非空行必须是 `CHAT_REPLY_V1 <nonce>`；最后用 `DONE <nonce>`，首尾 nonce 必须一致。',
    '- `DECISION no_reply` 后只能输出 `DONE <nonce>`。',
    '- `DECISION reply` 必须至少输出一个 `BEGIN ... END` block。',
    '- `BEGIN message` 后推荐立刻写 `MENTIONS none`；只有确实需要 @ 用户时才写数字 ID 列表。若省略 `MENTIONS`，系统会按 `none` 处理。',
    '- payload 内容行必须以 `|` 开头；空行也写成单独的 `|`，不要输出裸空行。裸 `END` 才结束 block。内容里需要写 END/DONE/BEGIN 时也必须写成 `|END`、`|DONE ...`、`|BEGIN ...`。',
    'no_reply 示例：',
    ['CHAT_REPLY_V1 abc12345', 'DECISION no_reply', 'DONE abc12345'].join('\n'),
    'message 示例：',
    ['CHAT_REPLY_V1 abc12345', 'DECISION reply', 'BEGIN message', 'MENTIONS none', 'CONTENT', '|收到，我看一下。', 'END', 'DONE abc12345'].join('\n'),
    'structured_block 示例：',
    ['BEGIN structured_block', 'CONTENT', '|1. 第一项', '|2. 第二项', 'END'].join('\n'),
    'image 示例：',
    ['BEGIN image', 'ASSET_REF asset:tool:image:01ABC', 'ALT', '|图像说明', 'END'].join('\n'),
    'meme 示例：',
    ['BEGIN meme', 'CONTENT', '|无语地看对方一眼', 'END'].join('\n'),
    'voice 示例：',
    ['BEGIN voice', 'CONTENT', '|太好了，我现在真的很高兴。', 'END'].join('\n'),
  ];
}

export function buildReplyOutputInstruction(protocol: ReplyOutputProtocol): string | null {
  if (protocol !== 'chat_reply_v1') return null;

  return [
    '最终回复格式强制规则：',
    ...buildReplySemanticContractLines(),
    '',
    ...buildChatReplyV1OutputContractLines(),
  ].join('\n');
}

export function createReplyOutputContract(args: {
  requestMode: ReplyOutputRequestMode;
  protocol: ReplyOutputProtocol;
  overrideRequestParams: Record<string, unknown> | null;
  name?: string;
  canMention?: boolean;
  canVoice?: boolean;
  canMeme?: boolean;
}): ReplyOutputContract {
  const schema = args.protocol === 'chat_reply_v1'
    ? null
    : buildStructuredReplyJsonSchema({
      canMention: args.canMention,
      canVoice: args.canVoice,
      canMeme: args.canMeme,
    });

  return {
    name: args.name ?? 'qqbot_structured_reply_v1',
    protocol: args.protocol,
    requestMode: args.requestMode,
    schema,
    instruction: buildReplyOutputInstruction(args.protocol),
    overrideRequestParams: args.overrideRequestParams,
  };
}
