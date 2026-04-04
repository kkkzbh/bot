import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Context, h, Logger, Schema, type Session, type Universal } from 'koishi';
import type { FeaturePolicyServiceLike } from '../../../types/feature-policy.js';
import type { ScopedFeatureKey } from '../../../types/feature-policy.js';
import {
  createStickerHistoryLine,
  resolveStickerSelection,
  type StickerCapabilityState,
} from '../../sticker/index.js';
import {
  buildVoiceFailureReply,
  extractFirstIncomingVoice,
  extractTextContentWithoutVoice,
  mergeVoiceInputText,
  normalizeVoiceSynthesisText,
  pickVoiceStyle,
} from './tts.js';
import {
  buildOutboundMessagePlanFromReplyPlan,
  createBotMessageDispatchers,
  createSessionMessageDispatchers,
  createQuotedMessageContent,
  createKeyedStrandRunner,
    dispatchOutboundMessagePlan,
    renderRichTextSegmentsMessageContent,
    renderRichTextSegmentsVisibleText,
    resolveReplyActorKey,
    resolveReplyQueueKey,
    sanitizeStructuredReplySegmentContent,
  sendBotMessageByNormalizedContent,
  type BotMessageContent,
  type OutboundMessagePlan,
  type OutboundMessageSegment,
  type ReplyTransportPlan,
} from '../../shared/outbound/index.js';
import {
  clearPromptAssemblyTurn,
  peekPromptFragments,
  registerPromptFragment,
  type PromptEnvelopeMessage,
} from '../../shared/prompt-context/index.js';
import {
  registerReplyToolMemoryFragment,
} from '../pipeline/protocol.js';
import { normalizeReplyChatMode } from '../compat.js';
import { ReplyOrchestratorService } from '../pipeline/orchestrator.js';
import { buildReplyTurnInput, normalizeReplyRouteHint } from '../pipeline/context-builder.js';
import {
  buildStructuredReplyRequestSpec,
  isSupportedMainChatModelForTab,
  resolveMainChatRuntimeProfileFromEnv,
} from '../../shared/llm/index.js';
import {
  STRUCTURED_REPLY_V1_JSON_SCHEMA,
  type ReplyRoute,
  type ResolvedAction,
  type TurnContext,
  type TurnInput,
} from '../pipeline/types.js';
import {
  buildReplyPromptCompilerInput,
  compileReplyPromptEnvelope,
} from '../prompt/compiler.js';
import {
  ReplyRuntime,
  type ReplyTurnContinuationContext,
  type ReplyRunMode,
  type ReplyRuntimeRoomLike,
} from '../runtime/index.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
};

const logger = new Logger('qq-voice');
const TTS_PROBE_TURN_INTERVAL = 12;
const TTS_PROBE_TIME_INTERVAL_MS = 45_000;
const TTS_PROBE_FAILURE_BACKOFF_MS = 10_000;
const TTS_PROBE_TIMEOUT_MS = 5_000;
const VOICE_WORD_SEGMENTER =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh', { granularity: 'word' })
    : null;
export const name = 'qq-voice';
export const inject = { required: ['chatluna', 'database'], optional: ['featurePolicy'] } as const;
const sharedReplyTransportSendStrand = createKeyedStrandRunner();
const sharedReplyTransportCanSendRecordCache = new Map<string, boolean>();
const sharedReplyTransportTtsCapabilityStates = new Map<string, TtsCapabilityState>();

export interface Config {
  inputEnabled?: boolean;
  outputEnabled?: boolean;
  asrBaseUrl?: string;
  asrApiKey?: string;
  ttsBaseUrl?: string;
  ttsApiKey?: string;
  inputMaxSeconds?: number;
  outputMaxWords?: number;
  outputMaxSeconds?: number;
  transcribeTimeoutMs?: number;
  synthTimeoutMs?: number;
  replyInterruptCollectWindowMs?: number;
  replyInterruptMaxPendingInputs?: number;
}

export const Config: Schema<Config> = Schema.object({
  inputEnabled: Schema.boolean().default(true).description('是否启用 QQ 语音转文字。'),
  outputEnabled: Schema.boolean().default(true).description('是否启用 QQ 文本附带语音回复。'),
  asrBaseUrl: Schema.string().role('link').description('ASR HTTP 服务地址（默认复用 QQ_VOICE_ASR_BASE_URL）。'),
  asrApiKey: Schema.string().role('secret').description('ASR HTTP 服务鉴权 token。'),
  ttsBaseUrl: Schema.string().role('link').description('TTS HTTP 服务地址（默认复用 QQ_VOICE_TTS_BASE_URL）。'),
  ttsApiKey: Schema.string().role('secret').description('TTS HTTP 服务鉴权 token。'),
  inputMaxSeconds: Schema.natural().default(60).description('单条入站语音最大时长（秒）。'),
  outputMaxWords: Schema.natural().default(80).description('单个语音段最大词数。'),
  outputMaxSeconds: Schema.natural().default(45).description('单个语音段最大时长（秒）。'),
  transcribeTimeoutMs: Schema.natural().role('time').default(30000).description('ASR 请求超时（毫秒）。'),
  synthTimeoutMs: Schema.natural().role('time').default(300000).description('TTS 请求超时（毫秒）。'),
  replyInterruptCollectWindowMs: Schema.natural().role('time').default(400).description('回复中断聚合窗口（毫秒）。'),
  replyInterruptMaxPendingInputs: Schema.natural().default(8).description('回复中断最多暂存的新消息条数。'),
});

export interface RuntimeConfig {
  inputEnabled: boolean;
  outputEnabled: boolean;
  asrBaseUrl: string;
  asrApiKey: string;
  ttsBaseUrl: string;
  ttsApiKey: string;
  inputMaxSeconds: number;
  outputMaxWords: number;
  outputMaxSeconds: number;
  transcribeTimeoutMs: number;
  synthTimeoutMs: number;
  replyInterruptCollectWindowMs: number;
  replyInterruptMaxPendingInputs: number;
}

interface QqVoiceState {
  transcript: string;
  durationMs: number;
  source: string;
}

type ReplyCapabilitySource = 'cached' | 'probed';

export interface ReplyCapabilitySnapshot {
  canMultiline: true;
  canVoice: boolean;
  source: ReplyCapabilitySource;
  refreshedAt: number;
}

interface ReplyTransportState {
  capabilitySnapshot?: ReplyCapabilitySnapshot;
  runId?: string;
  suppressErrorNotice?: boolean;
}

interface ReplyV2State {
  route?: ReplyRoute;
}

type SessionWithVoiceState = Session & {
  stripped?: { content?: string };
  state?: Record<string, unknown> & {
    qqVoice?: QqVoiceState;
    qqReplyTransport?: ReplyTransportState;
    qqReplyV2?: ReplyV2State;
    qqSticker?: StickerCapabilityState;
  };
};

export type OneBotInternalLike = {
  _request?: (action: string, params?: Record<string, unknown>) => Promise<unknown>;
  canSendRecord?: () => Promise<boolean>;
  getRecord?: (file: string, format: 'wav', fullPath?: boolean) => Promise<{ file?: string }>;
  sendPrivateMsg?: (...args: unknown[]) => Promise<unknown>;
  sendGroupMsg?: (...args: unknown[]) => Promise<unknown>;
};

export type OneBotBotLike = {
  selfId?: string;
  platform?: string;
  internal?: OneBotInternalLike;
  sendMessage: (
    channelId: string,
    content: BotMessageContent,
    guildId?: string,
    options?: Universal.SendOptions,
  ) => Promise<unknown>;
};

type RoomLike = {
  conversationId?: string;
  roomId?: number | string;
  model?: string;
  preset?: string;
  [key: string]: unknown;
};

type MiddlewareContextLike = {
  options?: {
    room?: RoomLike;
    messageId?: string;
    inputMessage?: {
      content?: unknown;
      additional_kwargs?: Record<string, unknown>;
    };
    responseMessage?: {
      content?: unknown;
      additional_kwargs?: Record<string, unknown>;
    } | null;
  };
};

type InputMessageContentPart = {
  type?: unknown;
  text?: unknown;
};

type ReplyInputContentMeta = {
  hasImageInput: boolean;
  imageCount: number;
};

type ReplySpeakerFormatMeta = {
  version: 'speaker_id_v1';
  speakerId: string;
  speakerName: string;
  isDirect: boolean;
  preformatted?: boolean;
};

interface DownloadedAudioPayload {
  bytes: Uint8Array;
  source: string;
  filename: string;
  contentType: string;
}

interface AsrResponse {
  text: string;
  language?: string;
  durationMs: number;
}

interface TtsCapabilityState {
  lastKnownHealthy: boolean | null;
  lastProbeAt: number;
  lastProbeTurn: number;
  turnCounter: number;
  pendingProbe: Promise<boolean> | null;
  failureBackoffUntil: number;
}

interface PreparedVoiceDelivery {
  segment: OutboundMessageSegment & { kind: 'voice-block' };
  text: string;
  style: 'white' | 'black';
  wav: Uint8Array;
}

