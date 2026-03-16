import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import '@koishijs/plugin-server';
import { Context, Logger, Schema, type Session } from 'koishi';
import type {
  TraceEventRecord,
  TraceFinishOptions,
  TraceInjectedPromptRecord,
  TraceInjectedPromptView,
  TraceRecordOptions,
  TraceSessionRecord,
  TraceStartOptions,
  TraceViewerServiceLike,
} from '../types/trace-viewer.js';

const logger = new Logger('trace-viewer');

const TRACE_ID_STATE_KEY = 'qqbotTraceId';
const FLUSH_INTERVAL_MS = 250;
const FLUSH_BATCH_SIZE = 32;
const PRUNE_INTERVAL_MS = 60_000;
const STRING_PREVIEW_LIMIT = 600;
const SESSION_PREVIEW_LIMIT = 240;
const MAX_SANITIZE_DEPTH = 4;
const MAX_SANITIZE_ARRAY_ITEMS = 24;
const MAX_SANITIZE_OBJECT_KEYS = 40;
const CHAT_SERVICE_PATCH = Symbol.for('qqbot.traceViewer.chatServicePatched');
const CONTEXT_MANAGER_PATCH = Symbol.for('qqbot.traceViewer.contextManagerPatched');
const CHAIN_CALL_PATCH = Symbol.for('qqbot.traceViewer.chainCallPatched');
const PROCESS_CHAT_PATCH = Symbol.for('qqbot.traceViewer.processChatPatched');
const INJECTION_SOURCE_LABELS: Record<string, string> = {
  'chatluna-time-context': 'Input rewrite',
  qqbot_live_reply_continuation: 'Live reply continuation',
  qqbot_reply_transport_policy: 'Reply transport policy',
  qqbot_sticker_policy: 'Sticker policy',
};

export const name = 'trace-viewer';
export const inject = ['database', 'server'];

export interface Config {
  enabled?: boolean;
  uiPath?: string;
  apiPath?: string;
  retentionDays?: number;
  maxSessions?: number;
  maxEventPayloadBytes?: number;
  pollIntervalMs?: number;
  redactSecrets?: boolean;
}

interface RuntimeConfig {
  enabled: boolean;
  uiPath: string;
  apiPath: string;
  retentionDays: number;
  maxSessions: number;
  maxEventPayloadBytes: number;
  pollIntervalMs: number;
  redactSecrets: boolean;
}

interface TraceDraft extends TraceSessionRecord {
  nextSeq: number;
}

type SessionLike = Session & {
  state?: Record<string, unknown>;
  stripped?: { content?: string };
};

type ContextManagerInjectOptions = {
  conversationId?: string;
  name?: string;
  once?: boolean;
  stage?: string;
  value?: unknown;
} & Record<string, unknown>;

type ContextManagerLike = {
  inject?: (options: ContextManagerInjectOptions) => unknown;
} & Record<symbol, unknown>;

type ChatLunaLike = {
  chat?: (...args: any[]) => Promise<any>;
  contextManager?: ContextManagerLike;
};

type LlmChainLike = {
  prompt: { formatPromptValue: (values: Record<string, unknown>) => Promise<any> };
  llm: {
    callKeys?: string[];
    generatePrompt: (promptValue: unknown[], options: Record<string, unknown>, child?: unknown) => Promise<any>;
  };
  llmKwargs?: Record<string, unknown>;
  outputKey?: string;
};

type LlmChainPrototypeLike = LlmChainLike & {
  _call: (values: Record<string, unknown>, runManager?: any) => Promise<any>;
} & Record<symbol, unknown>;

type WrapperLike = {
  call: (arg: Record<string, unknown>) => Promise<any>;
};

type KoaContextLike = {
  body?: unknown;
  status?: number;
  type?: string;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  headers?: Record<string, string | string[] | undefined>;
  request?: { ip?: string; headers?: Record<string, string | string[] | undefined> };
  req?: { socket?: { remoteAddress?: string | null } };
  set?: (name: string, value: string) => void;
};

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('Enable lightweight trace viewer.'),
  uiPath: Schema.string().default('/trace').description('Trace viewer page path.'),
  apiPath: Schema.string().default('/trace/api').description('Trace viewer API base path.'),
  retentionDays: Schema.natural().default(7).description('Delete traces older than this many days.'),
  maxSessions: Schema.natural().default(500).description('Maximum number of recent trace sessions to keep.'),
  maxEventPayloadBytes: Schema.natural().default(65536).description('Maximum bytes stored per trace event payload.'),
  pollIntervalMs: Schema.natural().default(2000).description('UI polling interval in milliseconds.'),
  redactSecrets: Schema.boolean().default(true).description('Redact obvious secrets from stored payloads.'),
});

