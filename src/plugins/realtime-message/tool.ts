import { StructuredTool } from '@langchain/core/tools';
import type { Session } from 'koishi';
import type { ChatLunaTool, ChatLunaToolRunnable } from 'koishi-plugin-chatluna/llm-core/platform/types';
import { z } from 'zod';
import {
  buildGroupScopeKey,
  parseFlexibleTimestamp,
  queryRealtimeMessageEntries,
  realtimeMessageCache,
} from './cache.js';

export const REALTIME_MESSAGE_HISTORY_TOOL = 'realtime_message_history';

const RealtimeMessageHistorySchema = z.object({
  scope: z.literal('current_group').default('current_group'),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  order: z.enum(['latest_first', 'oldest_first']).default('latest_first'),
  speakerIds: z.array(z.string().min(1)).optional(),
  keyword: z.string().trim().min(1).optional(),
  since: z.union([z.number(), z.string()]).optional(),
  until: z.union([z.number(), z.string()]).optional(),
  modality: z.enum(['any', 'text', 'image', 'voice', 'mixed']).default('any'),
  includeImages: z.boolean().default(true),
  includeVoiceTranscripts: z.boolean().default(true),
});

type RealtimeToolDeps = {
  resolveRealtimeEnabled: (session: Session) => Promise<boolean>;
};

type ContextWithRealtimeTool = {
  chatluna: {
    platform?: {
      registerTool?: (name: string, tool: ChatLunaTool) => () => void;
    };
  };
};

class RealtimeMessageHistoryTool extends StructuredTool {
  name = REALTIME_MESSAGE_HISTORY_TOOL;

  description =
    'Inspect pending realtime messages collected from the current group but not yet injected into the main conversation history.';

  schema = RealtimeMessageHistorySchema;

  constructor(private readonly deps: RealtimeToolDeps) {
    super({});
  }

  async _call(
    input: z.infer<typeof RealtimeMessageHistorySchema>,
    _runManager: unknown,
    config: ChatLunaToolRunnable,
  ): Promise<string> {
    const session = config.configurable.session as unknown as Session | undefined;
    if (!session?.userId) {
      throw new Error('realtime_message_history requires the current session.');
    }

    const scopeKey = buildGroupScopeKey(session as never);
    if (!scopeKey) {
      return JSON.stringify({
        scope: input.scope,
        total: 0,
        returned: 0,
        items: [],
        error: '当前会话不是群聊，无法查看实时消息缓存。',
      });
    }

    const enabled = await this.deps.resolveRealtimeEnabled(session);
    if (!enabled) {
      realtimeMessageCache.clearGroup(scopeKey);
      return JSON.stringify({
        scope: input.scope,
        total: 0,
        returned: 0,
        items: [],
        reason: '当前群聊未开启实时消息功能。',
      });
    }

    const { total, items } = queryRealtimeMessageEntries(realtimeMessageCache.get(scopeKey), {
      limit: input.limit,
      offset: input.offset,
      order: input.order,
      speakerIds: input.speakerIds,
      keyword: input.keyword,
      since: parseFlexibleTimestamp(input.since),
      until: parseFlexibleTimestamp(input.until),
      modality: input.modality,
    });

    return JSON.stringify({
      scope: input.scope,
      total,
      returned: items.length,
      items: items.map((entry) => ({
        messageId: entry.messageId,
        userId: entry.userId,
        speakerName: entry.speakerName,
        capturedAt: entry.capturedAt,
        modalities: [...entry.modalities],
        text: entry.text,
        imageUrls: input.includeImages ? [...entry.imageUrls] : [],
        voiceTranscript: input.includeVoiceTranscripts ? entry.voiceTranscript : null,
      })),
    });
  }
}

function createRealtimeMessageToolEntry(deps: RealtimeToolDeps): ChatLunaTool {
  return {
    name: REALTIME_MESSAGE_HISTORY_TOOL,
    description:
      'Read pending realtime messages from the current group before they are injected into the main conversation history.',
    selector: () => true,
    authorization: (session) => Boolean(session?.userId),
    createTool: () => new RealtimeMessageHistoryTool(deps),
  };
}

export function registerRealtimeMessageTools(
  ctx: ContextWithRealtimeTool,
  deps: RealtimeToolDeps,
): Array<() => void> {
  const registerTool = ctx.chatluna.platform?.registerTool?.bind(ctx.chatluna.platform);
  if (!registerTool) return [];

  return [registerTool(REALTIME_MESSAGE_HISTORY_TOOL, createRealtimeMessageToolEntry(deps))];
}
