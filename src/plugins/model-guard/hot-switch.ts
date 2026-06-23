import { resolveMainChatModelDescriptor } from '../shared/llm/index.js';
import { mainChatRuntimeState } from '../shared/llm/main-chat-runtime.js';

export type MainChatRoomModelLike = {
  model?: string;
  conversationId?: string;
  [key: string]: unknown;
};

export type MainChatRoomModelSyncResult = {
  changed: boolean;
  originalModel: string | null;
  generation: number;
  canonicalModel: string;
  transportModel: string;
  strategyId: string;
  requestMode: string;
  outputProtocol: string;
};

function trimOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

export async function syncRoomModelToMainChatRuntime(args: {
  room: MainChatRoomModelLike;
  clearCache?: (room: MainChatRoomModelLike) => Promise<unknown>;
  updateConversationModel?: (conversationId: string, model: string) => Promise<unknown>;
}): Promise<MainChatRoomModelSyncResult> {
  const profile = mainChatRuntimeState.getProfile();
  const descriptor = resolveMainChatModelDescriptor({
    tabId: profile.tabId,
    model: profile.canonicalModel,
  });
  const originalModel = trimOptionalText(args.room.model);
  const changed = descriptor.canonicalModel !== originalModel;

  if (changed) {
    const conversationId = trimOptionalText(args.room.conversationId);
    if (!conversationId) {
      throw new Error('conversationId is required before syncing the active chat model.');
    }
    if (args.clearCache) {
      await args.clearCache(args.room);
    }
    if (args.updateConversationModel) {
      await args.updateConversationModel(conversationId, descriptor.canonicalModel);
    }
    args.room.model = descriptor.canonicalModel;
  }

  return {
    changed,
    originalModel,
    generation: mainChatRuntimeState.getGeneration(),
    canonicalModel: descriptor.canonicalModel,
    transportModel: descriptor.transportModel,
    strategyId: descriptor.strategyId,
    requestMode: descriptor.requestMode,
    outputProtocol: profile.structuredOutputProtocol,
  };
}
