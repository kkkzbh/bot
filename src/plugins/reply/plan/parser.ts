import { z } from 'zod';
import type { ReplyTransportPlan } from '../../shared/outbound/index.js';
import { sanitizeStructuredReplySegmentContent } from '../../shared/outbound/index.js';

const REPLY_PLAN_SCHEMA = z.object({
  segments: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.enum(['text', 'multiline', 'voice', 'sticker']),
          content: z.string(),
        }),
        z.object({
          kind: z.literal('image'),
          asset_ref: z.string(),
          alt: z.string().optional(),
        }),
      ]),
    )
    .min(1),
});

const TERMINAL_TOOL_SCHEMA = z.object({
  name: z.literal('submit_reply_plan'),
  input: REPLY_PLAN_SCHEMA,
});

export interface ReplyPlanParseResult {
  plan: ReplyTransportPlan | null;
  error: string | null;
  terminalToolName: string | null;
}

function normalizePlan(plan: z.infer<typeof REPLY_PLAN_SCHEMA>): ReplyTransportPlan | null {
  const segments = plan.segments
    .map((segment) => {
      if (segment.kind === 'image') {
        const assetRef = segment.asset_ref.trim();
        if (!assetRef) return null;
        const alt = sanitizeStructuredReplySegmentContent(segment.alt ?? '');
        return {
          kind: 'image' as const,
          assetRef,
          ...(alt ? { alt } : {}),
        };
      }

      const content = sanitizeStructuredReplySegmentContent(segment.content);
      if (!content.trim()) return null;
      return {
        kind: segment.kind,
        content,
      };
    })
    .filter(Boolean) as ReplyTransportPlan['segments'];

  return segments.length > 0 ? { segments } : null;
}

export function parseReplyPlanFromToolResult(raw: unknown): ReplyTransportPlan | null {
  return parseReplyPlanFromToolResultDetailed(raw).plan;
}

export function parseReplyPlanFromToolResultDetailed(raw: unknown): ReplyPlanParseResult {
  const additionalKwargs =
    raw && typeof raw === 'object' && 'additional_kwargs' in raw
      ? (raw as { additional_kwargs?: unknown }).additional_kwargs
      : undefined;
  const terminalToolPayload =
    additionalKwargs && typeof additionalKwargs === 'object' && 'chatluna_agent_terminal_tool' in additionalKwargs
      ? (additionalKwargs as { chatluna_agent_terminal_tool?: unknown }).chatluna_agent_terminal_tool
      : undefined;

  if (!terminalToolPayload) {
    return {
      plan: null,
      error: 'reply-agent 未提交 submit_reply_plan 终态工具。',
      terminalToolName: null,
    };
  }

  const parsed = TERMINAL_TOOL_SCHEMA.safeParse(terminalToolPayload);
  if (!parsed.success) {
    const terminalToolName =
      terminalToolPayload && typeof terminalToolPayload === 'object' && 'name' in terminalToolPayload
        ? String((terminalToolPayload as { name?: unknown }).name ?? '')
        : null;
    return {
      plan: null,
      error: `submit_reply_plan 参数不符合 schema：${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`)
        .join('; ')}`,
      terminalToolName,
    };
  }

  const normalizedPlan = normalizePlan(parsed.data.input);
  if (!normalizedPlan) {
    return {
      plan: null,
      error: 'submit_reply_plan 的 segments 在清洗后为空。',
      terminalToolName: parsed.data.name,
    };
  }

  return {
    plan: normalizedPlan,
    error: null,
    terminalToolName: parsed.data.name,
  };
}
