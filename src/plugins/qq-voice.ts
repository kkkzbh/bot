import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager';
import { StructuredTool, type ToolRunnableConfig } from '@langchain/core/tools';
import { readFile } from 'node:fs/promises';
import { Context, h, Logger, Schema, type Session, type Universal } from 'koishi';
import { z } from 'zod';
import {
  buildVoiceFailureReply,
  containsExplicitVoiceRequest,
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
  shouldBypassLineSplit,
  type OutboundMessagePlan,
  type OutboundMessageSegment,
  type ReplyTransportPlan,
} from './message-send-utils.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
};

const logger = new Logger('qq-voice');
const TTS_PROBE_TURN_INTERVAL = 12;
const TTS_PROBE_TIME_INTERVAL_MS = 45_000;
const TTS_PROBE_FAILURE_BACKOFF_MS = 10_000;
const TTS_PROBE_TIMEOUT_MS = 5_000;

const REPLY_COMPOSE_SCHEMA = z.object({
  segments: z
    .array(
      z.object({
        kind: z.enum(['text', 'multiline']).describe('回复段类型：普通文本或单条多行消息'),
        content: z.string().describe('要发送的正文内容'),
      }),
    )
    .min(1)
    .describe('按顺序发送的回复段列表'),
});

const REPLY_COMPOSE_WITH_VOICE_SCHEMA = z.object({
  segments: z
    .array(
      z.object({
        kind: z.enum(['text', 'multiline', 'voice']).describe('回复段类型：普通文本、单条多行消息或语音'),
        content: z.string().describe('要发送的正文内容'),
      }),
    )
    .min(1)
    .describe('按顺序发送的回复段列表'),
});

export const name = 'qq-voice';

export interface Config {
  enabled?: boolean;
  inputEnabled?: boolean;
  outputEnabled?: boolean;
  asrBaseUrl?: string;
  asrApiKey?: string;
  ttsBaseUrl?: string;
  ttsApiKey?: string;
  inputMaxSeconds?: number;
  outputMaxChars?: number;
  transcribeTimeoutMs?: number;
  synthTimeoutMs?: number;
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
  outputMaxChars: Schema.natural().default(30).description('单个 <qqbot-voice> 块最大字符数。'),
  transcribeTimeoutMs: Schema.natural().role('time').default(30000).description('ASR 请求超时（毫秒）。'),
  synthTimeoutMs: Schema.natural().role('time').default(180000).description('TTS 请求超时（毫秒）。'),
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
  outputMaxChars: number;
  transcribeTimeoutMs: number;
  synthTimeoutMs: number;
}

interface QqVoiceState {
  transcript: string;
  durationMs: number;
  source: string;
  voiceReplyRequested: boolean;
}

type ReplyCapabilitySource = 'cached' | 'probed' | 'forced';

interface ReplyCapabilitySnapshot {
  canMultiline: true;
  canVoice: boolean;
  source: ReplyCapabilitySource;
  refreshedAt: number;
  explicitVoiceRequest: boolean;
}