function clampNatural(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function normalizePath(input: string, fallback: string): string {
  const trimmed = (input || fallback).trim();
  if (!trimmed.startsWith('/')) return fallback;
  if (trimmed.length > 1 && trimmed.endsWith('/')) return trimmed.slice(0, -1);
  return trimmed || fallback;
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  return {
    enabled: config.enabled ?? String(process.env.TRACE_VIEWER_ENABLED ?? 'true').toLowerCase() !== 'false',
    uiPath: normalizePath(config.uiPath ?? process.env.TRACE_VIEWER_UI_PATH ?? '/trace', '/trace'),
    apiPath: normalizePath(config.apiPath ?? process.env.TRACE_VIEWER_API_PATH ?? '/trace/api', '/trace/api'),
    retentionDays: clampNatural(config.retentionDays ?? process.env.TRACE_VIEWER_RETENTION_DAYS, 7),
    maxSessions: clampNatural(config.maxSessions ?? process.env.TRACE_VIEWER_MAX_SESSIONS, 500),
    maxEventPayloadBytes: clampNatural(
      config.maxEventPayloadBytes ?? process.env.TRACE_VIEWER_MAX_EVENT_PAYLOAD_BYTES,
      65536,
    ),
    pollIntervalMs: clampNatural(config.pollIntervalMs ?? process.env.TRACE_VIEWER_POLL_INTERVAL_MS, 2000),
    redactSecrets:
      config.redactSecrets ?? String(process.env.TRACE_VIEWER_REDACT_SECRETS ?? 'true').toLowerCase() !== 'false',
  };
}

function ensureSessionState(session: { state?: Record<string, unknown> | undefined }): Record<string, unknown> {
  const state = session.state ?? {};
  session.state = state;
  return state;
}

function trimText(input: string | null | undefined, limit = STRING_PREVIEW_LIMIT): string | null {
  if (!input) return null;
  const text = input.trim();
  if (!text) return null;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function extractTextContent(raw: unknown): string | null {
  if (typeof raw === 'string') return trimText(raw, 12_000);
  if (Array.isArray(raw)) {
    const text = raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          if ('text' in item && typeof (item as { text?: unknown }).text === 'string') {
            return (item as { text: string }).text;
          }
          if ('content' in item && typeof (item as { content?: unknown }).content === 'string') {
            return (item as { content: string }).content;
          }
        }
        return '';
      })
      .join('\n')
      .trim();
    return trimText(text, 12_000);
  }
  if (raw && typeof raw === 'object' && 'content' in raw) {
    return extractTextContent((raw as { content?: unknown }).content);
  }
  return null;
}

function sanitizeValue(
  value: unknown,
  redactSecrets: boolean,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return trimText(value, 12_000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[function ${(value as Function).name || 'anonymous'}]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
  if (depth >= MAX_SANITIZE_DEPTH) return '[max-depth]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_SANITIZE_ARRAY_ITEMS).map((item) => sanitizeValue(item, redactSecrets, depth + 1, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_SANITIZE_OBJECT_KEYS);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      if (redactSecrets && /token|secret|authorization|cookie|password|apikey|api_key/i.test(key)) {
        result[key] = '[redacted]';
      } else {
        result[key] = sanitizeValue(entry, redactSecrets, depth + 1, seen);
      }
    }
    return result;
  }
  return String(value);
}

