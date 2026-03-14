import { readFile } from 'node:fs/promises';
import { Context, h, Logger, Schema, type Session, type Universal } from 'koishi';
import {
  buildVoiceFailureReply,
  buildVoiceUnavailableInstruction,
  containsExplicitVoiceRequest,
  containsVoiceReplyControl,
  extractFirstIncomingVoice,
  extractTextContentWithoutVoice,
  mergeVoiceInputText,
  normalizeVoiceSynthesisText,
  parseVoiceReplyControl,
  pickVoiceStyle,
} from './qq-voice-core.js';
import {
  createBypassLineSplitOptions,
  createBotMessageDispatchers,
  createKeyedStrandRunner,
  dispatchNormalizedOutboundMessage,
  normalizeOutboundMessage,
  resolveSessionStrandKey,
  sendBotMessageByNormalizedContent,
  shouldBypassLineSplit,
} from './message-send-utils.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
};

const logger = new Logger('qq-voice');

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
  outputMaxChars: Schema.natural().default(120).description('单条语音回复最大字符数（默认适配约 30-60 秒语速）。'),
  transcribeTimeoutMs: Schema.natural().role('time').default(30000).description('ASR 请求超时（毫秒）。'),
  synthTimeoutMs: Schema.natural().role('time').default(90000).description('TTS 请求超时（毫秒）。'),
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

type SessionWithVoiceState = Session & {
  stripped?: { content?: string };
  state?: Record<string, unknown> & { qqVoice?: QqVoiceState };
};

type OneBotInternalLike = {
  _request?: (action: string, params?: Record<string, unknown>) => Promise<unknown>;
  canSendRecord?: () => Promise<boolean>;
  getRecord?: (file: string, format: 'wav', fullPath?: boolean) => Promise<{ file?: string }>;
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

interface CachedProbeResult {
  ok: boolean;
  expiresAt: number;
}

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
    outputMaxChars: clampNatural(config.outputMaxChars ?? process.env.QQ_VOICE_OUTPUT_MAX_CHARS, 120),
    transcribeTimeoutMs: clampNatural(
      config.transcribeTimeoutMs ?? process.env.QQ_VOICE_TRANSCRIBE_TIMEOUT_MS,
      30_000,
    ),
    synthTimeoutMs: clampNatural(config.synthTimeoutMs ?? process.env.QQ_VOICE_SYNTH_TIMEOUT_MS, 90_000),
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

async function synthesizeVoice(runtime: RuntimeConfig, text: string, style: 'white' | 'black'): Promise<Uint8Array> {
  if (!runtime.ttsBaseUrl) {
    throw new Error('missing TTS base url');
  }

  const controller = new AbortController();
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
  }
}

async function ensureTtsHealthy(
  runtime: RuntimeConfig,
  healthCache: Map<string, CachedProbeResult>,
  force = false,
): Promise<boolean> {
  if (!runtime.ttsBaseUrl) return false;

  const cacheKey = runtime.ttsBaseUrl;
  const now = Date.now();
  const cached = healthCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > now) {
    return cached.ok;
  }

  let ok = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(runtime.synthTimeoutMs, 5_000));

  try {
    const response = await fetch(`${runtime.ttsBaseUrl}/healthz`, {
      method: 'GET',
      headers: createAuthHeaders(runtime.ttsApiKey),
      signal: controller.signal,
    });
    ok = response.ok;
  } catch (error) {
    logger.warn('tts health probe failed: %s', (error as Error).message);
    ok = false;
  } finally {
    clearTimeout(timer);
  }

  healthCache.set(cacheKey, {
    ok,
    expiresAt: now + (ok ? 30_000 : 10_000),
  });
  return ok;
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
    capabilityCache.delete(cacheKey);
    return false;
  }

  let result = false;
  try {
    result = (await bot.internal?.canSendRecord?.()) ?? false;
  } catch (error) {
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

function shouldExplainVoiceUnavailable(session: SessionWithVoiceState): boolean {
  if (session.state?.qqVoice?.voiceReplyRequested) return true;
  return containsExplicitVoiceRequest(getTextInputContent(session));
}

export function apply(ctx: Context, config: Config = {}): void {
  const runtime = toRuntimeConfig(config);
  const sendStrand = createKeyedStrandRunner();
  const canSendRecordCache = new Map<string, boolean>();
  const ttsHealthCache = new Map<string, CachedProbeResult>();

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

  ctx.on('before-send', async (session, options) => {
    if (options && shouldBypassLineSplit(options)) return;
    if (session.platform !== 'onebot') return;
    if (!session.channelId || !session.content) return;
    if (!containsVoiceReplyControl(session.content)) return;

    const parsed = parseVoiceReplyControl(session.content);
    const normalized = normalizeOutboundMessage(parsed.text);
    const bot = session.bot as OneBotBotLike;
    const strandKey = resolveSessionStrandKey(session);
    const sendTask = async () => {
      const { sendWhole, sendLine } = createBotMessageDispatchers(bot, session.channelId!, session);
      await dispatchNormalizedOutboundMessage(normalized, sendWhole, sendLine);

      const voiceText = normalizeVoiceSynthesisText(parsed.voiceText ?? normalized.content);
      if (!voiceText) return;
      if (!isVoiceOutputConfigured(runtime)) return;
      if (voiceText.length > runtime.outputMaxChars) return;
      if (!(await ensureCanSendRecord(bot, canSendRecordCache))) return;
      if (!(await ensureTtsHealthy(runtime, ttsHealthCache))) return;

      try {
        const wav = await synthesizeVoice(runtime, voiceText, pickVoiceStyle(voiceText));
        await bot.sendMessage(
          session.channelId!,
          String(h.audio(createAudioDataUri(wav))),
          undefined,
          createBypassLineSplitOptions(session),
        );
      } catch (error) {
        logger.warn('voice synthesis/send failed: %s', (error as Error).message);
      }
    };

    if (strandKey) {
      await sendStrand.run(strandKey, sendTask);
    } else {
      await sendTask();
    }

    return true;
  });

  ctx.on('ready', async () => {
    await Promise.all(
      ctx.bots
        .filter((bot) => bot.platform === 'onebot')
        .map(async (bot) => ensureCanSendRecord(bot as unknown as OneBotBotLike, canSendRecordCache, true)),
    );
    if (isVoiceOutputConfigured(runtime)) {
      await ensureTtsHealthy(runtime, ttsHealthCache, true);
    }

    const chatluna = ctx.get('chatluna') as ChatLunaLike | undefined;
    const chain = chatluna?.chatChain;
    const contextManager = chatluna?.contextManager;
    if (!contextManager || !chain) {
      logger.warn('chatluna service is not available, skip voice output hint middleware.');
      return;
    }

    chain
      .middleware('qqbot_voice_output_hint', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithVoiceState;
        const context = rawContext as MiddlewareContextLike;
        if (session.platform !== 'onebot') return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!shouldExplainVoiceUnavailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (
          isVoiceOutputConfigured(runtime) &&
          (await ensureCanSendRecord(session.bot as OneBotBotLike, canSendRecordCache)) &&
          (await ensureTtsHealthy(runtime, ttsHealthCache))
        ) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const conversationId = context.options?.room?.conversationId;
        if (!conversationId) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;

        contextManager.inject({
          name: 'qqbot_voice_output_unavailable',
          value: buildVoiceUnavailableInstruction(),
          once: true,
          conversationId,
          stage: 'after_scratchpad',
        });
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('read_chat_message')
      .before('lifecycle-handle_command');
  });
}