interface ReplyTransportState {
  capabilitySnapshot?: ReplyCapabilitySnapshot;
  delivered?: boolean;
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

type ReplyComposeInput = z.infer<typeof REPLY_COMPOSE_SCHEMA>;
type ReplyComposeWithVoiceInput = z.infer<typeof REPLY_COMPOSE_WITH_VOICE_SCHEMA>;

type ReplyToolResult =
  | { status: 'delivered' }
  | { status: 'unavailable'; mode: 'voice'; retry: 'text_only'; reason: string }
  | { status: 'failed_preflight'; retry: 'text_only'; reason: string }
  | { status: 'failed_after_partial_delivery'; retry: 'none'; reason: string };

type ChatLunaToolRunnable = ToolRunnableConfig & {
  configurable?: {
    session?: SessionWithVoiceState;
    conversationId?: string;
  };
};

type HotfixToolDescriptor = {
  createTool: (params: unknown) => unknown;
  selector: () => boolean;
  authorization?: (session: Session) => boolean;
};

type PlatformLike = {
  registerTool?: (name: string, tool: HotfixToolDescriptor) => unknown;
};

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
  platform?: PlatformLike;
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
    outputMaxChars: clampNatural(config.outputMaxChars ?? process.env.QQ_VOICE_OUTPUT_MAX_CHARS, 30),
    transcribeTimeoutMs: clampNatural(
      config.transcribeTimeoutMs ?? process.env.QQ_VOICE_TRANSCRIBE_TIMEOUT_MS,
      30_000,
    ),
    synthTimeoutMs: clampNatural(config.synthTimeoutMs ?? process.env.QQ_VOICE_SYNTH_TIMEOUT_MS, 180_000),
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

function markReplyToolDelivered(session: SessionWithVoiceState): void {
  getReplyTransportState(session).delivered = true;
}

function consumeReplyToolDelivered(session: SessionWithVoiceState): boolean {
  const transportState = session.state?.qqReplyTransport;
  if (!transportState?.delivered) return false;
  transportState.delivered = false;
  return true;
}

function formatReplyToolResult(result: ReplyToolResult): string {
  return JSON.stringify(result);
}

function createReplyToolUnavailable(reason: string): ReplyToolResult {
  return {
    status: 'unavailable',
    mode: 'voice',
    retry: 'text_only',
    reason,
  };
}

function createReplyToolPreflightFailure(reason: string): ReplyToolResult {
  return {
    status: 'failed_preflight',
    retry: 'text_only',
    reason,
  };
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
  const explicitVoiceRequest =
    session.state?.qqVoice?.voiceReplyRequested === true || containsExplicitVoiceRequest(getTextInputContent(session));

  const snapshot: ReplyCapabilitySnapshot = {
    canMultiline: true,
    canVoice: false,
    source: 'cached',
    refreshedAt: Date.now(),
    explicitVoiceRequest,
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

  if (explicitVoiceRequest && (ttsState.lastKnownHealthy !== true || due)) {
    snapshot.canVoice = await runTtsHealthProbe(runtime, ttsState, true);
    snapshot.source = 'forced';
    snapshot.refreshedAt = Date.now();
    return snapshot;
  }

  if (due && snapshot.refreshedAt >= ttsState.failureBackoffUntil && !ttsState.pendingProbe) {
    void runTtsHealthProbe(runtime, ttsState).catch((error) => {
      logger.warn('background tts probe failed: %s', (error as Error).message);
    });
  }

  snapshot.canVoice = ttsState.lastKnownHealthy === true;
  return snapshot;
}

function buildReplyTransportPolicy(snapshot: ReplyCapabilitySnapshot): string {
  const lines = [
    '当前回复传输规则：普通闲聊、问答、安慰或解释时，直接输出普通文本，不要调用 reply_compose。',
    '只有代码、命令、配置、日志、明确列表或分步骤结果，才调用 reply_compose 发送单条多行消息。',
  ];

  if (snapshot.canVoice) {
    lines.push('本轮 reply_compose_with_voice 可用。只有用户明确要求语音，或你确实要用语音表达时，才调用它。');
  } else {
    lines.push(
      '本轮 reply_compose_with_voice 不可用。不要尝试任何语音工具；如果用户要求语音，就自然地用文字回答，不要提及工具、系统、TTS、接口或故障。',
    );
  }

  lines.push('一旦 reply tool 已经把内容发出，最终 assistant 正文不要重复相同内容。');
  return lines.join('');
}

function hasVoiceSegments(plan: OutboundMessagePlan): boolean {
  return plan.segments.some((segment) => segment.kind === 'voice-block');
}

async function prepareVoiceDeliveries(args: {
  runtime: RuntimeConfig;
  plan: OutboundMessagePlan;
  bot: OneBotBotLike;
  canSendRecordCache: Map<string, boolean>;
  ttsCapabilityStates: Map<string, TtsCapabilityState>;
}): Promise<{ preparedByRaw: Map<string, PreparedVoiceDelivery> } | { result: ReplyToolResult }> {
  const { runtime, plan, bot, canSendRecordCache, ttsCapabilityStates } = args;
  if (!hasVoiceSegments(plan)) {
    return { preparedByRaw: new Map() };
  }
  if (!isVoiceOutputConfigured(runtime)) {
    return { result: createReplyToolUnavailable('voice_output_disabled') };
  }
  if (!(await ensureCanSendRecord(bot, canSendRecordCache))) {
    return { result: createReplyToolUnavailable('record_send_unavailable') };
  }

  const voiceSegments = plan.segments.filter(
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
        if (text.length > runtime.outputMaxChars) {
          throw new Error(`voice_segment_too_long:${runtime.outputMaxChars}`);
        }

        const style = pickVoiceStyle(text);
        const wav = await synthesizeVoice(runtime, text, style);
        return [segment.raw, { segment, text, style, wav }] as const;
      }),
    );