function serializePayload(
  payload: unknown,
  maxBytes: number,
  redactSecrets: boolean,
): { text: string; truncated: number } {
  const sanitized = sanitizeValue(payload, redactSecrets);
  const rawText =
    typeof sanitized === 'string'
      ? sanitized
      : JSON.stringify(
          sanitized,
          (_key, value) => {
            if (typeof value === 'bigint') return value.toString();
            return value;
          },
          2,
        ) ?? 'null';
  if (Buffer.byteLength(rawText, 'utf8') <= maxBytes) {
    return { text: rawText, truncated: 0 };
  }

  let low = 0;
  let high = rawText.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${rawText.slice(0, mid)}\n[truncated]`;
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return {
    text: `${rawText.slice(0, Math.max(0, low))}\n[truncated]`,
    truncated: 1,
  };
}

function normalizeIpv4(input: string): string | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return bytes.join('.');
}

function getRemoteAddress(koaCtx: KoaContextLike): string | null {
  const forwarded = koaCtx.headers?.['x-forwarded-for'] ?? koaCtx.request?.headers?.['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const raw =
    forwardedValue?.split(',')[0]?.trim() ??
    koaCtx.request?.ip ??
    koaCtx.req?.socket?.remoteAddress ??
    null;

  if (!raw) return null;
  if (raw.startsWith('::ffff:')) return normalizeIpv4(raw.slice('::ffff:'.length));
  return raw;
}

function isAllowedRemoteAddress(rawAddress: string | null): boolean {
  if (!rawAddress) return false;
  if (rawAddress === '::1' || rawAddress === 'localhost') return true;
  if (rawAddress.startsWith('fc') || rawAddress.startsWith('fd')) return true;
  const ipv4 = normalizeIpv4(rawAddress);
  if (!ipv4) return false;
  const [a, b] = ipv4.split('.').map(Number);
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 100) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
  });
}

function serializeLangChainMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;
  const typed = message as {
    content?: unknown;
    name?: string;
    additional_kwargs?: Record<string, unknown>;
    tool_calls?: unknown;
    tool_call_id?: string;
    getType?: () => string;
  };
  return {
    type: typeof typed.getType === 'function' ? typed.getType() : undefined,
    name: typeof typed.name === 'string' ? typed.name : undefined,
    content: extractTextContent(typed.content),
    toolCalls: Array.isArray(typed.tool_calls) ? typed.tool_calls : undefined,
    toolCallId: typed.tool_call_id,
    additionalKwargs: typed.additional_kwargs,
  };
}

function tryParsePayloadText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatInjectionSourceLabel(source: string): string {
  return INJECTION_SOURCE_LABELS[source] ?? source;
}

function toInjectedPromptRecord(event: TraceEventRecord): TraceInjectedPromptRecord | null {
  if (event.kind === 'chatluna-time-context') {
    const payload = tryParsePayloadText(event.payload);
    if (!payload || typeof payload !== 'object') return null;
    const content = extractTextContent((payload as { injectedContent?: unknown }).injectedContent);
    if (!content) return null;
    return {
      source: 'chatluna-time-context',
      sourceLabel: formatInjectionSourceLabel('chatluna-time-context'),
      stage: 'input-message',
      content,
      createdAt: event.createdAt,
    };
  }

  if (event.kind !== 'context-injection') return null;
  const payload = tryParsePayloadText(event.payload);
  if (!payload || typeof payload !== 'object') return null;
  const typed = payload as {
    content?: unknown;
    source?: unknown;
    stage?: unknown;
  };
  const source = typeof typed.source === 'string' ? typed.source.trim() : '';
  const content = extractTextContent(typed.content);
  if (!source || !content) return null;
  const stage = typeof typed.stage === 'string' && typed.stage.trim() ? typed.stage.trim() : 'unknown';
  return {
    source,
    sourceLabel: formatInjectionSourceLabel(source),
    stage,
    content,
    createdAt: event.createdAt,
  };
}

export function extractInjectedPrompts(events: TraceEventRecord[]): TraceInjectedPromptRecord[] {
  return events.map((event) => toInjectedPromptRecord(event)).filter((event): event is TraceInjectedPromptRecord => Boolean(event));
}

export function buildTraceEventsResponse(events: TraceEventRecord[]): {
  events: Array<TraceEventRecord & { createdAtText: string }>;
  injectedPrompts: TraceInjectedPromptView[];
} {
  return {
    events: events.map((event) => ({
      ...event,
      createdAtText: formatTime(event.createdAt),
    })),
    injectedPrompts: extractInjectedPrompts(events).map((prompt) => ({
      ...prompt,
      createdAtText: formatTime(prompt.createdAt),
    })),
  };
}

function createTraceViewerHtml(uiPath: string, apiPath: string, pollIntervalMs: number): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Trace Viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f1ea;
      --panel: #fffdf8;
      --line: #d6c9b6;
      --text: #231f18;
      --muted: #756a59;
      --accent: #9d5f2f;
      --accent-soft: rgba(157, 95, 47, 0.12);
      --danger: #9b2c2c;
      font-family: "Iosevka", "SFMono-Regular", "Cascadia Mono", monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(157,95,47,0.12), transparent 30%),
        linear-gradient(180deg, #f7f3eb 0%, var(--bg) 100%);
      color: var(--text);
    }
    .shell {
      display: grid;
      grid-template-columns: 360px 1fr;
      min-height: 100vh;
    }
    aside, main { padding: 18px; }
    aside {
      border-right: 1px solid var(--line);
      background: rgba(255, 253, 248, 0.92);
      backdrop-filter: blur(12px);
    }
    main { overflow: auto; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 20px; letter-spacing: 0.04em; text-transform: uppercase; }
    .muted { color: var(--muted); }
    .toolbar {
      display: grid;
      gap: 10px;
      margin-top: 16px;
    }
    input, select, button {
      width: 100%;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      padding: 10px 12px;
      font: inherit;
    }
    button {
      cursor: pointer;
      background: var(--accent);
      color: #fff8ef;
      border-color: var(--accent);
    }
    .list {
      margin-top: 16px;
      display: grid;
      gap: 10px;
    }
    .item {
      border: 1px solid var(--line);
      background: var(--panel);
      padding: 12px;
      cursor: pointer;
    }
    .item.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-soft); }
    .item .route {
      display: inline-flex;
      padding: 2px 8px;
      font-size: 12px;
      background: var(--accent-soft);
      color: var(--accent);
      margin-bottom: 8px;
    }
    .item .status { float: right; color: var(--muted); font-size: 12px; }
    .header-card, .detail-card {
      border: 1px solid var(--line);
      background: rgba(255, 253, 248, 0.94);
      padding: 16px;
      margin-bottom: 14px;
    }
    .header-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      margin-top: 14px;
    }
    .kv {
      border: 1px solid var(--line);
      padding: 10px;
      background: #fffaf2;
    }
    .prompt-list {
      display: grid;
      gap: 12px;
      margin-top: 12px;
    }
    .prompt-card {
      border: 1px solid var(--line);
      background: #fffaf2;
      padding: 14px;
    }
    .prompt-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .prompt-source {
      display: inline-flex;
      padding: 2px 8px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: var(--accent-soft);
      color: var(--accent);
    }
    .prompt-stage {
      color: var(--muted);
      font-size: 12px;
    }
    .timeline {
      display: grid;
      gap: 12px;
    }
    .event {
      border: 1px solid var(--line);
      background: var(--panel);
      padding: 14px;
    }
    .event-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 10px;
    }
    .event-phase {
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-size: 12px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: inherit;
      line-height: 1.45;
    }
    .empty {
      border: 1px dashed var(--line);
      padding: 18px;
      color: var(--muted);
      background: rgba(255,253,248,0.7);
    }
    @media (max-width: 900px) {
      .shell { grid-template-columns: 1fr; }
      aside { border-right: none; border-bottom: 1px solid var(--line); }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>Trace Viewer</h1>
      <p class="muted">Path: ${uiPath}</p>
      <div class="toolbar">
        <input id="query" placeholder="search route, input, reply" />
        <select id="limit">
          <option value="20">20 traces</option>
          <option value="50" selected>50 traces</option>
          <option value="100">100 traces</option>
        </select>
        <button id="refresh">Refresh</button>
      </div>
      <div id="list" class="list"></div>
    </aside>
    <main>
      <div class="header-card">
        <h2 id="title">No trace selected</h2>
        <p class="muted">Polling every ${pollIntervalMs} ms.</p>
      </div>
      <div id="detail"></div>
    </main>
  </div>
  <script>
    const apiBase = ${JSON.stringify(apiPath)};
    const pollIntervalMs = ${JSON.stringify(pollIntervalMs)};
    const state = { selectedTraceId: null, timer: null };

    function escapeHtml(input) {
      return String(input ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    function formatPayload(text) {
      if (!text) return '(empty)';
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return text;
      }
    }

    async function loadList() {
      const query = document.getElementById('query').value.trim();
      const limit = document.getElementById('limit').value;
      const url = new URL(apiBase + '/traces', window.location.origin);
      url.searchParams.set('limit', limit);
      if (query) url.searchParams.set('q', query);
      const response = await fetch(url);
      const payload = await response.json();
      const list = document.getElementById('list');
      list.innerHTML = '';
      const items = payload.traces || [];
      if (!items.length) {
        list.innerHTML = '<div class="empty">No traces yet.</div>';
        if (!state.selectedTraceId) {
          document.getElementById('detail').innerHTML = '';
          document.getElementById('title').textContent = 'No trace selected';
        }
        return;
      }
      for (const item of items) {
        const div = document.createElement('div');
        div.className = 'item' + (state.selectedTraceId === item.traceId ? ' active' : '');
        div.dataset.traceId = item.traceId;
        div.innerHTML =
          '<div><span class="route">' + escapeHtml(item.route) + '</span><span class="status">' + escapeHtml(item.status) + '</span></div>' +
          '<div>' + escapeHtml(item.inputPreview || '(no input preview)') + '</div>' +
          '<div class="muted" style="margin-top:8px;">' + escapeHtml(item.updatedAtText) + '</div>';
        div.addEventListener('click', () => {
          state.selectedTraceId = item.traceId;
          loadList().catch(showError);
          loadDetail(item.traceId).catch(showError);
        });
        list.appendChild(div);
      }
      if (!state.selectedTraceId) {
        state.selectedTraceId = items[0].traceId;
        await loadDetail(state.selectedTraceId);
      }
    }

    async function loadDetail(traceId) {
      const [traceRes, eventsRes] = await Promise.all([
        fetch(apiBase + '/traces/' + encodeURIComponent(traceId)),
        fetch(apiBase + '/traces/' + encodeURIComponent(traceId) + '/events'),
      ]);
      if (!traceRes.ok) throw new Error('failed to load trace detail');
      if (!eventsRes.ok) throw new Error('failed to load trace events');
      const tracePayload = await traceRes.json();
      const eventsPayload = await eventsRes.json();
      const trace = tracePayload.trace;
      const events = eventsPayload.events || [];
      const injectedPrompts = eventsPayload.injectedPrompts || [];
      document.getElementById('title').textContent = trace.traceId;
      const detail = document.getElementById('detail');
      const metaCards = [
        ['route', trace.route],
        ['status', trace.status],
        ['model', trace.model || '-'],
        ['platform', trace.platform || '-'],
        ['channel', trace.channelId || '-'],
        ['conversation', trace.conversationId || '-'],
        ['request', trace.requestId || '-'],
        ['tools', trace.hasToolCall ? 'yes' : 'no'],
      ]
        .map(([key, value]) => '<div class="kv"><div class="muted">' + escapeHtml(key) + '</div><div>' + escapeHtml(value) + '</div></div>')
        .join('');
      const timeline = events.length
        ? events
            .map((event) => {
              return (
                '<div class="event">' +
                '<div class="event-head">' +
                '<div><div class="event-phase">' + escapeHtml(event.phase) + '</div><div>' + escapeHtml(event.kind) + '</div></div>' +
                '<div class="muted">' + escapeHtml(event.createdAtText) + (event.truncated ? ' · truncated' : '') + '</div>' +
                '</div>' +
                '<pre>' + escapeHtml(formatPayload(event.payload)) + '</pre>' +
                '</div>'
              );
            })
            .join('')
        : '<div class="empty">No events stored for this trace.</div>';
      const injectedPromptCards = injectedPrompts.length
        ? injectedPrompts
            .map((prompt) => {
              return (
                '<div class="prompt-card">' +
                '<div class="prompt-meta">' +
                '<div><span class="prompt-source">' + escapeHtml(prompt.sourceLabel || prompt.source) + '</span></div>' +
                '<div class="prompt-stage">' +
                escapeHtml(prompt.stage || '-') +
                ' · ' +
                escapeHtml(prompt.createdAtText || '') +
                '</div>' +
                '</div>' +
                '<pre>' + escapeHtml(prompt.content || '(empty)') + '</pre>' +
                '</div>'
              );
            })
            .join('')
        : '<div class="empty">No injected prompts captured for this trace.</div>';
      detail.innerHTML =
        '<div class="detail-card"><div class="header-grid">' + metaCards + '</div></div>' +
        '<div class="detail-card"><h3>Input preview</h3><pre style="margin-top:10px;">' + escapeHtml(trace.inputPreview || '(empty)') + '</pre></div>' +
        '<div class="detail-card"><h3>Final reply preview</h3><pre style="margin-top:10px;">' + escapeHtml(trace.finalReplyPreview || '(empty)') + '</pre></div>' +
        '<div class="detail-card"><h3>Injected prompts</h3><div class="prompt-list">' + injectedPromptCards + '</div></div>' +
        (trace.errorText ? '<div class="detail-card"><h3>Error</h3><pre style="margin-top:10px;">' + escapeHtml(trace.errorText) + '</pre></div>' : '') +
        '<div class="timeline">' + timeline + '</div>';
    }

    function showError(error) {
      document.getElementById('detail').innerHTML =
        '<div class="empty" style="color:#9b2c2c;">' + escapeHtml(error && error.message ? error.message : String(error)) + '</div>';
    }

    async function refresh() {
      await loadList();
      if (state.selectedTraceId) {
        await loadDetail(state.selectedTraceId);
      }
    }

    document.getElementById('refresh').addEventListener('click', () => refresh().catch(showError));
    document.getElementById('query').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') refresh().catch(showError);
    });
    document.getElementById('limit').addEventListener('change', () => refresh().catch(showError));

    refresh().catch(showError);
    state.timer = setInterval(() => refresh().catch(showError), pollIntervalMs);
  </script>
</body>
</html>`;
}