interface PreparedStickerDelivery {
  segment: OutboundMessageSegment & { kind: 'sticker-block' };
  historyLine: string;
  buffer: Buffer;
  mime: string;
}

type ReplyPlanDeliveryResult =
  | { status: 'delivered'; historyText: string }
  | { status: 'failed_before_send'; fallbackText: string; historyText: string }
  | { status: 'failed_after_partial_send'; historyText: string }
  | { status: 'interrupted'; historyText: string };

type ChatLunaLike = {
  chat?: unknown;
  stopChat?: (room: unknown, requestId: string) => Promise<boolean>;
  createChatModel?: (fullModelName: string) => Promise<{ value?: { invoke: (input: unknown, options?: Record<string, unknown>) => Promise<{ content?: unknown }> } | undefined }>;
  contextManager?: {
    inject: (options: {
      name: string;
      value: unknown;
      once?: boolean;
      conversationId?: string;
      stage?: string;
    }) => void;
  };
  normalizeResearchReplyHistory?: (
    room: unknown,
    finalVisibleText: string,
    updatedAt?: Date,
  ) => Promise<unknown>;
  normalizeReplyAgentHistory?: (
    room: unknown,
    finalVisibleText: string,
    updatedAt?: Date,
  ) => Promise<unknown>;
  chatChain?: {
    middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => {
      after: (name: string) => { before: (name: string) => unknown };
      before: (name: string) => unknown;
    };
    receiveMessage?: (session: unknown, ctx?: unknown) => Promise<unknown>;
  };
};

type ChatLunaChainLike = NonNullable<ChatLunaLike['chatChain']>;
type ChatLunaChainBuilderLike = ReturnType<ChatLunaChainLike['middleware']>;

type ContextWithChatLuna = Context & { chatluna?: ChatLunaLike; featurePolicy?: FeaturePolicyServiceLike };
type RuntimeRole = 'local' | 'server' | 'unknown';

function normalizeBaseUrl(input?: string | null): string {
  return String(input ?? '').trim().replace(/\/+$/, '');
}