    for (const [raw, prepared] of preparedEntries) {
      preparedByRaw.set(raw, prepared);
    }

    updateTtsCapabilityObservation(ttsState, true);
    return { preparedByRaw };
  } catch (error) {
    updateTtsCapabilityObservation(ttsState, false);
    const reason = (error as Error).message;
    if (reason.startsWith('voice_segment_too_long:')) {
      return {
        result: createReplyToolPreflightFailure(`voice_segments_must_be_within_${runtime.outputMaxChars}_chars`),
      };
    }
    if (reason === 'empty_voice_segment') {
      return { result: createReplyToolPreflightFailure('voice_segment_empty') };
    }
    logger.warn('voice preflight failed: %s', reason);
    return { result: createReplyToolUnavailable('tts_preflight_failed') };
  }
}

async function deliverReplyPlan(args: {
  runtime: RuntimeConfig;
  session: SessionWithVoiceState;
  plan: ReplyTransportPlan;
  sendStrand: ReturnType<typeof createKeyedStrandRunner>;
  canSendRecordCache: Map<string, boolean>;
  ttsCapabilityStates: Map<string, TtsCapabilityState>;
}): Promise<ReplyToolResult> {
  const { runtime, session, plan, sendStrand, canSendRecordCache, ttsCapabilityStates } = args;
  if (session.platform !== 'onebot' || !session.channelId) {
    return createReplyToolPreflightFailure('qq_session_unavailable');
  }

  const outboundPlan = buildOutboundMessagePlanFromReplyPlan(plan);
  if (!outboundPlan.segments.length) {
    return createReplyToolPreflightFailure('empty_reply_plan');
  }

  const bot = session.bot as OneBotBotLike;
  const preparedVoice = await prepareVoiceDeliveries({
    runtime,
    plan: outboundPlan,
    bot,
    canSendRecordCache,
    ttsCapabilityStates,
  });
  if ('result' in preparedVoice) {
    return preparedVoice.result;
  }

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
    logger.warn('reply tool delivery failed: %s', (error as Error).message);
    if (beganSending) {
      return {
        status: 'failed_after_partial_delivery',
        retry: 'none',
        reason: 'delivery_interrupted_after_partial_send',
      };
    }
    return createReplyToolPreflightFailure('delivery_failed_before_send');
  }

  markReplyToolDelivered(session);
  return { status: 'delivered' };
}

type ReplyToolDeps = {
  runtime: RuntimeConfig;
  sendStrand: ReturnType<typeof createKeyedStrandRunner>;
  canSendRecordCache: Map<string, boolean>;
  ttsCapabilityStates: Map<string, TtsCapabilityState>;
};

function isReplyToolSessionAvailable(session: Session): boolean {
  return session.platform === 'onebot' && Boolean(session.channelId);
}

class ReplyComposeTool extends StructuredTool<typeof REPLY_COMPOSE_SCHEMA, ReplyComposeInput, ReplyComposeInput, string> {
  name = 'reply_compose';
  description = '按顺序发送普通文本或单条多行消息。普通闲聊不要调用；只有结构化多行内容才用。';
  schema = REPLY_COMPOSE_SCHEMA;

  constructor(private deps: ReplyToolDeps) {
    super();
  }

  protected async _call(
    input: ReplyComposeInput,
    _runManager?: CallbackManagerForToolRun,
    parentConfig?: ToolRunnableConfig,
  ): Promise<string> {
    const session = (parentConfig as ChatLunaToolRunnable)?.configurable?.session;
    if (!session) {
      return formatReplyToolResult(createReplyToolPreflightFailure('session_missing'));
    }

    const result = await deliverReplyPlan({
      ...this.deps,
      session,
      plan: input as ReplyTransportPlan,
    });
    return formatReplyToolResult(result);
  }
}

class ReplyComposeWithVoiceTool extends StructuredTool<
  typeof REPLY_COMPOSE_WITH_VOICE_SCHEMA,
  ReplyComposeWithVoiceInput,
  ReplyComposeWithVoiceInput,
  string