class TraceViewerService implements TraceViewerServiceLike {
  private readonly als = new AsyncLocalStorage<string>();
  private readonly drafts = new Map<string, TraceDraft>();
  private readonly dirtyTraceIds = new Set<string>();
  private readonly pendingEvents: Omit<TraceEventRecord, 'id'>[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private flushAgain = false;
  private disposed = false;
  private lastPruneAt = 0;

  constructor(
    private readonly ctx: Context,
    private readonly runtime: RuntimeConfig,
  ) {}

  ensureTrace(options: TraceStartOptions): string {
    const existingTraceId = this.getTraceId(options.session as SessionLike | null | undefined);
    if (existingTraceId) return existingTraceId;

    const now = Date.now();
    const traceId = randomUUID();
    const inputPreview = trimText(options.input ?? null, SESSION_PREVIEW_LIMIT);
    const draft: TraceDraft = {
      id: 0,
      traceId,
      route: options.route,
      status: 'running',
      platform: options.session?.platform ?? null,
      channelId: options.session?.channelId ?? null,
      guildId: options.session?.guildId ?? null,
      userId: options.session?.userId ?? null,
      conversationId: null,
      requestId: null,
      model: null,
      inputPreview,
      finalReplyPreview: null,
      errorText: null,
      hasToolCall: 0,
      createdAt: now,
      updatedAt: now,
      nextSeq: 0,
    };
    this.drafts.set(traceId, draft);
    this.dirtyTraceIds.add(traceId);
    this.bindTrace(options.session as SessionLike | null | undefined, traceId);
    this.scheduleFlush();

    if (inputPreview) {
      this.record({
        traceId,
        phase: 'inbound',
        kind: 'user-input',
        payload: {
          content: options.input,
        },
      });
    }

    return traceId;
  }

  bindTrace(session: { state?: Record<string, unknown> | undefined } | null | undefined, traceId: string): void {
    if (!session) return;
    ensureSessionState(session)[TRACE_ID_STATE_KEY] = traceId;
  }

  getTraceId(session?: { state?: Record<string, unknown> | undefined } | null): string | null {
    const stateValue = session?.state?.[TRACE_ID_STATE_KEY];
    return typeof stateValue === 'string' && stateValue.length > 0 ? stateValue : null;
  }

  getCurrentTraceId(): string | null {
    return this.als.getStore() ?? null;
  }

  async runWithTrace<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
    return this.als.run(traceId, fn);
  }

