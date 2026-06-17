import type { Session } from 'koishi';
import type { ReplyOutputProtocol } from '../shared/llm/reply-output-contract.js';
import {
  buildReplyOutputContract,
} from '../shared/llm/index.js';
import { mainChatRuntimeState } from '../shared/llm/main-chat-runtime.js';
import {
  buildOutboundMessagePlanFromReplyPlan,
  renderOutboundMessageSegmentsHistoryText,
  type ReplyTransportPlan,
} from '../shared/outbound/index.js';
import type { PromptEnvelopeMessage } from '../shared/prompt-context/index.js';
import {
  buildReplyPromptCompilerInput,
  compileReplyPromptEnvelope,
} from '../reply/prompt/compiler.js';
import { buildReplyTurnInput } from '../reply/pipeline/context-builder.js';
import { ReplyOrchestratorService } from '../reply/pipeline/orchestrator.js';
import {
  buildReplyTransportPlanFromResolvedActions,
  createVoiceRuntimeConfig,
  createVoiceRuntimeConfigFromEnv,
  isVoiceOutputConfigured,
  type RuntimeConfig as ReplyVoiceRuntimeConfig,
} from '../reply/voice/generation.js';
import type { TurnContext } from '../reply/pipeline/types.js';
import type {
  AffinityRandomGenerationInput,
  AffinityRandomGenerationResult,
} from './proactive-types.js';
import {
  buildProactiveMemorySummary,
  buildProactiveTaskFragment,
  resolveProactiveEventTypeHint,
  summarizeProactiveContext,
} from './proactive-task.js';

type ChatLunaMessageLike = {
  content?: unknown;
  additional_kwargs?: Record<string, unknown>;
};

export type AffinityProactiveChatLunaService = {
  chat?: (
    session: Session,
    room: AffinityProactiveChatLunaRoom,
    message: ChatLunaMessageLike,
    events: Record<string, unknown>,
    stream: boolean,
    options: Record<string, unknown>,
    model?: unknown,
    requestId?: string,
    toolMask?: unknown,
  ) => Promise<ChatLunaMessageLike | null | undefined>;
  contextManager?: {
    inject: (options: {
      name: string;
      value: PromptEnvelopeMessage[];
      once?: boolean;
      conversationId?: string;
      stage?: string;
    }) => void;
  };
};

export type AffinityProactiveChatLunaRoom = {
  roomId?: number | string | null;
  roomName?: string | null;
  conversationId?: string | null;
  preset?: string | null;
  model?: string | null;
  chatMode?: string | null;
  [key: string]: unknown;
};

export interface AffinityProactiveGenerationResult extends AffinityRandomGenerationResult {
  transportPlan: ReplyTransportPlan | null;
  assistantHistoryText: string | null;
  outputProtocol: ReplyOutputProtocol | null;
}

const proactiveReplyOrchestrator = new ReplyOrchestratorService();

function createNoopChatEvents(): Record<string, () => Promise<void>> {
  return {
    'llm-new-token': async () => undefined,
    'llm-queue-waiting': async () => undefined,
    'llm-used-token-count': async () => undefined,
    'llm-call-tool': async () => undefined,
    'llm-new-chunk': async () => undefined,
  };
}

export function createAffinityProactiveVoiceRuntime(env: NodeJS.ProcessEnv = process.env): ReplyVoiceRuntimeConfig {
  try {
    return createVoiceRuntimeConfigFromEnv(env);
  } catch {
    return createVoiceRuntimeConfig({
      inputEnabled: false,
      outputEnabled: false,
      asrBaseUrl: '',
      asrApiKey: '',
      ttsBaseUrl: '',
      ttsApiKey: '',
      inputMaxSeconds: 60,
      outputMaxWords: 1000,
      outputMaxSeconds: 600,
      voiceOutputLanguage: 'auto',
      transcribeTimeoutMs: 1000,
      synthTimeoutMs: 1000,
      replyInterruptCollectWindowMs: 1000,
      replyInterruptMaxPendingInputs: 1,
    });
  }
}

