import type { StructuredReply, StructuredReplyMessage } from './types.js';

export const CHAT_REPLY_V1_PROTOCOL_ID = 'chat_reply_v1' as const;
export const CHAT_REPLY_V1_HEADER = 'CHAT_REPLY_V1';

export type ChatReplyV1ParseErrorCode =
  | 'MISSING_HEADER'
  | 'NONCE_MISMATCH'
  | 'UNKNOWN_COMMAND'
  | 'UNKNOWN_BLOCK_TYPE'
  | 'DUPLICATE_FIELD'
  | 'MISSING_FIELD'
  | 'BAD_MENTION_LIST'
  | 'PAYLOAD_LINE_WITHOUT_PIPE'
  | 'UNTERMINATED_BLOCK'
  | 'TRAILING_TEXT_AFTER_DONE';

export class ChatReplyV1ParseError extends Error {
  readonly protocol = CHAT_REPLY_V1_PROTOCOL_ID;

  constructor(
    readonly code: ChatReplyV1ParseErrorCode,
    readonly line: number,
    readonly column: number,
    readonly snippet: string,
    message: string,
  ) {
    super(`${code} at ${line}:${column}: ${message}`);
    this.name = 'ChatReplyV1ParseError';
  }
}

type BlockType = StructuredReplyMessage['type'];
type PayloadSection = 'CONTENT' | 'ALT';

