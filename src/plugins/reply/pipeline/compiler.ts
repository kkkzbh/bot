import {
  normalizeStructuredReplyV1,
  STRUCTURED_REPLY_V1_SCHEMA,
  type StructuredReplyV1,
} from './types.js';

export function flattenModelOutputContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => flattenModelOutputContent(part)).filter(Boolean).join('\n').trim();
  }
  if (!content || typeof content !== 'object') return '';

  const node = content as {
    type?: string;
    content?: unknown;
    attrs?: { content?: unknown };
    children?: unknown[];
  };

  const ownText =
    typeof node.attrs?.content === 'string'
      ? node.attrs.content
      : typeof node.content === 'string'
        ? node.content
        : '';
  const childText = Array.isArray(node.children) ? node.children.map((child) => flattenModelOutputContent(child)).join('\n') : '';
  return `${ownText}\n${childText}`.trim();
}

export class StructuredReplyCompilerService {
  constructor(private readonly rawModelOutput: unknown) {}

  compile(): StructuredReplyV1 {
    const rawText = flattenModelOutputContent(this.rawModelOutput);
    if (!rawText) {
      throw new Error('structured reply compiler received empty model output.');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`structured reply compiler expected JSON: ${(error as Error).message}`);
    }

    const parsedReply = STRUCTURED_REPLY_V1_SCHEMA.safeParse(parsedJson);
    if (!parsedReply.success) {
      throw new Error(
        `structured reply compiler received invalid StructuredReplyV1: ${parsedReply.error.issues
          .map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`)
          .join('; ')}`,
      );
    }

    const normalized = normalizeStructuredReplyV1(parsedReply.data);
    if (!normalized) {
      throw new Error('structured reply compiler failed to normalize StructuredReplyV1.');
    }

    return normalized;
  }
}
