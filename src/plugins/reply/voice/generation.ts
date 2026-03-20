import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { Context, h, Logger, Schema, type Session, type Universal } from 'koishi';
import type { FeaturePolicyServiceLike } from '../../../types/feature-policy.js';
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
import { rewriteConversationTailForLiveReply } from '../../live-reply/index.js';
import {
  parseReplyPlanFromStructuredOutputDetailed,
  type ReplyPlanParseResult,
} from '../plan/parser.js';
import { ReplyRuntime, type ReplyRuntimeRoomLike } from '../runtime/index.js';

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
  outputMaxChars?: number;
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
  generationCapture?: ReplyGenerationCaptureState;
  runId?: string;
  suppressAbortNotice?: boolean;
}

type ReplyGenerationCapturePhase = 'reply_plan_retry';

interface ReplyGenerationCaptureResult {
  plan: ReplyTransportPlan | null;
  error: string | null;
}

interface ReplyGenerationCaptureState {
  active: boolean;
  phase: ReplyGenerationCapturePhase;
  failureReason?: string;
  result?: ReplyGenerationCaptureResult;
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

type ContextWithChatLuna = Context & { chatluna?: ChatLunaLike; featurePolicy?: FeaturePolicyServiceLike };

function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

function clampNatural(input: unknown, fallback: number): number {
  const value = Number(input);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  const legacyOutputMaxChars = clampNatural(
    config.outputMaxChars ?? process.env.QQ_VOICE_OUTPUT_MAX_CHARS,
    80,
  );

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
    outputMaxWords: clampNatural(config.outputMaxWords ?? process.env.QQ_VOICE_OUTPUT_MAX_WORDS, legacyOutputMaxChars),
    outputMaxSeconds: clampNatural(config.outputMaxSeconds ?? process.env.QQ_VOICE_OUTPUT_MAX_SECONDS, 45),
    transcribeTimeoutMs: clampNatural(
      config.transcribeTimeoutMs ?? process.env.QQ_VOICE_TRANSCRIBE_TIMEOUT_MS,
      30_000,
    ),
    synthTimeoutMs: clampNatural(config.synthTimeoutMs ?? process.env.QQ_VOICE_SYNTH_TIMEOUT_MS, 300_000),
  };
}