function resolveStickerAvailableCount(session: Session): number {
  const state = (session as Session & { state?: Record<string, unknown> }).state;
  const sticker = state?.qqSticker;
  if (!sticker || typeof sticker !== 'object' || Array.isArray(sticker)) return 0;
  const count = (sticker as { availableCount?: unknown }).availableCount;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function buildCapabilitySnapshot(args: {
  runtime: ReplyVoiceRuntimeConfig;
  session: Session;
}): NonNullable<TurnContext['capabilitySnapshot']> {
  const stickerAvailableCount = resolveStickerAvailableCount(args.session);
  return {
    canMultiline: true,
    canMention: true,
    canVoice: isVoiceOutputConfigured(args.runtime),
    voiceOutputLanguage: args.runtime.voiceOutputLanguage,
    canSticker: stickerAvailableCount > 0,
    stickerAvailableCount,
    source: 'affinity_proactive',
  };
}

function buildProactiveTriggerText(input: AffinityRandomGenerationInput): string {
  return [
    '[affinity-proactive-trigger]',
    `direction: ${input.direction}`,
    '请根据已注入的主动发言任务判断是否发送。这不是新的用户聊天内容。',
  ].join('\n');
}

function attachReplyOutputContract(
  message: ChatLunaMessageLike,
  capabilitySnapshot: NonNullable<TurnContext['capabilitySnapshot']>,
): ReturnType<typeof buildReplyOutputContract> {
  const profile = mainChatRuntimeState.getProfile();
  const contract = buildReplyOutputContract({
    profile,
    model: profile.canonicalModel,
    canMention: capabilitySnapshot.canMention !== false,
    canVoice: capabilitySnapshot.canVoice === true,
    canMeme: capabilitySnapshot.canSticker === true,
    voiceOutputLanguage: capabilitySnapshot.voiceOutputLanguage,
  });
  message.additional_kwargs = {
    ...(message.additional_kwargs ?? {}),
    qqbot_reply_mode: 'agent',
    qqbot_final_response_contract: contract,
    ...(contract.overrideRequestParams ? { overrideRequestParams: contract.overrideRequestParams } : {}),
  };
  return contract;
}

function skipResult(reason: string): AffinityProactiveGenerationResult {
  return {
    shouldSend: false,
    message: null,
    contextSeedSummary: null,
    eventTypeHint: 'none',
    memorySummary: null,
    reason,
    risk: 'low',
    skipReason: reason,
    transportPlan: null,
    assistantHistoryText: null,
    outputProtocol: null,
  };
}

export async function generateAffinityProactiveViaChatLuna(args: {
  chatluna: AffinityProactiveChatLunaService | undefined;
  room: AffinityProactiveChatLunaRoom;
  session: Session;
  input: AffinityRandomGenerationInput;
  requestId: string;
  runtime?: ReplyVoiceRuntimeConfig;
}): Promise<AffinityProactiveGenerationResult> {
  const chat = args.chatluna?.chat?.bind(args.chatluna);
  const contextManager = args.chatluna?.contextManager;
  const conversationId = args.room.conversationId?.trim();
  if (typeof chat !== 'function') return skipResult('chatluna_chat_unavailable');
  if (!contextManager || !conversationId) return skipResult('chatluna_context_unavailable');

  const runtime = args.runtime ?? createAffinityProactiveVoiceRuntime();
  const capabilitySnapshot = buildCapabilitySnapshot({
    runtime,
    session: args.session,
  });
  const message: ChatLunaMessageLike = {
    content: buildProactiveTriggerText(args.input),
    additional_kwargs: {},
  };
  const outputContract = attachReplyOutputContract(message, capabilitySnapshot);
  const turnInput = buildReplyTurnInput(args.session, {
    conversationId: conversationId || undefined,
  }, message);
  const taskFragment = buildProactiveTaskFragment(args.input);
  const envelope = compileReplyPromptEnvelope(buildReplyPromptCompilerInput({
    input: turnInput,
    capabilitySnapshot,
    continuationContext: null,
  }, [taskFragment], {
    outputProtocol: outputContract.protocol,
  }));
  if (!envelope?.messages.length) return skipResult('prompt_envelope_empty');

  contextManager.inject({
    name: 'qqbot_affinity_proactive_prompt_envelope',
    value: envelope.messages,
    once: true,
    conversationId,
    stage: 'after_scratchpad',
  });

  try {
    const response = await chat(
      args.session,
      args.room,
      message,
      createNoopChatEvents(),
      false,
      {},
      undefined,
      args.requestId,
    );
    const orchestration = await proactiveReplyOrchestrator.handle(turnInput, args.session, {
      responseMessage: response,
      outputProtocol: outputContract.protocol,
      capabilitySnapshot,
      routeHint: 'agent',
    });
    if (orchestration.status === 'no_reply') return skipResult('provider_no_reply');
    if (orchestration.status !== 'ready') return skipResult('provider_await_model');
    if (orchestration.actions.length === 1 && orchestration.actions[0]?.kind === 'no_reply') {
      return skipResult('provider_no_reply');
    }

    const transportPlan = buildReplyTransportPlanFromResolvedActions(orchestration.actions);
    const visibleSummary = renderOutboundMessageSegmentsHistoryText(
      buildOutboundMessagePlanFromReplyPlan(transportPlan).segments,
    );
    if (!transportPlan.segments.length || !visibleSummary) return skipResult('empty_reply_plan');

    return {
      shouldSend: true,
      message: visibleSummary,
      contextSeedSummary: summarizeProactiveContext(args.input),
      eventTypeHint: resolveProactiveEventTypeHint(args.input.direction),
      memorySummary: buildProactiveMemorySummary(args.input, visibleSummary),
      reason: 'chatluna_provider_reply',
      risk: 'low',
      skipReason: null,
      transportPlan,
      assistantHistoryText: orchestration.assistantHistoryText,
      outputProtocol: outputContract.protocol,
    };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'StructuredReplyCompilerError'
      ? 'structured_reply_invalid'
      : error instanceof Error && error.name === 'StructuredReplyEmptyModelOutputError'
        ? 'empty_model_output'
        : 'chatluna_generation_error';
    return skipResult(reason);
  }
}