function clampNatural(input: unknown, fallback: number): number {
  const value = Number(input);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function detectRuntimeRole(): RuntimeRole {
  const candidates = [
    process.env.QQBOT_ENV_BASE_FILE,
    process.env.QQBOT_ENV_FILE,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  if (candidates.some((value) => value.endsWith('.env.server'))) {
    return 'server';
  }

  if (candidates.some((value) => value.endsWith('.env.local'))) {
    return 'local';
  }

  return 'unknown';
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.trim().toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return /:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(url);
  }
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  return {
    inputEnabled: config.inputEnabled ?? String(process.env.QQ_VOICE_INPUT_ENABLED ?? 'true').toLowerCase() !== 'false',
    outputEnabled:
      config.outputEnabled ?? String(process.env.QQ_VOICE_OUTPUT_ENABLED ?? 'true').toLowerCase() !== 'false',
    asrBaseUrl: normalizeBaseUrl(config.asrBaseUrl ?? process.env.QQ_VOICE_ASR_BASE_URL),
    asrApiKey: config.asrApiKey ?? process.env.QQ_VOICE_ASR_API_KEY ?? '',
    ttsBaseUrl: normalizeBaseUrl(config.ttsBaseUrl ?? process.env.QQ_VOICE_TTS_BASE_URL),
    ttsApiKey: config.ttsApiKey ?? process.env.QQ_VOICE_TTS_API_KEY ?? '',
    inputMaxSeconds: clampNatural(config.inputMaxSeconds ?? process.env.QQ_VOICE_INPUT_MAX_SECONDS, 60),
    outputMaxWords: clampNatural(config.outputMaxWords ?? process.env.QQ_VOICE_OUTPUT_MAX_WORDS, 80),
    outputMaxSeconds: clampNatural(config.outputMaxSeconds ?? process.env.QQ_VOICE_OUTPUT_MAX_SECONDS, 45),
    transcribeTimeoutMs: clampNatural(
      config.transcribeTimeoutMs ?? process.env.QQ_VOICE_TRANSCRIBE_TIMEOUT_MS,
      30_000,
    ),
    synthTimeoutMs: clampNatural(config.synthTimeoutMs ?? process.env.QQ_VOICE_SYNTH_TIMEOUT_MS, 300_000),
    replyInterruptCollectWindowMs: clampNatural(
      config.replyInterruptCollectWindowMs ?? process.env.QQBOT_REPLY_COLLECT_WINDOW_MS,
      400,
    ),
    replyInterruptMaxPendingInputs: clampNatural(
      config.replyInterruptMaxPendingInputs ?? process.env.QQBOT_REPLY_MAX_PENDING_INPUTS,
      8,
    ),
  };
}

export function createVoiceRuntimeConfig(config: Config = {}): RuntimeConfig {
  return toRuntimeConfig(config);
}

function assertVoiceRuntimeConfig(runtime: RuntimeConfig): void {
  const runtimeRole = detectRuntimeRole();

  if (runtimeRole === 'server' && runtime.inputEnabled) {
    throw new Error('server runtime does not support QQ voice input; keep QQ_VOICE_INPUT_ENABLED=false.');
  }

  if (runtime.inputEnabled && !runtime.asrBaseUrl) {
    throw new Error('QQ voice input is enabled but QQ_VOICE_ASR_BASE_URL is empty.');
  }

  if (!runtime.outputEnabled) {
    return;
  }

  if (!runtime.ttsBaseUrl) {
    throw new Error('QQ voice output is enabled but QQ_VOICE_TTS_BASE_URL is empty.');
  }

  if (!runtime.ttsApiKey.trim()) {
    throw new Error('QQ voice output is enabled but QQ_VOICE_TTS_API_KEY is empty.');
  }

  if (runtimeRole === 'server' && isLoopbackUrl(runtime.ttsBaseUrl)) {
    throw new Error('server QQ voice output must point to a laptop Tailnet TTS endpoint, not a loopback address.');
  }
}

function createAuthHeaders(apiKey: string): Record<string, string> {
  const token = apiKey.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function decodeBase64Payload(payload: string): Uint8Array {
  return Uint8Array.from(Buffer.from(payload, 'base64'));
}

function parseDataUri(uri: string): { bytes: Uint8Array; contentType: string } | null {
  const matched = uri.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!matched) return null;
  return {
    contentType: matched[1] ?? 'application/octet-stream',
    bytes: decodeBase64Payload(matched[2] ?? ''),
  };
}

function guessContentTypeFromPath(pathLike: string): string {
  const normalized = pathLike.toLowerCase();
  if (normalized.endsWith('.wav')) return 'audio/wav';
  if (normalized.endsWith('.mp3')) return 'audio/mpeg';
  if (normalized.endsWith('.ogg')) return 'audio/ogg';
  if (normalized.endsWith('.amr')) return 'audio/amr';
  if (normalized.endsWith('.m4a')) return 'audio/mp4';
  return 'application/octet-stream';
}

async function fetchBytes(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`http ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function loadAudioResource(resource: string, timeoutMs: number): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (resource.startsWith('data:')) {
    const parsed = parseDataUri(resource);
    if (!parsed) throw new Error('invalid data uri');
    return parsed;
  }

  if (resource.startsWith('base64://')) {
    return {
      bytes: decodeBase64Payload(resource.slice('base64://'.length)),
      contentType: 'application/octet-stream',
    };
  }

  if (/^https?:\/\//i.test(resource)) {
    return {
      bytes: await fetchBytes(resource, {}, timeoutMs),
      contentType: guessContentTypeFromPath(resource),
    };
  }

  const bytes = new Uint8Array(await readFile(resource));
  return {
    bytes,
    contentType: guessContentTypeFromPath(resource),
  };
}

async function downloadIncomingAudio(
  session: SessionWithVoiceState,
  runtime: RuntimeConfig,
  bot: OneBotBotLike,
): Promise<DownloadedAudioPayload> {
  const incoming = extractFirstIncomingVoice(session.content ?? '');
  if (!incoming) {
    throw new Error('missing voice element');
  }

  if (incoming.src) {
    try {
      const payload = await loadAudioResource(incoming.src, runtime.transcribeTimeoutMs);
      return {
        ...payload,
        source: 'src',
        filename: 'qq-voice-input',
      };
    } catch (error) {
      logger.warn('voice src fetch failed, fallback to get_record: %s', (error as Error).message);
    }
  }

  if (!incoming.file || typeof bot.internal?.getRecord !== 'function') {
    throw new Error('voice record id unavailable');
  }

  const record = await bot.internal.getRecord(incoming.file, 'wav');
  if (!record?.file) {
    throw new Error('get_record returned empty file');
  }

  const payload = await loadAudioResource(record.file, runtime.transcribeTimeoutMs);
  return {
    ...payload,
    source: 'get_record',
    filename: 'qq-voice-input.wav',
  };
}

async function transcribeAudio(runtime: RuntimeConfig, audio: DownloadedAudioPayload): Promise<AsrResponse> {
  if (!runtime.asrBaseUrl) {
    throw new Error('missing ASR base url');
  }

  const form = new FormData();
  form.append(
    'file',
    new Blob([Buffer.from(audio.bytes)], {
      type: audio.contentType || 'application/octet-stream',
    }),
    audio.filename,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.transcribeTimeoutMs);

  try {
    const response = await fetch(`${runtime.asrBaseUrl}/transcribe`, {
      method: 'POST',
      headers: createAuthHeaders(runtime.asrApiKey),
      body: form,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`ASR http ${response.status}`);
    }

    const payload = (await response.json()) as Partial<AsrResponse>;
    return {
      text: String(payload.text ?? '').trim(),
      language: typeof payload.language === 'string' ? payload.language : undefined,
      durationMs: Number(payload.durationMs ?? 0),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function synthesizeVoice(
  runtime: RuntimeConfig,
  text: string,
  style: 'white' | 'black',
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!runtime.ttsBaseUrl) {
    throw new Error('missing TTS base url');
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), runtime.synthTimeoutMs);

  try {
    const response = await fetch(`${runtime.ttsBaseUrl}/synthesize`, {
      method: 'POST',
      headers: {
        ...createAuthHeaders(runtime.ttsApiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        speaker: 'sakiko',
        style,
        format: 'wav',
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`TTS http ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function createAudioDataUri(bytes: Uint8Array): string {
  return `data:audio/wav;base64,${Buffer.from(bytes).toString('base64')}`;
}

function countVoiceWords(text: string): number {
  const normalized = normalizeVoiceSynthesisText(text);
  if (!normalized) return 0;

  if (VOICE_WORD_SEGMENTER) {
    let count = 0;
    for (const segment of VOICE_WORD_SEGMENTER.segment(normalized)) {
      if (segment.isWordLike) count += 1;
    }
    if (count > 0) return count;
  }

  return normalized.split(/\s+/).filter(Boolean).length;
}

function estimateWavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readChunkId = (offset: number): string => Buffer.from(bytes.subarray(offset, offset + 4)).toString('ascii');

  if (readChunkId(0) !== 'RIFF' || readChunkId(8) !== 'WAVE') {
    return null;
  }

  const byteRate = view.getUint32(28, true);
  if (!byteRate) return null;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readChunkId(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'data') {
      return Math.round((chunkSize / byteRate) * 1000);
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  return null;
}

function getTextInputContent(session: SessionWithVoiceState): string {
  const stripped = session.stripped?.content?.trim();
  if (stripped) return stripped;
  return extractTextContentWithoutVoice(session.content ?? '');
}

function updateVoiceState(session: SessionWithVoiceState, state: QqVoiceState): void {
  const current = session.state ?? {};
  current.qqVoice = state;
  session.state = current;
}

async function sendFailureReply(session: SessionWithVoiceState, message: string): Promise<void> {
  if (!session.channelId) {
    const { sendWhole } = createSessionMessageDispatchers(session);
    await sendWhole(message);
    return;
  }

  await sendBotMessageByNormalizedContent(session.bot as OneBotBotLike, session.channelId, message, session);
}

function downgradeVoiceSegmentsToText(plan: ReplyTransportPlan): ReplyTransportPlan {
  return {
    segments: plan.segments.map((segment) =>
      segment.kind === 'voice'
        ? {
            kind: 'text',
            content: segment.content,
          }
        : segment,
    ),
  };
}

function removeStickerSegments(plan: ReplyTransportPlan): ReplyTransportPlan {
  return {
    segments: plan.segments.filter((segment) => segment.kind !== 'sticker'),
  };
}

export function buildReplyTransportPlanFromResolvedActions(actions: ResolvedAction[]): ReplyTransportPlan {
  const segments: ReplyTransportPlan['segments'] = [];

  for (const action of actions) {
    if (action.kind === 'no_reply') {
      continue;
    }
    if (action.kind === 'multiline') {
      segments.push({
        kind: 'multiline' as const,
        content: action.content,
      });
      continue;
    }
    if (action.kind === 'voice') {
      segments.push({
        kind: 'voice' as const,
        content: action.content,
      });
      continue;
    }
    if (action.kind === 'rich_text') {
      segments.push({
        kind: 'rich_text' as const,
        segments: action.segments,
      });
      continue;
    }
    if (action.kind === 'sticker') {
      segments.push({
        kind: 'sticker' as const,
        content: action.intent,
      });
      continue;
    }
    segments.push({
      kind: 'text' as const,
      content: action.content,
    });
  }

  return { segments };
}

function renderReplyPlanSegmentTextForFallback(segment: ReplyTransportPlan['segments'][number]): string {
  if (segment.kind === 'sticker') return '';
  if (segment.kind === 'image') {
    return sanitizeStructuredReplySegmentContent(segment.alt ?? '');
  }
  if (segment.kind === 'rich_text') {
    return renderRichTextSegmentsVisibleText(segment.segments);
  }
  return sanitizeStructuredReplySegmentContent(segment.content);
}

function renderReplyPlanFallbackText(plan: ReplyTransportPlan): string {
  return plan.segments
    .map((segment) => renderReplyPlanSegmentTextForFallback(segment))
    .filter((segment) => segment.trim().length > 0)
    .join('\n')
    .trim();
}

function renderDeliveredReplyPlanHistoryText(
  plan: ReplyTransportPlan,
  preparedStickerByRaw: Map<string, PreparedStickerDelivery> = new Map(),
): string {
  const outboundPlan = buildOutboundMessagePlanFromReplyPlan(plan);
  const stickerHistoryByRaw = new Map(
    [...preparedStickerByRaw.entries()].map(([raw, prepared]) => [raw, prepared.historyLine] as const),
  );
  const stickerSegments = outboundPlan.segments.filter(
    (segment): segment is OutboundMessageSegment & { kind: 'sticker-block' } => segment.kind === 'sticker-block',
  );
  let stickerIndex = 0;

  return plan.segments
    .map((segment) => {
      if (segment.kind === 'image') {
        return segment.alt ? `（发送图片：${segment.alt}）` : '（发送图片）';
      }

      if (segment.kind === 'voice') {
        return `（发送语音：${sanitizeStructuredReplySegmentContent(segment.content)}）`;
      }

      if (segment.kind === 'rich_text') {
        return renderRichTextSegmentsVisibleText(segment.segments);
      }

      if (segment.kind !== 'sticker') {
        return sanitizeStructuredReplySegmentContent(segment.content);
      }

      const outboundSticker = stickerSegments[stickerIndex];
      stickerIndex += 1;
      return outboundSticker ? stickerHistoryByRaw.get(outboundSticker.raw) ?? '（发送表情包）' : '（发送表情包）';
    })
    .filter((segment) => segment.trim().length > 0)
    .join('\n')
    .trim();
}

function buildPlannedUnitHistoryLines(args: {
  outboundPlan: OutboundMessagePlan;
  preparedVoiceByRaw: Map<string, PreparedVoiceDelivery>;
  preparedStickerByRaw: Map<string, PreparedStickerDelivery>;
}): string[] {
  const { outboundPlan, preparedVoiceByRaw, preparedStickerByRaw } = args;
  return outboundPlan.segments.map((segment) => {
    if (segment.kind === 'text-line' || segment.kind === 'multiline-block') {
      return segment.content;
    }
    if (segment.kind === 'rich-text-block') {
      return renderRichTextSegmentsVisibleText(segment.segments);
    }
    if (segment.kind === 'image-block') {
      return segment.alt ? `（发送图片：${segment.alt}）` : '（发送图片）';
    }
    if (segment.kind === 'sticker-block') {
      return preparedStickerByRaw.get(segment.raw)?.historyLine ?? '（发送表情包）';
    }
    return `（发送语音：${preparedVoiceByRaw.get(segment.raw)?.text ?? segment.content}）`;
  });
}

function buildOptimisticPlannedUnitHistoryLines(plan: ReplyTransportPlan): string[] {
  return buildPlannedUnitHistoryLines({
    outboundPlan: buildOutboundMessagePlanFromReplyPlan(plan),
    preparedVoiceByRaw: new Map(),
    preparedStickerByRaw: new Map(),
  });
}

async function normalizeResearchReplyHistory(
  ctx: Context,
  room: Record<string, unknown> | undefined,
  messageText: string,
): Promise<void> {
  const chatluna = (ctx.get?.('chatluna') ?? (ctx as { chatluna?: any }).chatluna) as
    | {
        normalizeResearchReplyHistory?: (room: Record<string, unknown>, finalVisibleText: string) => Promise<unknown>;
      }
    | undefined;
  const conversationId = typeof room?.conversationId === 'string' ? room.conversationId.trim() : '';
  const normalizeHistory = chatluna?.normalizeResearchReplyHistory?.bind(chatluna);
  if (!normalizeHistory || !conversationId) return;
  await normalizeHistory(room!, messageText.trim());
}

export async function ensureCanSendRecord(
  bot: OneBotBotLike,
  capabilityCache: Map<string, boolean>,
  force = false,
): Promise<boolean> {
  const cacheKey = `${bot.platform ?? 'onebot'}:${bot.selfId ?? 'default'}`;
  if (!force && capabilityCache.has(cacheKey)) {
    return capabilityCache.get(cacheKey) ?? false;
  }

  if (typeof bot.internal?._request !== 'function') {
    if (
      typeof bot.internal?.sendPrivateMsg === 'function' ||
      typeof bot.internal?.sendGroupMsg === 'function'
    ) {
      logger.warn('internal._request is unavailable for %s, fallback to optimistic record support.', cacheKey);
      capabilityCache.set(cacheKey, true);
      return true;
    }

    capabilityCache.delete(cacheKey);
    return false;
  }

  let result = false;
  try {
    result = (await bot.internal?.canSendRecord?.()) ?? false;
  } catch (error) {
    if (
      /_request is not a function/i.test((error as Error).message) &&
      (typeof bot.internal?.sendPrivateMsg === 'function' || typeof bot.internal?.sendGroupMsg === 'function')
    ) {
      logger.warn('canSendRecord probe is broken for %s, fallback to optimistic record support.', cacheKey);
      capabilityCache.set(cacheKey, true);
      return true;
    }

    logger.warn('canSendRecord failed for %s: %s', cacheKey, (error as Error).message);
    capabilityCache.delete(cacheKey);
    return false;
  }

  capabilityCache.set(cacheKey, result);
  return result;
}

export function isVoiceOutputConfigured(runtime: RuntimeConfig): boolean {
  return Boolean(runtime.ttsBaseUrl);
}

function getReplyTransportState(session: SessionWithVoiceState): ReplyTransportState {
  const current = session.state ?? {};
  const transportState = current.qqReplyTransport ?? {};
  current.qqReplyTransport = transportState;
  session.state = current;
  return transportState;
}

function getReplyCapabilitySnapshot(session: SessionWithVoiceState): ReplyCapabilitySnapshot | undefined {
  return session.state?.qqReplyTransport?.capabilitySnapshot;
}

function setReplyCapabilitySnapshot(session: SessionWithVoiceState, snapshot: ReplyCapabilitySnapshot): void {
  getReplyTransportState(session).capabilitySnapshot = snapshot;
}

function getReplyRunId(session: SessionWithVoiceState): string | undefined {
  const runId = session.state?.qqReplyTransport?.runId;
  return typeof runId === 'string' && runId.trim() ? runId.trim() : undefined;
}

function setReplyRunId(session: SessionWithVoiceState, runId: string): void {
  getReplyTransportState(session).runId = runId;
}

function getReplyV2State(session: SessionWithVoiceState): ReplyV2State {
  const current = session.state ?? {};
  const replyV2 = current.qqReplyV2 ?? {};
  current.qqReplyV2 = replyV2;
  session.state = current;
  return replyV2;
}

function getReplyRouteState(session: SessionWithVoiceState): ReplyRoute | null {
  const route = session.state?.qqReplyV2?.route;
  return route ?? null;
}

function setReplyRouteState(session: SessionWithVoiceState, route: ReplyRoute): void {
  getReplyV2State(session).route = route;
}

export function buildTurnCapabilitySnapshot(session: SessionWithVoiceState, snapshot: ReplyCapabilitySnapshot): NonNullable<TurnContext['capabilitySnapshot']> {
  const stickerState = session.state?.qqSticker;
  const stickerAvailableCount = stickerState?.availableCount ?? 0;
  return {
    canMultiline: snapshot.canMultiline,
    canVoice: snapshot.canVoice,
    canSticker: stickerAvailableCount > 0,
    stickerAvailableCount,
    source: snapshot.source,
  };
}

function resolveBooleanEnv(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized !== 'false';
}

function ensureReplyPluginRoom(room: ReplyRuntimeRoomLike | undefined): void {
  const chatMode = String((room as { chatMode?: unknown } | undefined)?.chatMode ?? '').trim();
  if (chatMode === 'plugin') return;

  throw new Error(`qqbot reply requires room.chatMode=plugin, got ${chatMode || 'unknown'}.`);
}

export function ensureStructuredReplyJsonSchemaModel(room: ReplyRuntimeRoomLike | undefined): void {
  const model = typeof room?.model === 'string' ? room.model.trim() : '';
  const profile = resolveMainChatRuntimeProfileFromEnv(process.env);
  const strategyModel = model || profile.defaultModel;
  if (isSupportedMainChatModelForTab(profile.tabId, strategyModel)) return;

  throw new Error(`qqbot reply structured output requires a supported main chat model, got ${model || 'unknown'}.`);
}

export function applyReplyStructuredOutputRequest(
  room: ReplyRuntimeRoomLike | undefined,
  inputMessage: NonNullable<MiddlewareContextLike['options']>['inputMessage'] | undefined,
  options: {
    replyMode?: 'agent' | 'automation';
    includeFinalResponseInstruction?: boolean;
  } = {},
): void {
  if (!inputMessage) return;

  const profile = resolveMainChatRuntimeProfileFromEnv(process.env);
  const structuredOutputSpec = buildStructuredReplyRequestSpec({
    profile,
    model: typeof room?.model === 'string' ? room.model.trim() : profile.defaultModel,
  });
  const overrideRequestParams = mergeReplyOverrideRequestParams(inputMessage.additional_kwargs, structuredOutputSpec.overrideRequestParams);
  const replyMode = options.replyMode ?? 'agent';
  const includeFinalResponseInstruction = options.includeFinalResponseInstruction !== false;

  inputMessage.additional_kwargs = {
    ...(inputMessage.additional_kwargs ?? {}),
    qqbot_reply_mode: replyMode,
    qqbot_final_response_schema: structuredOutputSpec.finalResponseSchema ?? STRUCTURED_REPLY_V1_JSON_SCHEMA,
    ...(includeFinalResponseInstruction && structuredOutputSpec.finalResponseInstruction
      ? { qqbot_final_response_instruction: structuredOutputSpec.finalResponseInstruction }
      : {}),
    ...(overrideRequestParams ? { overrideRequestParams } : {}),
  };
}

export function mergeReplyOverrideRequestParams(
  additionalKwargs: Record<string, unknown> | undefined,
  overridePatch: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const existingOverride =
    asPlainRecord(additionalKwargs?.overrideRequestParams) ??
    asPlainRecord(additionalKwargs?.qqbot_override_request_params);

  if (!existingOverride && !overridePatch) return null;
  return {
    ...(existingOverride ?? {}),
    ...(overridePatch ?? {}),
  };
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function applyReplyTurnInputMetadata(
  inputMessage: NonNullable<MiddlewareContextLike['options']>['inputMessage'] | undefined,
  turnInput: Pick<TurnInput, 'hasImageInput' | 'imageCount' | 'displayName' | 'userId' | 'isDirect'>,
): void {
  if (!inputMessage) return;

  const existingSpeakerFormat =
    (inputMessage.additional_kwargs?.qqbot_speaker_format as ReplySpeakerFormatMeta | undefined) ?? undefined;

  inputMessage.additional_kwargs = {
    ...(inputMessage.additional_kwargs ?? {}),
    qqbot_input_content_meta: {
      hasImageInput: turnInput.hasImageInput,
      imageCount: turnInput.imageCount,
    } satisfies ReplyInputContentMeta,
    qqbot_speaker_format: {
      version: 'speaker_id_v1',
      speakerId: turnInput.userId,
      speakerName: turnInput.displayName,
      isDirect: turnInput.isDirect,
      ...(existingSpeakerFormat?.preformatted === true ? { preformatted: true } : {}),
    } satisfies ReplySpeakerFormatMeta,
  };
}

function applyPreparedInputText(
  session: SessionWithVoiceState,
  context: MiddlewareContextLike,
  inputText: string | undefined,
  inputTextSpeakerTagged?: boolean,
): void {
  const normalized = inputText?.trim();
  if (!normalized) return;

  session.content = normalized;
  const inputMessage = context.options?.inputMessage;
  if (inputMessage) {
    const currentContent = inputMessage.content;
    if (!Array.isArray(currentContent)) {
      inputMessage.content = normalized;
    } else {
      let textUpdated = false;
      inputMessage.content = currentContent.map((part) => {
        if (
          !textUpdated &&
          part &&
          typeof part === 'object' &&
          (part as InputMessageContentPart).type === 'text'
        ) {
          textUpdated = true;
          return {
            ...(part as Record<string, unknown>),
            text: normalized,
          };
        }
        return part;
      });

      if (!textUpdated) {
        inputMessage.content = [
          { type: 'text', text: normalized },
          ...currentContent,
        ];
      }
    }

    const speakerFormat = inputMessage.additional_kwargs?.qqbot_speaker_format as ReplySpeakerFormatMeta | undefined;
    if (speakerFormat?.version === 'speaker_id_v1') {
      inputMessage.additional_kwargs = {
        ...(inputMessage.additional_kwargs ?? {}),
        qqbot_speaker_format: {
          ...speakerFormat,
          ...(inputTextSpeakerTagged ? { preformatted: true } : {}),
        },
      };
      if (!inputTextSpeakerTagged) {
        delete (inputMessage.additional_kwargs.qqbot_speaker_format as ReplySpeakerFormatMeta).preformatted;
      }
    }
  }
}

function buildReplyTurnStateText(context: ReplyTurnContinuationContext): string {
  const lines = ['这是一次回复中断后的重生成。'];
  if (context.alreadySentText) {
    lines.push('以下内容已经发给用户，不要重复：');
    lines.push(context.alreadySentText);
  }
  if (context.pendingUnitTexts.length > 0) {
    lines.push('以下内容是上一轮尚未发出的剩余发送单元，仅供承接参考，不要机械复述：');
    lines.push(context.pendingUnitTexts.join('\n'));
  }
  if (context.supplementalMessages.length > 0) {
    lines.push('在当前主消息之前，还收到了这些补充消息：');
    lines.push(...context.supplementalMessages);
  }
  lines.push('请基于当前用户输入，自然决定现在应该怎么回复。');
  return lines.join('\n');
}

function registerReplyTurnStateFragment(
  conversationId: string,
  continuationContext: ReplyTurnContinuationContext | undefined,
): void {
  if (!continuationContext) return;
  registerPromptFragment(conversationId, {
    source: 'qqbot_reply_interrupt_state',
    title: 'Reply Interrupt State',
    authority: 'assistant_state',
    trust: 'trusted',
    ttl: 'turn',
    payload: {
      kind: 'text',
      value: buildReplyTurnStateText(continuationContext),
    },
  });
}

function injectReplyPromptEnvelope(args: {
  chatluna: ChatLunaLike;
  conversationId: string;
  turnContext: Pick<TurnContext, 'input' | 'policySnapshot' | 'capabilitySnapshot' | 'continuationContext'>;
}): PromptEnvelopeMessage[] {
  const contextManager = args.chatluna.contextManager;
  if (!contextManager) {
    throw new Error('reply prompt compiler requires chatluna.contextManager.');
  }

  const workingContext = peekPromptFragments(args.conversationId);
  const envelope = compileReplyPromptEnvelope(buildReplyPromptCompilerInput(args.turnContext, workingContext));
  clearPromptAssemblyTurn(args.conversationId);
  if (!envelope?.messages.length) return [];

  contextManager.inject({
    name: 'qqbot_reply_prompt_envelope',
    value: envelope.messages,
    once: true,
    conversationId: args.conversationId,
    stage: 'after_scratchpad',
  });

  return envelope.messages;
}

function rememberReplyCapabilitySnapshot(
  session: SessionWithVoiceState,
  snapshot: ReplyCapabilitySnapshot,
  replyCapabilitySnapshots: Map<string, ReplyCapabilitySnapshot>,
): void {
  setReplyCapabilitySnapshot(session, snapshot);
  const queueKey = resolveReplyQueueKey(session);
  if (queueKey) {
    replyCapabilitySnapshots.set(queueKey, snapshot);
  }
}

function getAuthorizedReplyCapabilitySnapshot(
  session: Session,
  replyCapabilitySnapshots: Map<string, ReplyCapabilitySnapshot>,
): ReplyCapabilitySnapshot | undefined {
  const sessionSnapshot = getReplyCapabilitySnapshot(session as SessionWithVoiceState);
  if (sessionSnapshot) return sessionSnapshot;

  const queueKey = resolveReplyQueueKey(session);
  if (!queueKey) return undefined;
  return replyCapabilitySnapshots.get(queueKey);
}

function getTtsCapabilityState(
  runtime: RuntimeConfig,
  ttsCapabilityStates: Map<string, TtsCapabilityState>,
): TtsCapabilityState {
  const cacheKey = runtime.ttsBaseUrl || 'disabled';
  const existing = ttsCapabilityStates.get(cacheKey);
  if (existing) return existing;

  const created: TtsCapabilityState = {
    lastKnownHealthy: null,
    lastProbeAt: 0,
    lastProbeTurn: 0,
    turnCounter: 0,
    pendingProbe: null,
    failureBackoffUntil: 0,
  };
  ttsCapabilityStates.set(cacheKey, created);
  return created;
}

function updateTtsCapabilityObservation(state: TtsCapabilityState, healthy: boolean): void {
  const now = Date.now();
  state.lastKnownHealthy = healthy;
  state.lastProbeAt = now;
  state.lastProbeTurn = state.turnCounter;
  state.failureBackoffUntil = healthy ? 0 : now + TTS_PROBE_FAILURE_BACKOFF_MS;
}

function isTtsProbeDue(state: TtsCapabilityState, now = Date.now()): boolean {
  if (!state.lastProbeAt) return true;
  if (state.turnCounter - state.lastProbeTurn >= TTS_PROBE_TURN_INTERVAL) return true;
  return now - state.lastProbeAt >= TTS_PROBE_TIME_INTERVAL_MS;
}

async function runTtsHealthProbe(
  runtime: RuntimeConfig,
  state: TtsCapabilityState,
  force = false,
): Promise<boolean> {
  if (!runtime.ttsBaseUrl) return false;
  if (!force && state.pendingProbe) return state.pendingProbe;
  if (!force && state.failureBackoffUntil > Date.now()) {
    return state.lastKnownHealthy === true;
  }

  const task = (async () => {
    let healthy = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(runtime.synthTimeoutMs, TTS_PROBE_TIMEOUT_MS));

    try {
      const response = await fetch(`${runtime.ttsBaseUrl}/healthz`, {
        method: 'GET',
        headers: createAuthHeaders(runtime.ttsApiKey),
        signal: controller.signal,
      });
      healthy = response.ok;
    } catch (error) {
      logger.warn('tts health probe failed: %s', (error as Error).message);
      healthy = false;
    } finally {
      clearTimeout(timer);
    }

    updateTtsCapabilityObservation(state, healthy);
    return healthy;
  })().finally(() => {
    if (state.pendingProbe === task) {
      state.pendingProbe = null;
    }
  });

  state.pendingProbe = task;
  return task;
}

export async function resolveReplyCapabilitySnapshot(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  canSendRecordCache?: Map<string, boolean>;
  ttsCapabilityStates?: Map<string, TtsCapabilityState>;
  voiceOutputEnabled?: boolean;
  waitForProbe?: boolean;
}): Promise<ReplyCapabilitySnapshot> {
  const {
    runtime,
    session,
    canSendRecordCache = sharedReplyTransportCanSendRecordCache,
    ttsCapabilityStates = sharedReplyTransportTtsCapabilityStates,
    voiceOutputEnabled = false,
    waitForProbe = false,
  } = args;
  const snapshot: ReplyCapabilitySnapshot = {
    canMultiline: true,
    canVoice: false,
    source: 'cached',
    refreshedAt: Date.now(),
  };

  if (!voiceOutputEnabled || !isVoiceOutputConfigured(runtime)) {
    return snapshot;
  }

  const bot = session.bot as OneBotBotLike;
  if (!(await ensureCanSendRecord(bot, canSendRecordCache))) {
    return snapshot;
  }

  const ttsState = getTtsCapabilityState(runtime, ttsCapabilityStates);
  ttsState.turnCounter += 1;
  const due = isTtsProbeDue(ttsState, snapshot.refreshedAt);

  if (waitForProbe && ttsState.lastKnownHealthy == null) {
    try {
      await runTtsHealthProbe(runtime, ttsState, true);
    } catch (error) {
      logger.warn('blocking tts probe failed: %s', (error as Error).message);
    }
  }

  if (due && snapshot.refreshedAt >= ttsState.failureBackoffUntil && !ttsState.pendingProbe) {
    void runTtsHealthProbe(runtime, ttsState).catch((error) => {
      logger.warn('background tts probe failed: %s', (error as Error).message);
    });
  }

  snapshot.canVoice = ttsState.lastKnownHealthy === true;
  return snapshot;
}

function hasVoiceSegments(plan: OutboundMessagePlan): boolean {
  return plan.segments.some((segment) => segment.kind === 'voice-block');
}

function hasStickerSegments(plan: OutboundMessagePlan): boolean {
  return plan.segments.some((segment) => segment.kind === 'sticker-block');
}

async function prepareVoiceDeliveries(args: {
  runtime: RuntimeConfig;
  plan: ReplyTransportPlan;
  bot: OneBotBotLike;
  canSendRecordCache: Map<string, boolean>;
  ttsCapabilityStates: Map<string, TtsCapabilityState>;
}): Promise<{ preparedByRaw: Map<string, PreparedVoiceDelivery>; effectivePlan: ReplyTransportPlan }> {
  const { runtime, plan, bot, canSendRecordCache, ttsCapabilityStates } = args;
  const outboundPlan = buildOutboundMessagePlanFromReplyPlan(plan);
  if (!hasVoiceSegments(outboundPlan)) {
    return { preparedByRaw: new Map(), effectivePlan: plan };
  }
  if (!isVoiceOutputConfigured(runtime)) {
    return { preparedByRaw: new Map(), effectivePlan: downgradeVoiceSegmentsToText(plan) };
  }
  if (!(await ensureCanSendRecord(bot, canSendRecordCache))) {
    return { preparedByRaw: new Map(), effectivePlan: downgradeVoiceSegmentsToText(plan) };
  }

  const voiceSegments = outboundPlan.segments.filter(
    (segment): segment is OutboundMessageSegment & { kind: 'voice-block' } => segment.kind === 'voice-block',
  );
  const ttsState = getTtsCapabilityState(runtime, ttsCapabilityStates);
  const preparedByRaw = new Map<string, PreparedVoiceDelivery>();

  try {
    const preparedEntries = await Promise.all(
      voiceSegments.map(async (segment) => {
        const text = normalizeVoiceSynthesisText(segment.content);
        if (!text) {
          throw new Error('empty_voice_segment');
        }
        const wordCount = countVoiceWords(text);
        if (wordCount > runtime.outputMaxWords) {
          throw new Error(`voice_segment_too_many_words:${runtime.outputMaxWords}`);
        }

        const style = pickVoiceStyle(text);
        const wav = await synthesizeVoice(runtime, text, style);
        const durationMs = estimateWavDurationMs(wav);
        if (durationMs && durationMs > runtime.outputMaxSeconds * 1000) {
          throw new Error(`voice_segment_too_long_duration:${runtime.outputMaxSeconds}`);
        }
        return [segment.raw, { segment, text, style, wav }] as const;
      }),
    );

    for (const [raw, prepared] of preparedEntries) {
      preparedByRaw.set(raw, prepared);
    }

    updateTtsCapabilityObservation(ttsState, true);
    return { preparedByRaw, effectivePlan: plan };
  } catch (error) {
    updateTtsCapabilityObservation(ttsState, false);
    const reason = (error as Error).message;
    if (
      reason.startsWith('voice_segment_too_many_words:') ||
      reason.startsWith('voice_segment_too_long_duration:') ||
      reason === 'empty_voice_segment'
    ) {
      return { preparedByRaw: new Map(), effectivePlan: downgradeVoiceSegmentsToText(plan) };
    }
    logger.warn('voice preflight failed: %s', reason);
    return { preparedByRaw: new Map(), effectivePlan: downgradeVoiceSegmentsToText(plan) };
  }
}

async function prepareStickerDeliveries(args: {
  session: SessionWithVoiceState;
  plan: ReplyTransportPlan;
}): Promise<{ preparedByRaw: Map<string, PreparedStickerDelivery>; effectivePlan: ReplyTransportPlan }> {
  const { session, plan } = args;
  const outboundPlan = buildOutboundMessagePlanFromReplyPlan(plan);
  if (!hasStickerSegments(outboundPlan)) {
    return { preparedByRaw: new Map(), effectivePlan: plan };
  }

  const stickerState = session.state?.qqSticker;
  if (!stickerState?.catalog) {
    return { preparedByRaw: new Map(), effectivePlan: removeStickerSegments(plan) };
  }

  const stickerSegments = outboundPlan.segments.filter(
    (segment): segment is OutboundMessageSegment & { kind: 'sticker-block' } => segment.kind === 'sticker-block',
  );
  const preparedByRaw = new Map<string, PreparedStickerDelivery>();
  const effectiveSegments: ReplyTransportPlan['segments'] = [];
  const usedStickerIds = new Set<string>();
  let stickerIndex = 0;

  for (const segment of plan.segments) {
    if (segment.kind !== 'sticker') {
      effectiveSegments.push(segment);
      continue;
    }

    const outboundSticker = stickerSegments[stickerIndex];
    stickerIndex += 1;
    if (!outboundSticker) continue;

    const selected = resolveStickerSelection(stickerState.catalog, segment.content, stickerState.preset, {
      usedIds: usedStickerIds,
      sequenceIndex: preparedByRaw.size,
    });
    if (!selected) continue;

    preparedByRaw.set(outboundSticker.raw, {
      segment: outboundSticker,
      historyLine: createStickerHistoryLine(selected),
      buffer: selected.buffer,
      mime: selected.mime,
    });
    usedStickerIds.add(selected.id.trim().toLowerCase());
    effectiveSegments.push(segment);
  }

  return { preparedByRaw, effectivePlan: { segments: effectiveSegments } };
}

async function deliverReplyPlanCore(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  plan: ReplyTransportPlan;
  sendStrand?: ReturnType<typeof createKeyedStrandRunner>;
  canSendRecordCache?: Map<string, boolean>;
  ttsCapabilityStates?: Map<string, TtsCapabilityState>;
  queueKey?: string | null;
  beginSend?: () => AbortSignal | null;
  wasInterrupted?: () => boolean;
  resolveQuoteTargetMessageId?: (supports: boolean) => string | null;
  onPlannedUnitHistoryLines?: (historyLines: string[]) => void;
  onCommittedUnit?: (historyLine: string) => void;
  onDeliveryReceipt?: (receipt: unknown) => void;
}): Promise<ReplyPlanDeliveryResult> {
  const {
    runtime,
    session,
    plan,
    sendStrand = sharedReplyTransportSendStrand,
    canSendRecordCache = sharedReplyTransportCanSendRecordCache,
    ttsCapabilityStates = sharedReplyTransportTtsCapabilityStates,
    queueKey,
    beginSend,
    wasInterrupted,
    resolveQuoteTargetMessageId,
    onPlannedUnitHistoryLines,
    onCommittedUnit,
    onDeliveryReceipt,
  } = args;
  const historyText = renderDeliveredReplyPlanHistoryText(plan);
  const fallbackText = renderReplyPlanFallbackText(plan);
  if (session.platform !== 'onebot' || !session.channelId) {
    return { status: 'failed_before_send', fallbackText, historyText };
  }

  const preparedVoice = await prepareVoiceDeliveries({
    runtime,
    plan,
    bot: session.bot as OneBotBotLike,
    canSendRecordCache,
    ttsCapabilityStates,
  });
  const preparedSticker = await prepareStickerDeliveries({
    session,
    plan: preparedVoice.effectivePlan,
  });
  const effectivePlan = preparedSticker.effectivePlan;
  const outboundPlan = buildOutboundMessagePlanFromReplyPlan(effectivePlan);
  if (!outboundPlan.segments.length) {
    return { status: 'failed_before_send', fallbackText, historyText };
  }

  const bot = session.bot as OneBotBotLike;
  const effectiveHistoryText = renderDeliveredReplyPlanHistoryText(effectivePlan, preparedSticker.preparedByRaw) || historyText;
  const effectiveFallbackText = renderReplyPlanFallbackText(effectivePlan) || fallbackText;
  const plannedUnitHistoryLines = buildPlannedUnitHistoryLines({
    outboundPlan,
    preparedVoiceByRaw: preparedVoice.preparedByRaw,
    preparedStickerByRaw: preparedSticker.preparedByRaw,
  });
  onPlannedUnitHistoryLines?.(plannedUnitHistoryLines);
  let beganSending = false;
  let sendAbortSignal: AbortSignal | null = null;
  const committedHistoryLines: string[] = [];
  const wasSendAborted = () => (sendAbortSignal as AbortSignal | null)?.aborted === true;
  const sendTask = async () => {
    sendAbortSignal = beginSend?.() ?? null;
    if (beginSend && !sendAbortSignal) {
      return;
    }

    const { sendWhole, sendLine } = createBotMessageDispatchers(bot, session.channelId!, session);
    await dispatchOutboundMessagePlan(outboundPlan, async (segment) => {
      const historyLine = plannedUnitHistoryLines[outboundPlan.segments.indexOf(segment)] ?? '';
      const quoteTargetMessageId = resolveQuoteTargetMessageId?.(segment.kind !== 'voice-block') ?? null;
      if (segment.kind === 'multiline-block') {
        beganSending = true;
        const receipt = await sendWhole(createQuotedMessageContent(segment.content, quoteTargetMessageId));
        onDeliveryReceipt?.(receipt);
        if (historyLine) {
          committedHistoryLines.push(historyLine);
          onCommittedUnit?.(historyLine);
        }
        return;
      }

      if (segment.kind === 'text-line') {
        beganSending = true;
        const receipt = await sendLine(createQuotedMessageContent(segment.content, quoteTargetMessageId));
        onDeliveryReceipt?.(receipt);
        if (historyLine) {
          committedHistoryLines.push(historyLine);
          onCommittedUnit?.(historyLine);
        }
        return;
      }

      if (segment.kind === 'rich-text-block') {
        beganSending = true;
        const receipt = await sendWhole(createQuotedMessageContent(renderRichTextSegmentsMessageContent(segment.segments), quoteTargetMessageId));
        onDeliveryReceipt?.(receipt);
        if (historyLine) {
          committedHistoryLines.push(historyLine);
          onCommittedUnit?.(historyLine);
        }
        return;
      }

      if (segment.kind === 'sticker-block') {
        const prepared = preparedSticker.preparedByRaw.get(segment.raw);
        if (!prepared) {
          throw new Error('missing_prepared_sticker');
        }

        beganSending = true;
        const receipt = await sendWhole(createQuotedMessageContent(h.image(prepared.buffer, prepared.mime), quoteTargetMessageId));
        onDeliveryReceipt?.(receipt);
        if (historyLine) {
          committedHistoryLines.push(historyLine);
          onCommittedUnit?.(historyLine);
        }
        return;
      }

      if (segment.kind === 'image-block') {
        beganSending = true;
        const receipt = await sendWhole(createQuotedMessageContent(h.image(segment.assetRef), quoteTargetMessageId));
        onDeliveryReceipt?.(receipt);
        if (historyLine) {
          committedHistoryLines.push(historyLine);
          onCommittedUnit?.(historyLine);
        }
        return;
      }

      const prepared = preparedVoice.preparedByRaw.get(segment.raw);
      if (!prepared) {
        throw new Error('missing_prepared_voice');
      }

      beganSending = true;
      const receipt = await sendWhole(h.audio(createAudioDataUri(prepared.wav)));
      onDeliveryReceipt?.(receipt);
      if (historyLine) {
        committedHistoryLines.push(historyLine);
        onCommittedUnit?.(historyLine);
      }
    }, {
      abortSignal: sendAbortSignal ?? undefined,
    });
  };

  try {
    if (queueKey) {
      await sendStrand.run(queueKey, sendTask);
    } else {
      await sendTask();
    }
  } catch (error) {
    logger.warn('reply plan delivery failed: %s', (error as Error).message);
    const committedHistoryText = committedHistoryLines.join('\n').trim();
    if (wasSendAborted() || wasInterrupted?.()) {
      return { status: 'interrupted', historyText: committedHistoryText };
    }
    if (beganSending) {
      return { status: 'failed_after_partial_send', historyText: committedHistoryText };
    }
    return { status: 'failed_before_send', fallbackText: effectiveFallbackText, historyText: effectiveFallbackText };
  }

  if ((beginSend && !sendAbortSignal) || wasSendAborted() || wasInterrupted?.()) {
    return { status: 'interrupted', historyText: committedHistoryLines.join('\n').trim() };
  }

  return { status: 'delivered', historyText: effectiveHistoryText };
}