function createAuthHeaders(apiKey: string): Record<string, string> {
  const token = apiKey.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function decodeBase64Payload(payload: string): Uint8Array {
  return Uint8Array.from(Buffer.from(payload, 'base64'));
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function gzipJsonToArrayBuffer(value: string): ArrayBuffer {
  const compressed = gzipSync(Buffer.from(value));
  return toOwnedArrayBuffer(compressed);
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

function renderReplyPlanFallbackText(plan: ReplyTransportPlan): string {
  return plan.segments
    .filter((segment) => segment.kind !== 'sticker')
    .map((segment) => sanitizeStructuredReplySegmentContent(segment.content))
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

async function rewriteLatestAssistantHistoryMessage(
  ctx: Context,
  conversationId: string | undefined,
  messageText: string,
): Promise<void> {
  const database = (ctx as { database?: any }).database;
  if (!conversationId || !database) return;

  try {
    const normalized = messageText.trim();
    const rewritten = await rewriteConversationTailForLiveReply({
      database,
      conversationId,
      committedText: normalized,
      logger,
    });
    if (rewritten.kind === 'fallback' && normalized) {
      const [conversation] = await database.get('chathub_conversation', { id: conversationId });
      const latestId = conversation?.latestId;
      if (!latestId) return;

      const [latestMessage] = await database.get('chathub_message', { id: latestId });
      if (!latestMessage || latestMessage.role !== 'ai') return;

      const encoded = gzipJsonToArrayBuffer(JSON.stringify(normalized));
      await database.upsert('chathub_message', [{ ...latestMessage, content: encoded }]);
      await database.upsert('chathub_conversation', [{ id: conversationId, latestId, updatedAt: new Date() }]);
    }
  } catch (error) {
    logger.warn('failed to rewrite latest reply-plan history message: %s', (error as Error).message);
  }
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

function getReplyGenerationCaptureState(session: SessionWithVoiceState): ReplyGenerationCaptureState | undefined {
  return session.state?.qqReplyTransport?.generationCapture;
}

function setReplyGenerationCaptureState(session: SessionWithVoiceState, state: ReplyGenerationCaptureState): void {
  getReplyTransportState(session).generationCapture = state;
}

function clearReplyGenerationCaptureState(session: SessionWithVoiceState): void {
  delete getReplyTransportState(session).generationCapture;
}

function getReplyRunId(session: SessionWithVoiceState): string | undefined {
  const runId = session.state?.qqReplyTransport?.runId;
  return typeof runId === 'string' && runId.trim() ? runId.trim() : undefined;
}

function setReplyRunId(session: SessionWithVoiceState, runId: string): void {
  getReplyTransportState(session).runId = runId;
}

function setReplyAbortNoticeSuppressed(session: SessionWithVoiceState, suppressed: boolean): void {
  getReplyTransportState(session).suppressAbortNotice = suppressed;
}

function buildStructuredRetryInstruction(failureReason: string): string {
  return [
    '上一条 ReplyPlan 输出无效，必须立刻重试。',
    '只输出一个合法的 ReplyPlan JSON 对象本身，不要解释，不要加代码块，不要退回普通文本。',
    `上次失败原因：${failureReason}`,
  ].join('\n');
}

function ensureRetrySessionCompatibility(
  session: SessionWithVoiceState,
): void {
  const target = session as any;

  if (typeof target.resolve !== 'function') {
    target.resolve = async (value: unknown) => {
      if (typeof value === 'function') {
        return await value(target);
      }
      return await Promise.resolve(value);
    };
  }

  if (typeof target.text !== 'function') {
    target.text = (path: string) => String(path ?? '');
  }
}

async function rerunReplyGeneration(args: {
  ctx: ContextWithChatLuna;
  session: SessionWithVoiceState;
  phase: ReplyGenerationCapturePhase;
  failureReason?: string;
}): Promise<ReplyGenerationCaptureResult> {
  const { ctx, session, phase, failureReason } = args;
  const chatChain = ctx.chatluna?.chatChain;
  if (typeof chatChain?.receiveMessage !== 'function') {
    return {
      plan: null,
      error: 'ChatLuna chatChain.receiveMessage 不可用，无法执行链路内重试。',
    };
  }

  const previousCapture = getReplyGenerationCaptureState(session);
  setReplyGenerationCaptureState(session, {
    active: true,
    phase,
    failureReason,
  });
  try {
    ensureRetrySessionCompatibility(session);
    await chatChain.receiveMessage(session, ctx);
    const result = getReplyGenerationCaptureState(session)?.result;
    return result ?? {
      plan: null,
      error: '链路内重试没有返回任何可用结果。',
    };
  } finally {
    if (previousCapture) {
      setReplyGenerationCaptureState(session, previousCapture);
    } else {
      clearReplyGenerationCaptureState(session);
    }
  }
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

function applyReplyPlanRequestOverrides(context: MiddlewareContextLike): void {
  const inputMessage = context.options?.inputMessage;
  if (!inputMessage) return;

  const additionalKwargs = { ...(inputMessage.additional_kwargs ?? {}) };
  additionalKwargs.qqbot_override_request_params = {
    response_format: {
      type: 'json_object',
    },
  };

  inputMessage.additional_kwargs = additionalKwargs;
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
            kind: 'text|multiline|voice|sticker',
            content: 'string',
          },
        ],
      },
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
    '最终只输出一个 ReplyPlan JSON 对象本身，不要添加解释、前缀、代码块或动作旁白。',
    'ReplyPlan JSON 格式：{"segments":[{"kind":"text|multiline|voice|sticker","content":"..."}]}',
    '普通文字回复也必须写成 text segment，不要直接输出自然文本。',
    'text 段可按行拆发；multiline 段必须整体发送并保留换行结构。',
    'sticker 段只写自然语言意图，不写文件名或协议。',
  ];

  if (snapshot.canVoice) {
    lines.push(
      `本轮语音回复可用。如果你决定发送一条语音回复，就直接输出一个包含一个或多个 voice 段的 ReplyPlan JSON 对象。单个 voice 段上限约 ${outputMaxWords} 词、${outputMaxSeconds} 秒；多个 voice 段会按顺序发送；较长内容请拆成多个 voice 段。`,
    );
    lines.push('voice 段格式：{"segments":[{"kind":"voice","content":"一段语音内容"}]}');
    lines.push(
      '多段 voice 示例：{"segments":[{"kind":"voice","content":"第一段语音内容"},{"kind":"voice","content":"第二段语音内容"}]}',
    );
  } else {
    lines.push('本轮不使用语音回复。若对方要求语音，就自然地告诉对方你现在不想发语音。');
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
  const sendAbortSignal = replyRuntime.beginSending(runId);
  if (!sendAbortSignal || !replyRuntime.isCurrentRun(runId)) {
    return { status: 'interrupted', historyText: replyRuntime.getCommittedHistoryText(runId) };
  }

  let beganSending = false;
  const sendTask = async () => {
    const { sendWhole, sendLine } = createBotMessageDispatchers(bot, session.channelId!, session);
    await dispatchOutboundMessagePlan(outboundPlan, async (segment) => {
      if (segment.kind === 'multiline-block') {
        beganSending = true;
        await sendWhole(segment.content);
        replyRuntime.recordCommittedSegment(runId, segment, segment.content);
        return;
      }

      if (segment.kind === 'text-line') {
        beganSending = true;
        await sendLine(segment.content);
        replyRuntime.recordCommittedSegment(runId, segment, segment.content);
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
        replyRuntime.recordCommittedSegment(runId, segment, prepared.historyLine);
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
      replyRuntime.recordCommittedSegment(runId, segment, `（发送语音：${prepared.text}）`);
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
      return { status: 'failed_after_partial_send', historyText: effectiveHistoryText };
    }
    return { status: 'failed_before_send', fallbackText: effectiveFallbackText, historyText: effectiveHistoryText };
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

  const replyRuntime = new ReplyRuntime({
    stopChat: async (room, requestId) => {
      const chatluna = resolveChatLunaService();
      if (typeof chatluna?.stopChat !== 'function') return;
      await chatluna.stopChat(room as never, requestId);
    },
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
        session.stripped = { ...(session.stripped ?? {}), content: merged };
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
    const chain = chatluna?.chatChain;
    if (!chain) {
      logger.warn('chatluna service is not available, skip reply transport policy middleware.');
      return;
    }

    chain
      .middleware('qqbot_reply_runtime_prepare', async (rawSession, rawContext) => {
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

        const capture = getReplyGenerationCaptureState(session);
        const existingRunId = getReplyRunId(session);
        if (capture?.active && existingRunId) {
          replyRuntime.reuseRun({
            runId: existingRunId,
            strandKey,
            conversationId,
            room,
            session,
          });
          replyRuntime.markGenerating(existingRunId);
          setReplyAbortNoticeSuppressed(session, false);
          if (context.options) {
            context.options.messageId = existingRunId;
          }
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const runId = `qqreply:${randomUUID()}`;
        await replyRuntime.beginRun({
          runId,
          strandKey,
          conversationId,
          room,
          session,
        });
        setReplyRunId(session, runId);
        setReplyAbortNoticeSuppressed(session, false);
        if (context.options) {
          context.options.messageId = runId;
        }
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('read_chat_message')
      .before('qqbot_reply_transport_policy');

    chain
      .middleware('qqbot_reply_transport_policy', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const conversationId = context.options?.room?.conversationId;
        if (!conversationId) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
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
        const capture = getReplyGenerationCaptureState(session);
        applyReplyPlanRequestOverrides(context);
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
        registerPromptFragment(conversationId, {
          source: 'qqbot_reply_transport_execution_rules',
          title: 'Reply Transport Execution Rules',
          authority: 'runtime_contract',
          trust: 'trusted',
          ttl: 'turn',
          payload: {
            kind: 'text',
            value: buildReplyTransportExecutionRules(
              snapshot,
              runtime.outputMaxWords,
              runtime.outputMaxSeconds,
            ),
          },
        });
        if (capture?.active && capture.failureReason) {
          registerPromptFragment(conversationId, {
            source: 'qqbot_reply_transport_retry_feedback',
            title: 'Reply Transport Retry Feedback',
            authority: 'runtime_contract',
            trust: 'trusted',
            ttl: 'turn',
            payload: {
              kind: 'text',
              value: buildStructuredRetryInstruction(capture.failureReason),
            },
          });
        }
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('read_chat_message')
      .before('lifecycle-handle_command');

    chain
      .middleware('qqbot_reply_plan_executor', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const responseMessage = context.options?.responseMessage;
        if (!responseMessage) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
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
          await replyRuntime.beginRun({
            runId,
            strandKey,
            conversationId,
            room,
            session,
          });
          setReplyRunId(session, runId);
        }
        if (!replyRuntime.isCurrentRun(runId)) {
          if (context.options) {
            context.options.responseMessage = null;
          }
          replyRuntime.finishRun(runId);
          return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
        }

        const capture = getReplyGenerationCaptureState(session);
        if (capture?.active) {
          const captureResult: ReplyGenerationCaptureResult =
            parseReplyPlanFromStructuredOutputDetailed(responseMessage.content);
          setReplyGenerationCaptureState(session, {
            ...capture,
            result: captureResult,
          });
          if (context.options) {
            context.options.responseMessage = null;
          }
          return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
        }

        const firstAttempt = parseReplyPlanFromStructuredOutputDetailed(responseMessage.content);
        let rawPlan: ReplyTransportPlan | null = firstAttempt.plan;
        if (!rawPlan) {
          const retry = await rerunReplyGeneration({
            ctx: ctx as ContextWithChatLuna,
            session,
            phase: 'reply_plan_retry',
            failureReason: firstAttempt.error ?? 'ReplyPlan 输出无效。',
          });
          rawPlan = retry.plan;
          if (!rawPlan) {
            logger.warn(
              'reply plan rerun failed: first=%s retry=%s',
              firstAttempt.error ?? 'unknown',
              retry.error ?? 'unknown',
            );
          }
        }
        if (!rawPlan) {
          rawPlan = {
            segments: [
              {
                kind: 'text',
                content: '……刚刚卡了一下，你再说一次。',
              },
            ],
          };
        }
        if (!rawPlan) return ChatLunaChains.ChainMiddlewareRunStatus.STOP;
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
          snapshot.canVoice || !rawPlan.segments.some((segment) => segment.kind === 'voice')
            ? rawPlan
            : downgradeVoiceSegmentsToText(rawPlan);
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

        const conversationId = context.options?.room?.conversationId;
        await rewriteLatestAssistantHistoryMessage(ctx, conversationId, result.historyText);
        replyRuntime.finishRun(runId);

        if (result.status === 'failed_before_send') {
          if (responseMessage) {
            responseMessage.content = result.fallbackText;
          }
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        if (context.options) {
          context.options.responseMessage = null;
        }
        return result.status === 'failed_after_partial_send'
          ? ChatLunaChains.ChainMiddlewareRunStatus.STOP
          : ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('request_model')
      .before('censor');
  });
}
