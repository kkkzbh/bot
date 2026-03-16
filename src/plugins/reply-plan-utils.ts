import { z } from 'zod';
import {
  buildOutboundMessagePlanFromReplyPlan,
  sanitizeStructuredReplySegmentContent,
  type ReplyTransportPlan,
} from './message-send-utils.js';

const JSON_FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)\s*```/i;

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

function extractReplyPlanJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(JSON_FENCE_PATTERN)?.[1]?.trim();
  if (fenced) return fenced;

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return trimmed.slice(start, end + 1);
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

export function parseReplyPlanFromModelOutput(raw: unknown): ReplyTransportPlan | null {
  const text = extractReplyPlanMessageText(raw);
  const jsonText = extractReplyPlanJson(text);
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const candidate =
      parsed && typeof parsed === 'object' && 'reply_plan' in (parsed as Record<string, unknown>)
        ? (parsed as { reply_plan?: unknown }).reply_plan
        : parsed;
    const result = REPLY_PLAN_SCHEMA.safeParse(candidate);
    if (!result.success) return null;

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

    if (segments.length < 1) return null;
    return { segments };
  } catch {
    return null;
  }
}

export function renderReplyPlanHistoryText(plan: ReplyTransportPlan): string {
  return plan.segments
    .map((segment) =>
      segment.kind === 'sticker' ? '（发送表情包）' : sanitizeStructuredReplySegmentContent(segment.content),
    )
    .filter((segment) => segment.trim().length > 0)
    .join('\n')
    .trim();
}

export function shouldExecuteReplyPlan(plan: ReplyTransportPlan): boolean {
  const outboundPlan = buildOutboundMessagePlanFromReplyPlan(plan);
  if (outboundPlan.segments.length !== 1) return true;

  const [segment] = outboundPlan.segments;
  if (!segment) return false;
  if (segment.kind !== 'text-line') return true;
  return segment.content.includes('\n');
}