async function deliverReplyPlan(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  plan: ReplyTransportPlan;
  replyRuntime: ReplyRuntime;
  runId: string;
}): Promise<ReplyPlanDeliveryResult> {
  const { runtime, session, plan, replyRuntime, runId } = args;
  return deliverReplyPlanCore({
    runtime,
    session,
    plan,
    queueKey: resolveReplyQueueKey(session),
    beginSend: () => {
      const signal = replyRuntime.beginSending(runId);
      if (!signal || !replyRuntime.isCurrentRun(runId)) {
        return null;
      }
      return signal;
    },
    wasInterrupted: () => replyRuntime.wasInterrupted(runId),
    resolveQuoteTargetMessageId: (supports) => replyRuntime.consumeFirstReplyQuote(runId, supports),
    onPlannedUnitHistoryLines: (historyLines) => replyRuntime.setPlannedUnitHistory(runId, historyLines),
    onCommittedUnit: (historyLine) => replyRuntime.recordCommittedUnit(runId, historyLine),
  });
}

export async function deliverStandaloneReplyPlan(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  plan: ReplyTransportPlan;
}): Promise<ReplyPlanDeliveryResult & { receipts: unknown[] }> {
  const receipts: unknown[] = [];
  const result = await deliverReplyPlanCore({
    runtime: args.runtime,
    session: args.session,
    plan: args.plan,
    queueKey: resolveReplyQueueKey(args.session),
    onDeliveryReceipt: (receipt) => {
      receipts.push(receipt);
    },
  });
  return {
    ...result,
    receipts,
  };
}

