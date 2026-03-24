import type { Logger } from 'koishi';

type RoomLike = {
  roomId?: number | string;
  conversationId?: string;
  model?: string;
  preset?: string;
};

type MiddlewareContextLike = {
  options?: {
    room?: RoomLike;
  };
};

function trimOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

export function serializeReplyPlanRawOutput(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  }
  if (raw && typeof raw === 'object') {
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  }
  return String(raw ?? '');
}

export function formatStructuredLogBlock(label: string, payload: unknown): string {
  return `${label}\n${serializeReplyPlanRawOutput(payload)}`;
}

export function buildReplyPlanDebugPayload(
  context: MiddlewareContextLike,
  details: Record<string, unknown>,
): Record<string, unknown> {
  const room = context.options?.room;
  return {
    conversationId: trimOptionalText(room?.conversationId) ?? null,
    roomId: room?.roomId ?? null,
    roomModel: trimOptionalText(room?.model) ?? null,
    preset: trimOptionalText(room?.preset) ?? null,
    ...details,
  };
}

export function logReplyPlanDebug(
  logger: Pick<Logger, 'warn'>,
  context: MiddlewareContextLike,
  stage: string,
  details: Record<string, unknown>,
): void {
  logger.warn(
    '%s',
    formatStructuredLogBlock(
      'reply-plan-debug',
      buildReplyPlanDebugPayload(context, { stage, ...details }),
    ),
  );
}
