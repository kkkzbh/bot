import { z } from 'zod';
import {
  sanitizeStructuredReplySegmentContent,
  type ReplyTransportPlan,
} from '../../shared/outbound/index.js';

const REPLY_PLAN_SCHEMA = z.object({
  segments: z
    .array(
      z.object({
        kind: z.enum(['text', 'multiline', 'voice', 'sticker']),
        content: z.string(),
      }),
    )
    .min(1),
});

export interface ReplyPlanParseResult {
  plan: ReplyTransportPlan | null;
  error: string | null;
}

export function extractReplyPlanMessageText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (!Array.isArray(raw)) return '';

  return raw
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'text' in item) {
        const maybeText = (item as { text?: unknown }).text;
        return typeof maybeText === 'string' ? maybeText : '';
      }
      return '';
    })
    .join('')
    .trim();
}

export function parseReplyPlanFromStructuredOutput(raw: unknown): ReplyTransportPlan | null {
  return parseReplyPlanFromStructuredOutputDetailed(raw).plan;
}

export function parseReplyPlanFromStructuredOutputDetailed(raw: unknown): ReplyPlanParseResult {
  const text = extractReplyPlanMessageText(raw);
  if (!text) {
    return {
      plan: null,
      error: 'ReplyPlan 输出为空，未返回任何可解析内容。',
    };
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const result = REPLY_PLAN_SCHEMA.safeParse(parsed);
    if (!result.success) {
      return {
        plan: null,
        error: `ReplyPlan 输出不符合 schema：${result.error.issues
          .map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`)
          .join('; ')}`,
      };
    }

    const segments = result.data.segments
      .map((segment) => {
        const content = sanitizeStructuredReplySegmentContent(segment.content);
        if (!content.trim()) return null;
        return {
          kind: segment.kind,
          content,
        };
      })
      .filter(Boolean) as ReplyTransportPlan['segments'];

    if (segments.length < 1) {
      return {
        plan: null,
        error: 'ReplyPlan 里的 segments 在清洗后为空。',
      };
    }

    return {
      plan: { segments },
      error: null,
    };
  } catch {
    return {
      plan: null,
      error: 'ReplyPlan 输出不是合法 JSON 对象。',
    };
  }
}