  record(options: TraceRecordOptions): void {
    const traceId = options.traceId ?? this.getCurrentTraceId();
    if (!traceId) return;
    const draft = this.drafts.get(traceId);
    if (!draft) return;
    const serialized = serializePayload(options.payload, this.runtime.maxEventPayloadBytes, this.runtime.redactSecrets);
    draft.nextSeq += 1;
    draft.updatedAt = Date.now();
    this.dirtyTraceIds.add(traceId);
    this.pendingEvents.push({
      traceId,
      seq: draft.nextSeq,
      phase: options.phase,
      kind: options.kind,
      payload: serialized.text,
      truncated: serialized.truncated,
      createdAt: draft.updatedAt,
    });
    this.scheduleFlush();
  }

  update(traceId: string, patch: Partial<TraceSessionRecord>): void {
    const draft = this.drafts.get(traceId);
    if (!draft) return;
    Object.assign(draft, patch);
    draft.updatedAt = Date.now();
    this.dirtyTraceIds.add(traceId);
    this.scheduleFlush();
  }

  finish(options: TraceFinishOptions): void {
    const traceId = options.traceId ?? this.getCurrentTraceId();
    if (!traceId) return;
    const draft = this.drafts.get(traceId);
    if (!draft) return;

    if (options.status) draft.status = options.status;
    if (options.requestId !== undefined) draft.requestId = options.requestId;
    if (options.conversationId !== undefined) draft.conversationId = options.conversationId;
    if (options.model !== undefined) draft.model = options.model;
    if (options.error !== undefined) draft.errorText = trimText(options.error, STRING_PREVIEW_LIMIT);
    if (options.finalReply !== undefined) {
      draft.finalReplyPreview = trimText(extractTextContent(options.finalReply) ?? options.finalReply ?? null, STRING_PREVIEW_LIMIT);
    }
    if (options.hasToolCall) draft.hasToolCall = 1;
    draft.updatedAt = Date.now();
    this.dirtyTraceIds.add(traceId);
    this.scheduleFlush();
  }

  async flush(force = false): Promise<void> {
    if (this.disposed && !force) return;
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }

    if (!force && !this.dirtyTraceIds.size && !this.pendingEvents.length) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const sessionRows = Array.from(this.dirtyTraceIds)
      .map((traceId) => this.drafts.get(traceId))
      .filter((draft): draft is TraceDraft => Boolean(draft))
      .map((draft) => ({
        traceId: draft.traceId,
        route: draft.route,
        status: draft.status,
        platform: draft.platform,
        channelId: draft.channelId,
        guildId: draft.guildId,
        userId: draft.userId,
        conversationId: draft.conversationId,
        requestId: draft.requestId,
        model: draft.model,
        inputPreview: draft.inputPreview,
        finalReplyPreview: draft.finalReplyPreview,
        errorText: draft.errorText,
        hasToolCall: draft.hasToolCall,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
      }));
    const events = this.pendingEvents.splice(0, this.pendingEvents.length);
    this.dirtyTraceIds.clear();
    this.flushing = true;