> {
  name = 'reply_compose_with_voice';
  description =
    '按顺序发送普通文本、单条多行消息或语音。只有当前语音能力可用，且用户明确要求语音或确实需要语音表达时才用。';
  schema = REPLY_COMPOSE_WITH_VOICE_SCHEMA;

  constructor(private deps: ReplyToolDeps) {
    super();
  }

  protected async _call(
    input: ReplyComposeWithVoiceInput,
    _runManager?: CallbackManagerForToolRun,
    parentConfig?: ToolRunnableConfig,
  ): Promise<string> {
    const session = (parentConfig as ChatLunaToolRunnable)?.configurable?.session;
    if (!session) {
      return formatReplyToolResult(createReplyToolPreflightFailure('session_missing'));
    }

    const result = await deliverReplyPlan({
      ...this.deps,
      session,
      plan: input as ReplyTransportPlan,
    });
    return formatReplyToolResult(result);
  }
}

function registerReplyTransportTools(platform: PlatformLike | undefined, deps: ReplyToolDeps): boolean {
  if (!platform?.registerTool) return false;

  platform.registerTool('reply_compose', {
    createTool: () => new ReplyComposeTool(deps),
    selector: () => true,
    authorization: (session) => isReplyToolSessionAvailable(session),
  });

  platform.registerTool('reply_compose_with_voice', {
    createTool: () => new ReplyComposeWithVoiceTool(deps),
    selector: () => true,
    authorization: (session) =>
      isReplyToolSessionAvailable(session) &&
      (getReplyCapabilitySnapshot(session as SessionWithVoiceState)?.canVoice ?? false),
  });

  return true;
}

export function apply(ctx: Context, config: Config = {}): void {
  const runtime = toRuntimeConfig(config);
  const sendStrand = createKeyedStrandRunner();
  const canSendRecordCache = new Map<string, boolean>();
  const ttsCapabilityStates = new Map<string, TtsCapabilityState>();
  let toolsRegistered = false;

  const resolveChatLunaService = (): ChatLunaLike | undefined => {
    const byGetter = typeof (ctx as { get?: (name: string) => unknown }).get === 'function'
      ? ((ctx as { get: (name: string) => unknown }).get('chatluna') as ChatLunaLike | undefined)
      : undefined;
    return byGetter ?? (ctx as ContextWithChatLuna).chatluna;
  };

  const ensureToolsRegistered = (trigger: 'ready' | 'interval') => {
    if (toolsRegistered) return;
    const platform = resolveChatLunaService()?.platform;
    if (!registerReplyTransportTools(platform, { runtime, sendStrand, canSendRecordCache, ttsCapabilityStates })) {
      if (trigger === 'ready') {
        logger.warn('chatluna platform is not available yet, skip reply transport tool registration.');
      }
      return;
    }

    toolsRegistered = true;
    logger.info('registered local reply transport tools.');
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
        const voiceReplyRequested = containsExplicitVoiceRequest(merged);

        updateVoiceState(session, {
          transcript: transcript.text,
          durationMs: transcript.durationMs,
          source: downloaded.source,
          voiceReplyRequested,
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

  ctx.on('before-send', async (rawSession, options) => {
    const session = rawSession as SessionWithVoiceState;
    if (options && shouldBypassLineSplit(options)) return;
    if (session.platform !== 'onebot') return;
    if (consumeReplyToolDelivered(session)) return true;
  });

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

    ensureToolsRegistered('ready');

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
        if (!isReplyToolSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const conversationId = context.options?.room?.conversationId;
        if (!conversationId) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;

        const snapshot = await resolveReplyCapabilitySnapshot({
          runtime,
          session,
          canSendRecordCache,
          ttsCapabilityStates,
        });
        setReplyCapabilitySnapshot(session, snapshot);
        contextManager.inject({
          name: 'qqbot_reply_transport_policy',
          value: buildReplyTransportPolicy(snapshot),
          once: true,
          conversationId,
          stage: 'after_scratchpad',
        });
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('read_chat_message')
      .before('lifecycle-handle_command');
  });

  (ctx as { setInterval?: (callback: () => void, delay: number) => void }).setInterval?.(
    () => ensureToolsRegistered('interval'),
    15_000,
  );
}
