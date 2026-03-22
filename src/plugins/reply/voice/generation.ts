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
  createBypassLineSplitOptions,
  createBotMessageDispatchers,
  createKeyedStrandRunner,
  dispatchOutboundMessagePlan,
  resolveSessionStrandKey,
  sanitizeStructuredReplySegmentContent,
  sendBotMessageByNormalizedContent,
  type OutboundMessagePlan,
  type OutboundMessageSegment,
  type ReplyTransportPlan,
} from '../../shared/outbound/index.js';
import { registerPromptFragment } from '../../shared/prompt-context/index.js';
import { resolveSessionDisplayName } from '../../shared/session/index.js';
import {
  parseReplyPlanFromToolResultDetailed,
} from '../plan/parser.js';
import {
  ReplyRuntime,
  type ReplyTurnContinuationContext,
  type ReplyTurnInput,
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

export interface Config {
  enabled?: boolean;
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
  enabled: Schema.boolean().default(true).description('是否启用 QQ 语音能力。'),
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

interface RuntimeConfig {
  enabled: boolean;
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

interface ReplyCapabilitySnapshot {
  canMultiline: true;
  canVoice: boolean;
  source: ReplyCapabilitySource;
  refreshedAt: number;
}

interface ReplyTransportState {
  capabilitySnapshot?: ReplyCapabilitySnapshot;
  runId?: string;
}

type SessionWithVoiceState = Session & {
  stripped?: { content?: string };
  state?: Record<string, unknown> & {
    qqVoice?: QqVoiceState;
    qqReplyTransport?: ReplyTransportState;
    qqSticker?: StickerCapabilityState;
  };
};

type OneBotInternalLike = {
  _request?: (action: string, params?: Record<string, unknown>) => Promise<unknown>;
  canSendRecord?: () => Promise<boolean>;
  getRecord?: (file: string, format: 'wav', fullPath?: boolean) => Promise<{ file?: string }>;
  sendPrivateMsg?: (...args: unknown[]) => Promise<unknown>;
  sendGroupMsg?: (...args: unknown[]) => Promise<unknown>;
};

type OneBotBotLike = {
  selfId?: string;
  platform?: string;
  internal?: OneBotInternalLike;
  sendMessage: (
    channelId: string,
    content: string,
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

function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

function clampNatural(input: unknown, fallback: number): number {
  const value = Number(input);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  return {
    enabled: config.enabled ?? String(process.env.QQ_VOICE_ENABLED ?? 'true').toLowerCase() !== 'false',
    inputEnabled: config.inputEnabled ?? String(process.env.QQ_VOICE_INPUT_ENABLED ?? 'true').toLowerCase() !== 'false',
    outputEnabled:
      config.outputEnabled ?? String(process.env.QQ_VOICE_OUTPUT_ENABLED ?? 'true').toLowerCase() !== 'false',
    asrBaseUrl: normalizeBaseUrl(config.asrBaseUrl ?? process.env.QQ_VOICE_ASR_BASE_URL ?? 'http://127.0.0.1:8081'),
    asrApiKey: config.asrApiKey ?? process.env.QQ_VOICE_ASR_API_KEY ?? '',
    ttsBaseUrl: normalizeBaseUrl(config.ttsBaseUrl ?? process.env.QQ_VOICE_TTS_BASE_URL ?? 'http://127.0.0.1:8082'),
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

async function synthesizeVoice(
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

function createAudioDataUri(bytes: Uint8Array): string {
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
    await session.send(message);
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

function renderReplyPlanSegmentTextForFallback(segment: ReplyTransportPlan['segments'][number]): string {
  if (segment.kind === 'sticker') return '';
  if (segment.kind === 'image') {
    return sanitizeStructuredReplySegmentContent(segment.alt ?? '');
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
    if (segment.kind === 'image-block') {
      return segment.alt ? `（发送图片：${segment.alt}）` : '（发送图片）';
    }
    if (segment.kind === 'sticker-block') {
      return preparedStickerByRaw.get(segment.raw)?.historyLine ?? '（发送表情包）';
    }
    return `（发送语音：${preparedVoiceByRaw.get(segment.raw)?.text ?? segment.content}）`;
  });
}

async function normalizeReplyAgentHistory(
  ctx: Context,
  room: Record<string, unknown> | undefined,
  messageText: string,
): Promise<void> {
  const chatluna = (ctx.get?.('chatluna') ?? (ctx as { chatluna?: any }).chatluna) as
    | { normalizeReplyAgentHistory?: (room: Record<string, unknown>, finalVisibleText: string) => Promise<unknown> }
    | undefined;
  const conversationId = typeof room?.conversationId === 'string' ? room.conversationId.trim() : '';
  if (!chatluna?.normalizeReplyAgentHistory || !conversationId) return;
  await chatluna.normalizeReplyAgentHistory(room!, messageText.trim());
}

async function ensureCanSendRecord(
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

function isVoiceOutputConfigured(runtime: RuntimeConfig): boolean {
  return runtime.enabled && runtime.outputEnabled && Boolean(runtime.ttsBaseUrl);
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

function resolveBooleanEnv(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized !== 'false';
}

function createReplyTurnInput(session: SessionWithVoiceState): ReplyTurnInput {
  const text = getTextInputContent(session).trim() || String(session.content ?? '').trim();
  return {
    text,
    displayName: resolveSessionDisplayName(session),
    userId: session.userId?.trim() || '用户',
    isDirect: Boolean(session.isDirect),
  };
}

function applyPreparedInputText(
  session: SessionWithVoiceState,
  context: MiddlewareContextLike,
  inputText: string | undefined,
): void {
  const normalized = inputText?.trim();
  if (!normalized) return;

  session.content = normalized;
  if (context.options?.inputMessage) {
    context.options.inputMessage.content = normalized;
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

function serializeReplyPlanRawOutput(raw: unknown): string {
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

function trimOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function buildReplyPlanDebugPayload(
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

function logReplyPlanDebug(
  context: MiddlewareContextLike,
  stage: string,
  details: Record<string, unknown>,
): void {
  logger.warn('reply-plan-debug %s', JSON.stringify(buildReplyPlanDebugPayload(context, { stage, ...details })));
}

function rememberReplyCapabilitySnapshot(
  session: SessionWithVoiceState,
  snapshot: ReplyCapabilitySnapshot,
  replyCapabilitySnapshots: Map<string, ReplyCapabilitySnapshot>,
): void {
  setReplyCapabilitySnapshot(session, snapshot);
  const strandKey = resolveSessionStrandKey(session);
  if (strandKey) {
    replyCapabilitySnapshots.set(strandKey, snapshot);
  }
}

function getAuthorizedReplyCapabilitySnapshot(
  session: Session,
  replyCapabilitySnapshots: Map<string, ReplyCapabilitySnapshot>,
): ReplyCapabilitySnapshot | undefined {
  const sessionSnapshot = getReplyCapabilitySnapshot(session as SessionWithVoiceState);
  if (sessionSnapshot) return sessionSnapshot;

  const strandKey = resolveSessionStrandKey(session);
  if (!strandKey) return undefined;
  return replyCapabilitySnapshots.get(strandKey);
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

async function resolveReplyCapabilitySnapshot(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  canSendRecordCache: Map<string, boolean>;
  ttsCapabilityStates: Map<string, TtsCapabilityState>;
  voiceOutputEnabled?: boolean;
}): Promise<ReplyCapabilitySnapshot> {
  const { runtime, session, canSendRecordCache, ttsCapabilityStates, voiceOutputEnabled = false } = args;
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

  if (due && snapshot.refreshedAt >= ttsState.failureBackoffUntil && !ttsState.pendingProbe) {
    void runTtsHealthProbe(runtime, ttsState).catch((error) => {
      logger.warn('background tts probe failed: %s', (error as Error).message);
    });
  }

  snapshot.canVoice = ttsState.lastKnownHealthy === true;
  return snapshot;
}

export function buildReplyTransportCapabilityState(
  snapshot: ReplyCapabilitySnapshot,
  outputMaxWords: number,
  outputMaxSeconds: number,
): Record<string, unknown> {
  return {
    reply_plan: {
      enabled: true,
      multiline_available: true,
      schema: {
        segments: [
          {
            kind: 'text|multiline|voice|sticker|image',
            content: 'string (text|multiline|voice|sticker only)',
            asset_ref: 'string (image only)',
            alt: 'string? (image only)',
          },
        ],
      },
      terminal_tool: 'submit_reply_plan',
    },
    voice: {
      enabled: snapshot.canVoice,
      source: snapshot.source,
      max_words: outputMaxWords,
      max_seconds: outputMaxSeconds,
      sequence_mode: 'ordered_segments',
    },
  };
}

export function buildReplyTransportExecutionRules(
  snapshot: ReplyCapabilitySnapshot,
  outputMaxWords: number,
  outputMaxSeconds: number,
): string {
  const lines = [
    '最终只能调用 submit_reply_plan，不要输出普通文本或裸 JSON。',
    'submit_reply_plan 参数格式：{"segments":[...]}。',
    'text / multiline / voice / sticker 段必须提供 content。',
    'image 段必须提供 asset_ref，可选 alt；没有现成图片资产时不要提交 image 段。',
  ];

  if (snapshot.canVoice) {
    lines.push(`如果要发语音，就提交 voice 段。单个 voice 段上限约 ${outputMaxWords} 词、${outputMaxSeconds} 秒；较长内容拆成多个 voice 段。`);
    lines.push(
      '文本 + voice 混排示例：submit_reply_plan({"segments":[{"kind":"text","content":"先说一句"},{"kind":"voice","content":"接着用语音继续"},{"kind":"text","content":"最后补一句"}]})',
    );
  }

  return lines.join('\n');
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

async function deliverReplyPlan(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  plan: ReplyTransportPlan;
  sendStrand: ReturnType<typeof createKeyedStrandRunner>;
  canSendRecordCache: Map<string, boolean>;
  ttsCapabilityStates: Map<string, TtsCapabilityState>;
  replyRuntime: ReplyRuntime;
  runId: string;
}): Promise<ReplyPlanDeliveryResult> {
  const { runtime, session, plan, sendStrand, canSendRecordCache, ttsCapabilityStates, replyRuntime, runId } = args;
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
  replyRuntime.setPlannedUnitHistory(runId, plannedUnitHistoryLines);
  const sendAbortSignal = replyRuntime.beginSending(runId);
  if (!sendAbortSignal || !replyRuntime.isCurrentRun(runId)) {
    return { status: 'interrupted', historyText: replyRuntime.getCommittedHistoryText(runId) };
  }

  let beganSending = false;
  const sendTask = async () => {
    const { sendWhole, sendLine } = createBotMessageDispatchers(bot, session.channelId!, session);
    await dispatchOutboundMessagePlan(outboundPlan, async (segment) => {
      const historyLine = plannedUnitHistoryLines[outboundPlan.segments.indexOf(segment)] ?? '';
      if (segment.kind === 'multiline-block') {
        beganSending = true;
        await sendWhole(segment.content);
        replyRuntime.recordCommittedUnit(runId, historyLine);
        return;
      }

      if (segment.kind === 'text-line') {
        beganSending = true;
        await sendLine(segment.content);
        replyRuntime.recordCommittedUnit(runId, historyLine);
        return;
      }

      if (segment.kind === 'sticker-block') {
        const prepared = preparedSticker.preparedByRaw.get(segment.raw);
        if (!prepared) {
          throw new Error('missing_prepared_sticker');
        }

        beganSending = true;
        await bot.sendMessage(
          session.channelId!,
          String(h.image(prepared.buffer, prepared.mime)),
          undefined,
          createBypassLineSplitOptions(session),
        );
        replyRuntime.recordCommittedUnit(runId, historyLine);
        return;
      }

      if (segment.kind === 'image-block') {
        beganSending = true;
        await bot.sendMessage(
          session.channelId!,
          String(h.image(segment.assetRef)),
          undefined,
          createBypassLineSplitOptions(session),
        );
        replyRuntime.recordCommittedUnit(runId, historyLine);
        return;
      }

      const prepared = preparedVoice.preparedByRaw.get(segment.raw);
      if (!prepared) {
        throw new Error('missing_prepared_voice');
      }

      beganSending = true;
      await bot.sendMessage(
        session.channelId!,
        String(h.audio(createAudioDataUri(prepared.wav))),
        undefined,
        createBypassLineSplitOptions(session),
      );
      replyRuntime.recordCommittedUnit(runId, historyLine);
    }, {
      abortSignal: sendAbortSignal,
    });
  };

  try {
    const strandKey = resolveSessionStrandKey(session);
    if (strandKey) {
      await sendStrand.run(strandKey, sendTask);
    } else {
      await sendTask();
    }
  } catch (error) {
    logger.warn('reply plan delivery failed: %s', (error as Error).message);
    if (sendAbortSignal.aborted || replyRuntime.wasInterrupted(runId)) {
      return { status: 'interrupted', historyText: replyRuntime.getCommittedHistoryText(runId) };
    }
    if (beganSending) {
      return { status: 'failed_after_partial_send', historyText: replyRuntime.getCommittedHistoryText(runId) };
    }
    return { status: 'failed_before_send', fallbackText: effectiveFallbackText, historyText: effectiveFallbackText };
  }

  if (sendAbortSignal.aborted || replyRuntime.wasInterrupted(runId)) {
    return { status: 'interrupted', historyText: replyRuntime.getCommittedHistoryText(runId) };
  }

  return { status: 'delivered', historyText: effectiveHistoryText };
}

function isReplyPlanSessionAvailable(session: Session): boolean {
  return session.platform === 'onebot' && Boolean(session.channelId);
}

export function apply(ctx: Context, config: Config = {}): void {
  const runtime = toRuntimeConfig(config);
  const featurePolicy = (ctx as ContextWithChatLuna).featurePolicy;
  const sendStrand = createKeyedStrandRunner();
  const canSendRecordCache = new Map<string, boolean>();
  const ttsCapabilityStates = new Map<string, TtsCapabilityState>();
  const replyCapabilitySnapshots = new Map<string, ReplyCapabilitySnapshot>();

  const resolveChatLunaService = (): ChatLunaLike | undefined => {
    const byGetter = typeof (ctx as { get?: (name: string) => unknown }).get === 'function'
      ? ((ctx as { get: (name: string) => unknown }).get('chatluna') as ChatLunaLike | undefined)
      : undefined;
    return byGetter ?? (ctx as ContextWithChatLuna).chatluna;
  };

  const resolveVoiceFeatureState = async (session: SessionWithVoiceState): Promise<{
    enabled: boolean;
    inputEnabled: boolean;
    outputEnabled: boolean;
  }> => {
    const overallEnabled = !featurePolicy || (await featurePolicy.resolveFeatureEnabled(session, 'QQ_VOICE_ENABLED'));
    if (!overallEnabled) {
      return {
        enabled: false,
        inputEnabled: false,
        outputEnabled: false,
      };
    }

    const [inputEnabled, outputEnabled] = await Promise.all([
      !featurePolicy || featurePolicy.resolveFeatureEnabled(session, 'QQ_VOICE_INPUT_ENABLED'),
      !featurePolicy || featurePolicy.resolveFeatureEnabled(session, 'QQ_VOICE_OUTPUT_ENABLED'),
    ]);

    return {
      enabled: runtime.enabled && overallEnabled,
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
      if (!runtime.enabled || !runtime.inputEnabled || !voiceFeatureState.enabled || !voiceFeatureState.inputEnabled) {
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
        canSendRecordCache,
        ttsCapabilityStates,
        voiceOutputEnabled: voiceFeatureState.enabled && voiceFeatureState.outputEnabled,
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
        .map(async (bot) => ensureCanSendRecord(bot as unknown as OneBotBotLike, canSendRecordCache, true)),
    );
    if (isVoiceOutputConfigured(runtime)) {
      const ttsState = getTtsCapabilityState(runtime, ttsCapabilityStates);
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
        const strandKey = resolveSessionStrandKey(session);
        if (!room || !conversationId || !strandKey) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }
        const runMode = await resolveReplyRunMode(session);

        const runId = `qqreply:${randomUUID()}`;
        const prepared = await replyRuntime.prepareRun({
          runId,
          strandKey,
          conversationId,
          room,
          mode: runMode,
          input: createReplyTurnInput(session),
        });
        if (prepared.action === 'stop') {
          return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
        }
        applyPreparedInputText(session, context, prepared.inputText);
        registerReplyTurnStateFragment(conversationId, prepared.continuationContext);
        setReplyRunId(session, runId);
        if (context.options) {
          context.options.messageId = runId;
        }
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      }) as ChatLunaChainBuilderLike;
    prepareBuilder.after('read_chat_message');
    prepareBuilder.before('chatluna_time_context');
    prepareBuilder.before('qqbot_memory_v2');
    prepareBuilder.before('qqbot_reply_transport_policy');

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
        room.chatMode = 'reply-agent';
        const voiceFeatureState = await resolveVoiceFeatureState(session);

        const snapshot =
          getAuthorizedReplyCapabilitySnapshot(session, replyCapabilitySnapshots) ??
          (await resolveReplyCapabilitySnapshot({
            runtime,
            session,
            canSendRecordCache,
            ttsCapabilityStates,
            voiceOutputEnabled: voiceFeatureState.enabled && voiceFeatureState.outputEnabled,
          }));
        rememberReplyCapabilitySnapshot(session, snapshot, replyCapabilitySnapshots);
        registerPromptFragment(conversationId, {
          source: 'qqbot_reply_transport_capability',
          title: 'Reply Transport Capability State',
          authority: 'runtime_contract',
          trust: 'trusted',
          ttl: 'turn',
          payload: {
            kind: 'json',
            value: buildReplyTransportCapabilityState(
              snapshot,
              runtime.outputMaxWords,
              runtime.outputMaxSeconds,
            ),
          },
        });
        const executionRules = buildReplyTransportExecutionRules(
          snapshot,
          runtime.outputMaxWords,
          runtime.outputMaxSeconds,
        );
        if (executionRules) {
          registerPromptFragment(conversationId, {
            source: 'qqbot_reply_transport_execution_rules',
            title: 'Reply Transport Execution Rules',
            authority: 'runtime_contract',
            trust: 'trusted',
            ttl: 'turn',
            payload: {
              kind: 'text',
              value: executionRules,
            },
          });
        }
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      }) as ChatLunaChainBuilderLike;
    policyBuilder.after('read_chat_message');
    policyBuilder.before('lifecycle-handle_command');

    const executorBuilder = chain.middleware('qqbot_reply_plan_executor', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const responseMessage = context.options?.responseMessage;
        if (!responseMessage) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        const runMode = await resolveReplyRunMode(session);
        let runId = getReplyRunId(session);
        if (!runId) {
          const room = context.options?.room as ReplyRuntimeRoomLike | undefined;
          const conversationId = room?.conversationId?.trim();
          const strandKey = resolveSessionStrandKey(session);
          if (!room || !conversationId || !strandKey) {
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }
          runId = `qqreply:${randomUUID()}`;
          const prepared = await replyRuntime.prepareRun({
            runId,
            strandKey,
            conversationId,
            room,
            mode: runMode,
            input: createReplyTurnInput(session),
          });
          if (prepared.action === 'stop') {
            if (context.options) {
              context.options.responseMessage = null;
            }
            return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
          }
          applyPreparedInputText(session, context, prepared.inputText);
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

        const parsedPlan = parseReplyPlanFromToolResultDetailed(responseMessage);
        if (!parsedPlan.plan) {
          logReplyPlanDebug(context, 'terminal_tool_missing_or_invalid', {
            parseError: parsedPlan.error,
            terminalToolName: parsedPlan.terminalToolName,
            rawOutputText: serializeReplyPlanRawOutput(responseMessage.content),
            terminalToolPayload: responseMessage.additional_kwargs?.chatluna_agent_terminal_tool ?? null,
          });
          replyRuntime.finishRun(runId);
          throw new Error(parsedPlan.error ?? 'reply-agent 未提交合法的 submit_reply_plan。');
        }
        const voiceFeatureState = await resolveVoiceFeatureState(session);

        const snapshot =
          getAuthorizedReplyCapabilitySnapshot(session, replyCapabilitySnapshots) ??
          (await resolveReplyCapabilitySnapshot({
            runtime,
            session,
            canSendRecordCache,
            ttsCapabilityStates,
            voiceOutputEnabled: voiceFeatureState.enabled && voiceFeatureState.outputEnabled,
          }));
        rememberReplyCapabilitySnapshot(session, snapshot, replyCapabilitySnapshots);

        const executablePlan =
          snapshot.canVoice || !parsedPlan.plan.segments.some((segment) => segment.kind === 'voice')
            ? parsedPlan.plan
            : downgradeVoiceSegmentsToText(parsedPlan.plan);
        try {
          const result = await deliverReplyPlan({
            runtime,
            session,
            plan: executablePlan,
            sendStrand,
            canSendRecordCache,
            ttsCapabilityStates,
            replyRuntime,
            runId,
          });

          const room = context.options?.room;
          if (result.status === 'failed_before_send') {
            if (responseMessage) {
              responseMessage.content = result.fallbackText;
            }
          } else if (context.options) {
            context.options.responseMessage = null;
          }

          try {
            await normalizeReplyAgentHistory(ctx, room, result.historyText);
          } catch (error) {
            logger.warn('reply-agent history normalization failed: %s', (error as Error).message);
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