    try {
      await this.ctx.database.withTransaction(async (database) => {
        if (sessionRows.length) {
          await database.upsert('trace_session', sessionRows, ['traceId']);
        }
        for (const event of events) {
          await database.create('trace_event', event);
        }
      });
      if (sessionRows.length) {
        await this.prune();
      }
    } catch (error) {
      for (const row of sessionRows) this.dirtyTraceIds.add(row.traceId);
      this.pendingEvents.unshift(...events);
      logger.warn('trace flush failed: %s', (error as Error).message);
    } finally {
      this.flushing = false;
      if (this.flushAgain || this.dirtyTraceIds.size || this.pendingEvents.length) {
        this.flushAgain = false;
        this.scheduleFlush(true);
      }
    }
  }

  scheduleFlush(immediate = false): void {
    if (this.disposed) return;
    if (immediate || this.pendingEvents.length >= FLUSH_BATCH_SIZE || this.dirtyTraceIds.size >= FLUSH_BATCH_SIZE) {
      void this.flush(true);
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  async prune(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;

    const allSessions = await this.ctx.database.get('trace_session', {} as Record<string, never>);
    const cutoff = now - this.runtime.retentionDays * 24 * 60 * 60 * 1000;
    const sorted = [...allSessions].sort((left, right) => right.updatedAt - left.updatedAt);
    const keepIds = new Set(sorted.slice(0, this.runtime.maxSessions).map((item) => item.traceId));
    const expired = sorted.filter((item) => item.updatedAt < cutoff || !keepIds.has(item.traceId));
    if (!expired.length) return;

    await this.ctx.database.withTransaction(async (database) => {
      for (const row of expired) {
        await database.remove('trace_event', { traceId: row.traceId });
        await database.remove('trace_session', { traceId: row.traceId });
      }
    });

    for (const row of expired) {
      this.drafts.delete(row.traceId);
      this.dirtyTraceIds.delete(row.traceId);
    }
  }

  async listTraces(limit: number, query: string): Promise<TraceSessionRecord[]> {
    const allSessions = await this.ctx.database.get('trace_session', {} as Record<string, never>);
    const keyword = query.trim().toLowerCase();
    const filtered = keyword
      ? allSessions.filter((item) => {
          const haystack = [item.route, item.inputPreview, item.finalReplyPreview, item.model, item.status]
            .filter(Boolean)
            .join('\n')
            .toLowerCase();
          return haystack.includes(keyword);
        })
      : allSessions;

    return filtered.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
  }

  async getTrace(traceId: string): Promise<TraceSessionRecord | null> {
    const [trace] = await this.ctx.database.get('trace_session', { traceId });
    return trace ?? null;
  }

  async getEvents(traceId: string): Promise<TraceEventRecord[]> {
    const events = await this.ctx.database.get('trace_event', { traceId });
    return events.sort((left, right) => left.seq - right.seq);
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush(true);
    this.disposed = true;
  }
}

function ensureTraceTables(ctx: Context): void {
  ctx.model.extend(
    'trace_session',
    {
      id: 'unsigned',
      traceId: 'string',
      route: 'string',
      status: 'string',
      platform: { type: 'string', nullable: true },
      channelId: { type: 'string', nullable: true },
      guildId: { type: 'string', nullable: true },
      userId: { type: 'string', nullable: true },
      conversationId: { type: 'string', nullable: true },
      requestId: { type: 'string', nullable: true },
      model: { type: 'string', nullable: true },
      inputPreview: { type: 'text', nullable: true },
      finalReplyPreview: { type: 'text', nullable: true },
      errorText: { type: 'text', nullable: true },
      hasToolCall: 'unsigned',
      createdAt: 'double',
      updatedAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['traceId'], ['updatedAt'], ['route', 'updatedAt']],
    },
  );

  ctx.model.extend(
    'trace_event',
    {
      id: 'unsigned',
      traceId: 'string',
      seq: 'unsigned',
      phase: 'string',
      kind: 'string',
      payload: 'text',
      truncated: 'unsigned',
      createdAt: 'double',
    },
    {
      autoInc: true,
      indexes: [['traceId', 'seq'], ['createdAt']],
    },
  );
}

function addNoStoreHeader(koaCtx: KoaContextLike): void {
  koaCtx.set?.('Cache-Control', 'no-store');
}

function denyIfUnauthorized(koaCtx: KoaContextLike): boolean {
  const remoteAddress = getRemoteAddress(koaCtx);
  if (isAllowedRemoteAddress(remoteAddress)) return false;
  koaCtx.status = 403;
  koaCtx.body = { error: 'trace viewer is limited to local or private network access' };
  return true;
}

