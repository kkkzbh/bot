import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { Context, h, Logger, Schema, type Session, type Universal } from 'koishi';
import {
  buildVoiceFailureReply,
  extractFirstIncomingVoice,
  extractTextContentWithoutVoice,
  mergeVoiceInputText,
  normalizeVoiceSynthesisText,
  pickVoiceStyle,
} from './qq-voice-core.js';
import {
  buildOutboundMessagePlanFromReplyPlan,
  createBypassLineSplitOptions,
  createBotMessageDispatchers,
  createKeyedStrandRunner,
  dispatchOutboundMessagePlan,
  resolveSessionStrandKey,
  sendBotMessageByNormalizedContent,
  type OutboundMessagePlan,
  type OutboundMessageSegment,
  type ReplyTransportPlan,
} from './message-send-utils.js';
import { parseReplyPlanFromModelOutput, renderReplyPlanHistoryText } from './reply-plan-utils.js';

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
export const inject = ['chatluna', 'database'];

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
}

type SessionWithVoiceState = Session & {
  stripped?: { content?: string };
  state?: Record<string, unknown> & {
    qqVoice?: QqVoiceState;
    qqReplyTransport?: ReplyTransportState;
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

type ReplyPlanDeliveryResult =
  | { status: 'delivered'; historyText: string }
  | { status: 'failed_before_send'; fallbackText: string; historyText: string }
  | { status: 'failed_after_partial_send'; historyText: string };

type ChatLunaLike = {
  contextManager?: {
    inject: (options: {
      name: string;
      value: unknown;
      once?: boolean;
      conversationId?: string;
      stage?: string;
    }) => void;
  };
  chatChain?: {
    middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => {
      after: (name: string) => { before: (name: string) => unknown };
      before: (name: string) => unknown;
    };
  };
};

type ContextWithChatLuna = Context & { chatluna?: ChatLunaLike };

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

async function rewriteLatestAssistantHistoryMessage(
  ctx: Context,
  conversationId: string | undefined,
  messageText: string,
): Promise<void> {
  const normalized = messageText.trim();
  const database = (ctx as { database?: any }).database;
  if (!conversationId || !normalized || !database) return;

  try {
    const [conversation] = await database.get('chathub_conversation', { id: conversationId });
    const latestId = conversation?.latestId;
    if (!latestId) return;

    const [latestMessage] = await database.get('chathub_message', { id: latestId });
    if (!latestMessage || latestMessage.role !== 'ai') return;

    const encoded = gzipJsonToArrayBuffer(JSON.stringify(normalized));
    await database.upsert('chathub_message', [{ ...latestMessage, content: encoded }]);
    await database.upsert('chathub_conversation', [{ id: conversationId, latestId, updatedAt: new Date() }]);
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
}): Promise<ReplyCapabilitySnapshot> {
  const { runtime, session, canSendRecordCache, ttsCapabilityStates } = args;
  const snapshot: ReplyCapabilitySnapshot = {
    canMultiline: true,
    canVoice: false,
    source: 'cached',
    refreshedAt: Date.now(),
  };

  if (!isVoiceOutputConfigured(runtime)) {
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

function buildReplyTransportPolicy(snapshot: ReplyCapabilitySnapshot, outputMaxWords: number, outputMaxSeconds: number): string {
  const lines = [
    '当前回复能力：普通文本始终可用。普通闲聊、问答、安慰或解释时，默认直接输出自然文本。',
    '当你需要发送代码、命令、配置、日志、清单或分步骤结果时，可以直接输出一个 ReplyPlan JSON 对象。',
    '如果你决定使用 ReplyPlan，就只输出 ReplyPlan JSON 对象本身，不要添加解释、前缀或代码块。',
    'ReplyPlan JSON 格式：{"segments":[{"kind":"multiline","content":"第一行\\n第二行"}]}',
  ];

  if (snapshot.canVoice) {
    lines.push(
      `本轮语音回复可用。如果对方希望你用语音回复，或者你判断语音更适合当前表达，就直接输出一个包含一个或多个 voice 段的 ReplyPlan JSON 对象。单个 voice 段上限约 ${outputMaxWords} 词、${outputMaxSeconds} 秒；多个 voice 段会按顺序发送；较长内容请拆成多个 voice 段。`,
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

async function deliverReplyPlan(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  plan: ReplyTransportPlan;
  sendStrand: ReturnType<typeof createKeyedStrandRunner>;
  canSendRecordCache: Map<string, boolean>;
  ttsCapabilityStates: Map<string, TtsCapabilityState>;
}): Promise<ReplyPlanDeliveryResult> {
  const { runtime, session, plan, sendStrand, canSendRecordCache, ttsCapabilityStates } = args;
  const historyText = renderReplyPlanHistoryText(plan);
  if (session.platform !== 'onebot' || !session.channelId) {
    return { status: 'failed_before_send', fallbackText: historyText, historyText };
  }

  const preparedVoice = await prepareVoiceDeliveries({
    runtime,
    plan,
    bot: session.bot as OneBotBotLike,
    canSendRecordCache,
    ttsCapabilityStates,
  });
  const effectivePlan = preparedVoice.effectivePlan;
  const outboundPlan = buildOutboundMessagePlanFromReplyPlan(effectivePlan);
  if (!outboundPlan.segments.length) {
    return { status: 'failed_before_send', fallbackText: historyText, historyText };
  }

  const bot = session.bot as OneBotBotLike;
  const effectiveHistoryText = renderReplyPlanHistoryText(effectivePlan) || historyText;

  let beganSending = false;
  const sendTask = async () => {
    const { sendWhole, sendLine } = createBotMessageDispatchers(bot, session.channelId!, session);
    await dispatchOutboundMessagePlan(outboundPlan, async (segment) => {
      if (segment.kind === 'multiline-block') {
        beganSending = true;
        await sendWhole(segment.content);
        return;
      }

      if (segment.kind === 'text-line') {
        beganSending = true;
        await sendLine(segment.content);
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
    if (beganSending) {
      return { status: 'failed_after_partial_send', historyText: effectiveHistoryText };
    }
    return { status: 'failed_before_send', fallbackText: effectiveHistoryText, historyText: effectiveHistoryText };
  }

  return { status: 'delivered', historyText: effectiveHistoryText };
}

function isReplyPlanSessionAvailable(session: Session): boolean {
  return session.platform === 'onebot' && Boolean(session.channelId);
}

export function apply(ctx: Context, config: Config = {}): void {
  const runtime = toRuntimeConfig(config);
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

  ctx.middleware(
    async (rawSession, next) => {
      const session = rawSession as SessionWithVoiceState;
      if (!runtime.enabled || !runtime.inputEnabled) return next();
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

      const snapshot = await resolveReplyCapabilitySnapshot({
        runtime,
        session,
        canSendRecordCache,
        ttsCapabilityStates,
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
    const contextManager = chatluna?.contextManager;
    if (!contextManager || !chain) {
      logger.warn('chatluna service is not available, skip reply transport policy middleware.');
      return;
    }

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

        const snapshot =
          getAuthorizedReplyCapabilitySnapshot(session, replyCapabilitySnapshots) ??
          (await resolveReplyCapabilitySnapshot({
            runtime,
            session,
            canSendRecordCache,
            ttsCapabilityStates,
          }));
        rememberReplyCapabilitySnapshot(session, snapshot, replyCapabilitySnapshots);
        contextManager.inject({
          name: 'qqbot_reply_transport_policy',
          value: buildReplyTransportPolicy(snapshot, runtime.outputMaxWords, runtime.outputMaxSeconds),
          once: true,
          conversationId,
          stage: 'after_scratchpad',
        });
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
        const rawPlan = parseReplyPlanFromModelOutput(responseMessage?.content);
        if (!rawPlan) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;

        const snapshot =
          getAuthorizedReplyCapabilitySnapshot(session, replyCapabilitySnapshots) ??
          (await resolveReplyCapabilitySnapshot({
            runtime,
            session,
            canSendRecordCache,
            ttsCapabilityStates,
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
        });

        const conversationId = context.options?.room?.conversationId;
        await rewriteLatestAssistantHistoryMessage(ctx, conversationId, result.historyText);

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