function isReplyPlanSessionAvailable(session: Session): boolean {
  return session.platform === 'onebot' && Boolean(session.channelId);
}

export function apply(ctx: Context, config: Config = {}): void {
  const runtime = toRuntimeConfig(config);
  assertVoiceRuntimeConfig(runtime);
  const featurePolicy = (ctx as ContextWithChatLuna).featurePolicy;
  const replyOrchestrator = new ReplyOrchestratorService();
  const replyCapabilitySnapshots = new Map<string, ReplyCapabilitySnapshot>();

  const resolveChatLunaService = (): ChatLunaLike | undefined => {
    const byGetter = typeof (ctx as { get?: (name: string) => unknown }).get === 'function'
      ? ((ctx as { get: (name: string) => unknown }).get('chatluna') as ChatLunaLike | undefined)
      : undefined;
    return byGetter ?? (ctx as ContextWithChatLuna).chatluna;
  };

  const resolveVoiceFeatureState = async (session: SessionWithVoiceState): Promise<{
    inputEnabled: boolean;
    outputEnabled: boolean;
  }> => {
    if (!featurePolicy) {
      return {
        inputEnabled: runtime.inputEnabled,
        outputEnabled: runtime.outputEnabled,
      };
    }

    const [inputEnabled, outputEnabled] = await Promise.all([
      featurePolicy.resolveFeatureEnabled(session, 'QQ_VOICE_INPUT_ENABLED'),
      featurePolicy.resolveFeatureEnabled(session, 'QQ_VOICE_OUTPUT_ENABLED'),
    ]);

    return {
      inputEnabled,
      outputEnabled,
    };
  };

  const resolveReplyRunMode = async (session: SessionWithVoiceState): Promise<ReplyRunMode> => {
    const replyInterruptFeatureKey = 'QQBOT_REPLY_INTERRUPT_ENABLED' as ScopedFeatureKey;
    const replyInterruptEnabled = featurePolicy
      ? await featurePolicy.resolveFeatureEnabled(session, replyInterruptFeatureKey)
      : resolveBooleanEnv(process.env.QQBOT_REPLY_INTERRUPT_ENABLED, false);
    return replyInterruptEnabled ? 'interrupt' : 'queue';
  };

  const replyRuntime = new ReplyRuntime({
    stopChat: async (room, requestId) => {
      const chatluna = resolveChatLunaService();
      if (typeof chatluna?.stopChat !== 'function') return;
      await chatluna.stopChat(room as never, requestId);
    },
    collectWindowMs: runtime.replyInterruptCollectWindowMs,
    maxPendingInputs: runtime.replyInterruptMaxPendingInputs,
  });

  ctx.middleware(
    async (rawSession, next) => {
      const session = rawSession as SessionWithVoiceState;
      const voiceFeatureState = await resolveVoiceFeatureState(session);
      if (!voiceFeatureState.inputEnabled) {
        return next();
      }
      if (session.platform !== 'onebot') return next();
      if (!session.userId || session.userId === session.bot?.selfId) return next();
      if (!session.content || !extractFirstIncomingVoice(session.content)) return next();

      const bot = session.bot as OneBotBotLike;
      try {
        const downloaded = await downloadIncomingAudio(session, runtime, bot);
        const transcript = await transcribeAudio(runtime, downloaded);

        if (!transcript.text) {
          await sendFailureReply(session, buildVoiceFailureReply('empty', runtime.inputMaxSeconds));
          return;
        }

        if (transcript.durationMs > runtime.inputMaxSeconds * 1000) {
          await sendFailureReply(session, buildVoiceFailureReply('too-long', runtime.inputMaxSeconds));
          return;
        }

        const originalText = getTextInputContent(session);
        const merged = mergeVoiceInputText(originalText, transcript.text);
        updateVoiceState(session, {
          transcript: transcript.text,
          durationMs: transcript.durationMs,
          source: downloaded.source,
        });

        session.content = merged;
        return next();
      } catch (error) {
        logger.warn('voice input handling failed: %s', (error as Error).message);
        await sendFailureReply(session, buildVoiceFailureReply('broken', runtime.inputMaxSeconds));
        return;
      }
    },
    true,
  );

  ctx.middleware(
    async (rawSession, next) => {
      const session = rawSession as SessionWithVoiceState;
      if (!isReplyPlanSessionAvailable(session)) return next();
      if (!session.userId || session.userId === session.bot?.selfId) return next();
      const voiceFeatureState = await resolveVoiceFeatureState(session);

      const snapshot = await resolveReplyCapabilitySnapshot({
        runtime,
        session,
        voiceOutputEnabled: voiceFeatureState.outputEnabled,
      });
      rememberReplyCapabilitySnapshot(session, snapshot, replyCapabilitySnapshots);
      return next();
    },
    true,
  );

  ctx.on('ready', async () => {
    await Promise.all(
      ctx.bots
        .filter((bot) => bot.platform === 'onebot')
        .map(async (bot) => ensureCanSendRecord(bot as unknown as OneBotBotLike, sharedReplyTransportCanSendRecordCache, true)),
    );
    if (isVoiceOutputConfigured(runtime)) {
      const ttsState = getTtsCapabilityState(runtime, sharedReplyTransportTtsCapabilityStates);
      void runTtsHealthProbe(runtime, ttsState, true).catch((error) => {
        logger.warn('initial tts health probe failed: %s', (error as Error).message);
      });
    }

    const chatluna = resolveChatLunaService();
    const chain = chatluna?.chatChain as ChatLunaChainLike | undefined;
    if (!chain?.middleware) {
      logger.warn('chatluna service is not available, skip reply transport policy middleware.');
      return;
    }

    const prepareBuilder = chain.middleware('qqbot_reply_runtime_prepare', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const room = context.options?.room as ReplyRuntimeRoomLike | undefined;
        const conversationId = room?.conversationId?.trim();
        const queueKey = resolveReplyQueueKey(session);
        const actorKey = resolveReplyActorKey(session);
        if (!room || !conversationId || !queueKey || !actorKey) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        ensureReplyPluginRoom(room);
        ensureStructuredReplyJsonSchemaModel(room);
        const turnInput = buildReplyTurnInput(session, room, context.options?.inputMessage);
        applyReplyTurnInputMetadata(context.options?.inputMessage, turnInput);
        const routeHint = normalizeReplyRouteHint(normalizeReplyChatMode((room as { chatMode?: unknown }).chatMode));
        const orchestration = await replyOrchestrator.handle(turnInput, session, {
          routeHint,
        });
        setReplyRouteState(session, orchestration.route);
        if (orchestration.status === 'no_reply') {
          return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
        }

        const runMode = await resolveReplyRunMode(session);
        const runId = `qqreply:${randomUUID()}`;
        const prepared = await replyRuntime.prepareRun({
          runId,
          queueKey,
          actorKey,
          conversationId,
          room,
          mode: runMode,
          input: turnInput,
        });
        if (prepared.action === 'stop') {
          return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
        }
        applyPreparedInputText(session, context, prepared.inputText, prepared.inputTextSpeakerTagged);
        registerReplyTurnStateFragment(conversationId, prepared.continuationContext);
        setReplyRunId(session, runId);
        if (context.options) {
          context.options.messageId = runId;
        }
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      }) as ChatLunaChainBuilderLike;
    prepareBuilder.after('read_chat_message');
    prepareBuilder.before('message_delay');
    prepareBuilder.before('chatluna_time_context');
    prepareBuilder.before('qqbot_memory_v2');
    prepareBuilder.before('qqbot_reply_transport_policy');

    const toolMemoryBuilder = chain.middleware('qqbot_reply_tool_memory_state', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const conversationId = context.options?.room?.conversationId?.trim();
        if (!conversationId) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;

        await registerReplyToolMemoryFragment(ctx, conversationId, logger);
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      }) as ChatLunaChainBuilderLike;
    toolMemoryBuilder.after('qqbot_reply_runtime_prepare');
    toolMemoryBuilder.before('qqbot_reply_transport_policy');

    const policyBuilder = chain.middleware('qqbot_reply_transport_policy', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const room = context.options?.room;
        const conversationId = room?.conversationId;
        if (!conversationId || !room) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (getReplyRouteState(session) !== 'agent') {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        getReplyTransportState(session).suppressErrorNotice = true;
        const voiceFeatureState = await resolveVoiceFeatureState(session);

        const snapshot =
          getAuthorizedReplyCapabilitySnapshot(session, replyCapabilitySnapshots) ??
          (await resolveReplyCapabilitySnapshot({
            runtime,
            session,
            voiceOutputEnabled: voiceFeatureState.outputEnabled,
          }));
        rememberReplyCapabilitySnapshot(session, snapshot, replyCapabilitySnapshots);
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      }) as ChatLunaChainBuilderLike;
    policyBuilder.after('qqbot_reply_tool_memory_state');
    policyBuilder.after('chatluna_time_context');
    policyBuilder.after('qqbot_memory_v2');
    policyBuilder.after('qqbot_sticker_policy');
    policyBuilder.before('lifecycle-handle_command');

    const promptCompilerBuilder = chain.middleware('qqbot_reply_prompt_compiler', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const route = getReplyRouteState(session);
        if (route !== 'agent') {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const room = context.options?.room as ReplyRuntimeRoomLike | undefined;
        const conversationId = room?.conversationId?.trim();
        const chatlunaService = resolveChatLunaService();
        if (!room || !conversationId || !chatlunaService) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        ensureReplyPluginRoom(room);
        ensureStructuredReplyJsonSchemaModel(room);

        const capability = getAuthorizedReplyCapabilitySnapshot(session, replyCapabilitySnapshots);
        const turnInput = buildReplyTurnInput(session, room, context.options?.inputMessage);
        applyReplyTurnInputMetadata(context.options?.inputMessage, turnInput);
        injectReplyPromptEnvelope({
          chatluna: chatlunaService,
          conversationId,
          turnContext: {
            input: turnInput,
            policySnapshot: {
              route,
              toolRouteProfile: route,
            },
            capabilitySnapshot: capability ? buildTurnCapabilitySnapshot(session, capability) : null,
            continuationContext: null,
          },
        });
        applyReplyStructuredOutputRequest(room, context.options?.inputMessage);
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      }) as ChatLunaChainBuilderLike;
    promptCompilerBuilder.after('qqbot_reply_transport_policy');
    promptCompilerBuilder.after('qqbot_reply_tool_memory_state');
    promptCompilerBuilder.after('chatluna_time_context');
    promptCompilerBuilder.after('qqbot_memory_v2');
    promptCompilerBuilder.after('qqbot_sticker_policy');
    promptCompilerBuilder.before('qqbot_prompt_envelope');
    promptCompilerBuilder.before('lifecycle-handle_command');

    const executorBuilder = chain.middleware('qqbot_reply_plan_executor', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const responseMessage = context.options?.responseMessage;
        if (!responseMessage) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        const room = context.options?.room as ReplyRuntimeRoomLike | undefined;
        const conversationId = room?.conversationId?.trim();
        ensureReplyPluginRoom(room);
        ensureStructuredReplyJsonSchemaModel(room);
        const runMode = await resolveReplyRunMode(session);
        let runId = getReplyRunId(session);
        if (!runId) {
          const queueKey = resolveReplyQueueKey(session);
          const actorKey = resolveReplyActorKey(session);
          if (!room || !conversationId || !queueKey || !actorKey) {
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }
          runId = `qqreply:${randomUUID()}`;
          const prepared = await replyRuntime.prepareRun({
            runId,
            queueKey,
            actorKey,
            conversationId,
            room,
            mode: runMode,
            input: buildReplyTurnInput(session, room, context.options?.inputMessage),
          });
          if (prepared.action === 'stop') {
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }
          applyPreparedInputText(session, context, prepared.inputText, prepared.inputTextSpeakerTagged);
          registerReplyTurnStateFragment(conversationId, prepared.continuationContext);
          setReplyRunId(session, runId);
        }
        if (!replyRuntime.isCurrentRun(runId)) {
          if (context.options) {
            context.options.responseMessage = null;
          }
          replyRuntime.finishRun(runId);
          return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
        }

        try {
          const turnInput = buildReplyTurnInput(session, room, context.options?.inputMessage);
          applyReplyTurnInputMetadata(context.options?.inputMessage, turnInput);
          const routeHint = normalizeReplyRouteHint(normalizeReplyChatMode((room as { chatMode?: unknown }).chatMode));
          const voiceFeatureState = await resolveVoiceFeatureState(session);

          const snapshot =
            getAuthorizedReplyCapabilitySnapshot(session, replyCapabilitySnapshots) ??
            (await resolveReplyCapabilitySnapshot({
              runtime,
              session,
              voiceOutputEnabled: voiceFeatureState.outputEnabled,
            }));
          rememberReplyCapabilitySnapshot(session, snapshot, replyCapabilitySnapshots);
          const turnCapabilitySnapshot = buildTurnCapabilitySnapshot(session, snapshot);
          const orchestration = await replyOrchestrator.handle(turnInput, session, {
            responseMessage,
            promptFragments: [],
            capabilitySnapshot: turnCapabilitySnapshot,
            continuationContext: null,
            routeHint,
          });

          if (orchestration.status === 'no_reply') {
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }
          if (orchestration.status !== 'ready') {
            throw new Error(`reply v2 orchestrator expected ready status, got ${orchestration.status}.`);
          }
          if (orchestration.actions.length === 1 && orchestration.actions[0]?.kind === 'no_reply') {
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }

          const executablePlan = buildReplyTransportPlanFromResolvedActions(orchestration.actions);
          replyRuntime.setPlannedUnitHistory(runId, buildOptimisticPlannedUnitHistoryLines(executablePlan));
          if (!replyRuntime.completeCompute(runId)) {
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }

          const result = await deliverReplyPlan({
            runtime,
            session,
            plan: executablePlan,
            replyRuntime,
            runId,
          });

          if (result.status === 'failed_before_send') {
            if (responseMessage) {
              responseMessage.content = result.fallbackText;
            }
          } else if (context.options) {
            context.options.responseMessage = null;
          }

          try {
            await normalizeResearchReplyHistory(ctx, room, result.historyText);
          } catch (error) {
            logger.warn('research reply history normalization failed: %s', (error as Error).message);
          }

          if (result.status === 'failed_before_send') {
            return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
          }

          return result.status === 'failed_after_partial_send'
            ? ChatLunaChains.ChainMiddlewareRunStatus.STOP
            : ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        } finally {
          replyRuntime.finishRun(runId);
        }
      }) as ChatLunaChainBuilderLike;
    executorBuilder.after('request_model');
    executorBuilder.before('censor');
  });
}