function patchChatLuna(service: TraceViewerService, ctx: Context): void {
  const chatluna = (typeof (ctx as { get?: (name: string) => unknown }).get === 'function'
    ? ((ctx as { get: (name: string) => unknown }).get('chatluna') as ChatLunaLike | undefined)
    : undefined) ?? ((ctx as Context & { chatluna?: ChatLunaLike }).chatluna as ChatLunaLike | undefined);

  if (!chatluna) return;

  if (chatluna.contextManager?.inject && !chatluna.contextManager[CONTEXT_MANAGER_PATCH]) {
    const originalInject = chatluna.contextManager.inject.bind(chatluna.contextManager);
    const wrappedInject = (options: ContextManagerInjectOptions) => {
      const traceId = service.getCurrentTraceId();
      if (traceId) {
        service.record({
          traceId,
          phase: 'prepare',
          kind: 'context-injection',
          payload: {
            content: extractTextContent(options?.value),
            conversationId: options?.conversationId ?? null,
            once: Boolean(options?.once),
            source: options?.name ?? 'unknown',
            stage: options?.stage ?? null,
          },
        });
      }
      return originalInject(options);
    };
    (wrappedInject as unknown as Record<symbol, unknown>)[CONTEXT_MANAGER_PATCH] = true;
    chatluna.contextManager.inject = wrappedInject;
    chatluna.contextManager[CONTEXT_MANAGER_PATCH] = true;
  }

  if (chatluna.chat && !((chatluna.chat as unknown as Record<symbol, unknown>)[CHAT_SERVICE_PATCH])) {
    const originalChat = chatluna.chat.bind(chatluna);
    const wrappedChat = async (
      session: SessionLike,
      room: Record<string, any>,
      message: Record<string, any>,
      events: Record<string, (...args: any[]) => unknown>,
      stream: boolean,
      requestId: string,
      variables?: Record<string, unknown>,
      postHandler?: Record<string, unknown>,
    ) => {
      const inputText = extractTextContent(message?.content);
      const traceId =
        service.getTraceId(session) ??
        service.ensureTrace({
          session,
          route: session?.isDirect ? 'chatluna-direct' : 'chatluna-chat',
          input: inputText,
        });

      service.bindTrace(session, traceId);
      service.update(traceId, {
        conversationId: room?.conversationId ?? null,
        requestId: requestId ?? null,
        model: room?.model ?? null,
      });
      service.record({
        traceId,
        phase: 'prepare',
        kind: 'chatluna-request',
        payload: {
          room: {
            conversationId: room?.conversationId ?? null,
            roomId: room?.roomId ?? null,
            model: room?.model ?? null,
            chatMode: room?.chatMode ?? null,
            preset: room?.preset ?? null,
          },
          message: serializeLangChainMessage(message),
          variables,
          stream,
          hasPostHandler: Boolean(postHandler),
        },
      });

      const wrappedEvents = {
        ...events,
        'llm-queue-waiting': async (...args: any[]) => {
          service.record({
            traceId,
            phase: 'prepare',
            kind: 'queue-waiting',
            payload: { args },
          });
          return events?.['llm-queue-waiting']?.(...args);
        },
        'llm-call-tool': async (...args: any[]) => {
          service.record({
            traceId,
            phase: 'tool-loop',
            kind: 'tool-call',
            payload: { args },
          });
          service.finish({ traceId, hasToolCall: true });
          return events?.['llm-call-tool']?.(...args);
        },
        'llm-used-token-count': async (...args: any[]) => {
          service.record({
            traceId,
            phase: 'llm-output',
            kind: 'token-usage',
            payload: { args },
          });
          return events?.['llm-used-token-count']?.(...args);
        },
      };

      return service.runWithTrace(traceId, async () => {
        try {
          const result = await originalChat(session, room, message, wrappedEvents, stream, requestId, variables, postHandler);
          service.record({
            traceId,
            phase: 'llm-output',
            kind: 'chatluna-result',
            payload: {
              content: extractTextContent(result?.content),
              additionalReplyMessages: result?.additionalReplyMessages,
            },
          });
          service.finish({
            traceId,
            status: 'ok',
            finalReply: extractTextContent(result?.content),
            conversationId: room?.conversationId ?? null,
            requestId: requestId ?? null,
            model: room?.model ?? null,
          });
          return result;
        } catch (error) {
          const messageText = (error as Error).message;
          service.record({
            traceId,
            phase: 'error',
            kind: 'chatluna-error',
            payload: { message: messageText },
          });
          service.finish({
            traceId,
            status: 'error',
            error: messageText,
            conversationId: room?.conversationId ?? null,
            requestId: requestId ?? null,
            model: room?.model ?? null,
          });
          throw error;
        }
      });
    };

    (wrappedChat as unknown as Record<symbol, unknown>)[CHAT_SERVICE_PATCH] = true;
    chatluna.chat = wrappedChat;
  }

  try {
    const chainModule = require('koishi-plugin-chatluna/llm-core/chain/base') as {
      ChatLunaLLMChain?: { prototype?: LlmChainPrototypeLike };
    };
    const chainPrototype = chainModule.ChatLunaLLMChain?.prototype as LlmChainPrototypeLike | undefined;
    if (chainPrototype && !chainPrototype[CHAIN_CALL_PATCH]) {
      const originalCall = chainPrototype._call as (values: Record<string, unknown>, runManager?: any) => Promise<any>;
      chainPrototype._call = async function _call(this: LlmChainLike, values: Record<string, unknown>, runManager?: any) {
        const traceId = service.getCurrentTraceId();
        if (!traceId) return originalCall.call(this, values, runManager);

        const valuesForPrompt = { ...values };
        const valuesForLlm = { ...(this.llmKwargs ?? {}) };
        for (const key of this.llm.callKeys ?? []) {
          if (key in values) {
            valuesForLlm[key] = values[key];
            delete valuesForPrompt[key];
          }
        }

        const promptValue = await this.prompt.formatPromptValue(valuesForPrompt);
        const messages =
          typeof promptValue?.toChatMessages === 'function'
            ? await promptValue.toChatMessages()
            : typeof promptValue?.toString === 'function'
              ? String(promptValue)
              : promptValue;
        service.record({
          traceId,
          phase: 'llm-input',
          kind: 'compiled-prompt',
          payload: {
            messages: Array.isArray(messages) ? messages.map((message) => serializeLangChainMessage(message)) : messages,
            llmOptions: valuesForLlm,
          },
        });

        const { generations } = await this.llm.generatePrompt([promptValue], valuesForLlm, runManager?.getChild?.());
        const generation = generations?.[0]?.[0];
        service.record({
          traceId,
          phase: 'llm-output',
          kind: 'raw-generation',
          payload: {
            text: generation?.text,
            message: serializeLangChainMessage(generation?.message),
            generationInfo: generation?.generationInfo,
          },
        });

        return {
          [this.outputKey ?? 'text']: generation?.text,
          rawGeneration: generation,
          message: generation?.message,
          extra: generation?.generationInfo,
        };
      };
      chainPrototype[CHAIN_CALL_PATCH] = true;
    }
  } catch (error) {
    logger.warn('failed to patch chatluna chain call: %s', (error as Error).message);
  }

  try {
    const appModule = require('koishi-plugin-chatluna/llm-core/chat/app') as {
      ChatInterface?: { prototype?: { processChat?: (arg: Record<string, unknown>, wrapper: WrapperLike) => Promise<any> } & Record<symbol, unknown> };
    };
    const appPrototype = appModule.ChatInterface?.prototype as
      | ({ processChat?: (arg: Record<string, unknown>, wrapper: WrapperLike) => Promise<any> } & Record<symbol, unknown>)
      | undefined;
    if (appPrototype?.processChat && !appPrototype[PROCESS_CHAT_PATCH]) {
      const originalProcessChat = appPrototype.processChat;
      appPrototype.processChat = async function processChat(arg: Record<string, unknown>, wrapper: WrapperLike) {
        const traceId = service.getCurrentTraceId();
        if (!traceId) return originalProcessChat.call(this, arg, wrapper);

        const wrappedWrapper: WrapperLike = {
          ...wrapper,
          call: async (callArg: Record<string, unknown>) => {
            const response = await wrapper.call(callArg);
            const steps = Array.isArray(response?.parallelIntermediateSteps) ? response.parallelIntermediateSteps : [];
            if (steps.length) {
              service.record({
                traceId,
                phase: 'tool-loop',
                kind: 'parallel-intermediate-steps',
                payload: steps,
              });
              service.finish({ traceId, hasToolCall: true });
            }
            if (response?.message) {
              service.record({
                traceId,
                phase: 'llm-output',
                kind: 'wrapper-response-message',
                payload: serializeLangChainMessage(response.message),
              });
            }
            return response;
          },
        };

        return originalProcessChat.call(this, arg, wrappedWrapper);
      };
      appPrototype[PROCESS_CHAT_PATCH] = true;
    }
  } catch (error) {
    logger.warn('failed to patch chatluna processChat: %s', (error as Error).message);
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const runtime = toRuntimeConfig(config);
  if (!runtime.enabled) return;

  ensureTraceTables(ctx);

  const service = new TraceViewerService(ctx, runtime);
  ctx.provide('traceViewer');
  ctx.set('traceViewer', service);

  ctx.on('dispose', () => {
    void service.dispose();
  });

  ctx.on('ready', () => {
    void service.prune(true).catch((error) => {
      logger.warn('initial trace prune failed: %s', (error as Error).message);
    });
    patchChatLuna(service, ctx);
  });

  ctx.on('before-send', (rawSession, options) => {
    const session = rawSession as SessionLike;
    const traceId = service.getTraceId(session);
    if (!traceId) return;
    const content = extractTextContent((options as { content?: unknown })?.content);
    if (!content) return;
    service.record({
      traceId,
      phase: 'outbound',
      kind: 'before-send',
      payload: {
        content,
        channelId: session.channelId ?? null,
        guildId: session.guildId ?? null,
      },
    });
    service.finish({
      traceId,
      finalReply: content,
    });
  });

  const html = createTraceViewerHtml(runtime.uiPath, runtime.apiPath, runtime.pollIntervalMs);

  ctx.server.get(runtime.uiPath, async (koaCtx: KoaContextLike) => {
    if (denyIfUnauthorized(koaCtx)) return;
    addNoStoreHeader(koaCtx);
    koaCtx.type = 'text/html; charset=utf-8';
    koaCtx.body = html;
  });

  ctx.server.get(`${runtime.apiPath}/traces`, async (koaCtx: KoaContextLike) => {
    if (denyIfUnauthorized(koaCtx)) return;
    addNoStoreHeader(koaCtx);
    const limit = clampNatural(koaCtx.query?.limit, 50);
    const query = typeof koaCtx.query?.q === 'string' ? koaCtx.query.q : '';
    const traces = await service.listTraces(Math.min(limit, 100), query);
    koaCtx.body = {
      traces: traces.map((trace) => ({
        ...trace,
        updatedAtText: formatTime(trace.updatedAt),
      })),
    };
  });

  ctx.server.get(`${runtime.apiPath}/traces/:traceId`, async (koaCtx: KoaContextLike) => {
    if (denyIfUnauthorized(koaCtx)) return;
    addNoStoreHeader(koaCtx);
    const traceId = koaCtx.params?.traceId ?? '';
    const trace = await service.getTrace(traceId);
    if (!trace) {
      koaCtx.status = 404;
      koaCtx.body = { error: 'trace not found' };
      return;
    }
    koaCtx.body = {
      trace,
    };
  });

  ctx.server.get(`${runtime.apiPath}/traces/:traceId/events`, async (koaCtx: KoaContextLike) => {
    if (denyIfUnauthorized(koaCtx)) return;
    addNoStoreHeader(koaCtx);
    const traceId = koaCtx.params?.traceId ?? '';
    const events = await service.getEvents(traceId);
    koaCtx.body = buildTraceEventsResponse(events);
  });

  logger.info(
    'trace viewer enabled at %s (api=%s, maxSessions=%d, retentionDays=%d, payloadBytes=%d)',
    runtime.uiPath,
    runtime.apiPath,
    runtime.maxSessions,
    runtime.retentionDays,
    runtime.maxEventPayloadBytes,
  );
}

export { isAllowedRemoteAddress, serializePayload, trimText };