interface BlockBuilder {
  type: BlockType;
  startLine: number;
  headers: Map<string, string>;
  payloads: Map<PayloadSection, string[]>;
  activePayload: PayloadSection | null;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function parseError(code: ChatReplyV1ParseErrorCode, line: number, sourceLine: string, message: string): ChatReplyV1ParseError {
  return new ChatReplyV1ParseError(code, line, 1, sourceLine, message);
}

function splitLines(text: string): string[] {
  return stripBom(text).replace(/\r\n?/gu, '\n').split('\n');
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function isBlockType(value: string): value is BlockType {
  return value === 'message' || value === 'structured_block' || value === 'image' || value === 'meme' || value === 'voice';
}

function parseMentionList(value: string, line: number, sourceLine: string): string[] {
  const trimmed = value.trim();
  if (/^none$/iu.test(trimmed)) return [];
  const mentions = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
  if (mentions.length === 0 || mentions.some((item) => !/^\d+$/u.test(item))) {
    throw parseError('BAD_MENTION_LIST', line, sourceLine, 'MENTIONS must be none or comma-separated numeric ids.');
  }
  return [...new Set(mentions)];
}

function requirePayload(block: BlockBuilder, key: PayloadSection): string {
  const lines = block.payloads.get(key);
  if (!lines?.length) {
    throw parseError('MISSING_FIELD', block.startLine, `BEGIN ${block.type}`, `${block.type} requires ${key}.`);
  }
  return lines.join('\n');
}

function requireHeader(block: BlockBuilder, key: string): string {
  const value = block.headers.get(key);
  if (value == null || value.trim().length === 0) {
    throw parseError('MISSING_FIELD', block.startLine, `BEGIN ${block.type}`, `${block.type} requires ${key}.`);
  }
  return value.trim();
}

function finalizeBlock(block: BlockBuilder): StructuredReplyMessage {
  switch (block.type) {
    case 'message':
      return {
        type: 'message',
        mentions: block.headers.has('MENTIONS')
          ? parseMentionList(requireHeader(block, 'MENTIONS'), block.startLine, `BEGIN ${block.type}`)
          : [],
        content: requirePayload(block, 'CONTENT'),
      };
    case 'structured_block':
      return {
        type: 'structured_block',
        content: requirePayload(block, 'CONTENT'),
      };
    case 'image':
      return {
        type: 'image',
        assetRef: requireHeader(block, 'ASSET_REF'),
        alt: requirePayload(block, 'ALT'),
      };
    case 'meme':
      return {
        type: 'meme',
        content: requirePayload(block, 'CONTENT'),
      };
    case 'voice':
      return {
        type: 'voice',
        content: requirePayload(block, 'CONTENT'),
      };
  }
}

export class ChatReplyV1Parser {
  parse(rawText: string): StructuredReply {
    const lines = splitLines(rawText);
    let index = 0;

    while (index < lines.length && isBlank(lines[index]!)) index += 1;
    if (index >= lines.length) {
      throw parseError('MISSING_HEADER', 1, '', `Expected ${CHAT_REPLY_V1_HEADER} header.`);
    }

    const headerLine = lines[index]!;
    const headerMatch = headerLine.match(/^CHAT_REPLY_V1\s+([A-Za-z0-9_-]{6,32})$/u);
    if (!headerMatch) {
      throw parseError('MISSING_HEADER', index + 1, headerLine, `Expected ${CHAT_REPLY_V1_HEADER} <nonce>.`);
    }
    const nonce = headerMatch[1]!;
    index += 1;

    while (index < lines.length && isBlank(lines[index]!)) index += 1;
    const decisionLine = lines[index] ?? '';
    const decisionMatch = decisionLine.match(/^DECISION\s+(reply|no_reply)$/u);
    if (!decisionMatch) {
      throw parseError('UNKNOWN_COMMAND', index + 1, decisionLine, 'Expected DECISION reply or DECISION no_reply.');
    }
    const decision = decisionMatch[1] as StructuredReply['decision'];
    index += 1;

    const messages: StructuredReplyMessage[] = [];
    let block: BlockBuilder | null = null;
    let done = false;

    for (; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index]!;

      if (done) {
        if (!isBlank(line)) {
          throw parseError('TRAILING_TEXT_AFTER_DONE', lineNumber, line, 'Only blank lines are allowed after DONE.');
        }
        continue;
      }

      if (block?.activePayload) {
        if (line === 'END') {
          messages.push(finalizeBlock(block));
          block = null;
          continue;
        }
        if (isBlank(line)) {
          block.payloads.get(block.activePayload)!.push('');
          continue;
        }
        if (line.startsWith('|')) {
          block.payloads.get(block.activePayload)!.push(line.slice(1));
          continue;
        }

        block.payloads.get(block.activePayload)!.push(line);
        continue;
      }

      if (isBlank(line)) continue;

      const doneMatch = line.match(/^DONE\s+([A-Za-z0-9_-]{6,32})$/u);
      if (doneMatch) {
        if (block) {
          throw parseError('UNTERMINATED_BLOCK', block.startLine, `BEGIN ${block.type}`, 'Block was not closed before DONE.');
        }
        if (doneMatch[1] !== nonce) {
          throw parseError('NONCE_MISMATCH', lineNumber, line, 'DONE nonce does not match header nonce.');
        }
        done = true;
        continue;
      }

      if (block) {
        if (line === 'END') {
          messages.push(finalizeBlock(block));
          block = null;
          continue;
        }
        if (line === 'CONTENT' || line === 'ALT') {
          const key = line as PayloadSection;
          if (block.payloads.has(key)) {
            throw parseError('DUPLICATE_FIELD', lineNumber, line, `${key} already exists in this block.`);
          }
          block.payloads.set(key, []);
          block.activePayload = key;
          continue;
        }
        const headerMatch = line.match(/^([A-Z_]+)\s+(.+)$/u);
        if (!headerMatch) {
          throw parseError('UNKNOWN_COMMAND', lineNumber, line, 'Expected block header, payload section, or END.');
        }
        const key = headerMatch[1]!;
        if (block.headers.has(key)) {
          throw parseError('DUPLICATE_FIELD', lineNumber, line, `${key} already exists in this block.`);
        }
        block.headers.set(key, headerMatch[2]!);
        continue;
      }

      const beginMatch = line.match(/^BEGIN\s+([a-z_]+)$/u);
      if (beginMatch) {
        if (decision === 'no_reply') {
          throw parseError('UNKNOWN_COMMAND', lineNumber, line, 'DECISION no_reply cannot include message blocks.');
        }
        const blockType = beginMatch[1]!;
        if (!isBlockType(blockType)) {
          throw parseError('UNKNOWN_BLOCK_TYPE', lineNumber, line, `Unknown block type: ${blockType}.`);
        }
        block = {
          type: blockType,
          startLine: lineNumber,
          headers: new Map(),
          payloads: new Map(),
          activePayload: null,
        };
        continue;
      }

      throw parseError('UNKNOWN_COMMAND', lineNumber, line, 'Expected BEGIN or DONE.');
    }

    if (block) {
      throw parseError('UNTERMINATED_BLOCK', block.startLine, `BEGIN ${block.type}`, 'Block was not closed.');
    }
    if (!done) {
      throw parseError('UNKNOWN_COMMAND', lines.length, lines[lines.length - 1] ?? '', 'Missing DONE.');
    }
    if (decision === 'no_reply') {
      if (messages.length > 0) {
        throw parseError('UNKNOWN_COMMAND', 2, 'DECISION no_reply', 'DECISION no_reply cannot include messages.');
      }
      return { decision: 'no_reply', outbound_messages: null };
    }
    if (messages.length === 0) {
      throw parseError('MISSING_FIELD', 2, 'DECISION reply', 'DECISION reply requires at least one block.');
    }
    return { decision: 'reply', outbound_messages: messages };
  }
}

export function encodeChatReplyV1(reply: StructuredReply, nonce: string): string {
  const lines = [`${CHAT_REPLY_V1_HEADER} ${nonce}`, `DECISION ${reply.decision}`];
  if (reply.decision === 'reply') {
    for (const message of reply.outbound_messages ?? []) {
      lines.push(`BEGIN ${message.type}`);
      if (message.type === 'message') {
        lines.push(`MENTIONS ${message.mentions?.length ? message.mentions.join(',') : 'none'}`);
        lines.push('CONTENT', ...message.content.split('\n').map((line) => `|${line}`));
      } else if (message.type === 'image') {
        lines.push(`ASSET_REF ${message.assetRef}`, 'ALT', ...message.alt.split('\n').map((line) => `|${line}`));
      } else {
        lines.push('CONTENT', ...message.content.split('\n').map((line) => `|${line}`));
      }
      lines.push('END');
    }
  }
  lines.push(`DONE ${nonce}`);
  return lines.join('\n');
}
