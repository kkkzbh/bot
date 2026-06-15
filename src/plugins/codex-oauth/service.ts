import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type {
  BotConsoleAuthStatus,
  CodexAuthAttempt,
  CodexAuthState,
} from '../../types/bot-console.js';

const execFile = promisify(execFileCallback);

const DEFAULT_KOISHI_PORT = '5140';
const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_CODEX_AUTH_BASE_URL = 'https://auth.openai.com';
const DEFAULT_CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const CODEX_BRIDGE_PATH = '/api/internal/codex/v1';
const CODEX_DEVICE_POLL_INTERVAL_SEC = 5;
const CODEX_DEVICE_EXPIRES_IN_SEC = 15 * 60;

type ResolvedEnvFiles = {
  mode: 'single' | 'layered';
  baseFilePath: string | null;
  overrideFilePath: string | null;
  editTarget: string;
};

type ExecResult = {
  stdout: string;
  stderr: string;
};

type CodexBridgeRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
};

type CodexAuthTokens = {
  access_token?: string | null;
  refresh_token?: string | null;
  id_token?: string | null;
  account_id?: string | null;
};

type CodexAuthRecord = {
  auth_mode?: string | null;
  tokens?: CodexAuthTokens | null;
  last_refresh?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
};

type CodexTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  account_id?: string;
};

type CodexDeviceCodeResponse = {
  device_code?: string;
  deviceCode?: string;
  device_auth_id?: string;
  deviceAuthId?: string;
  user_code?: string;
  userCode?: string;
  usercode?: string;
  verification_uri?: string;
  verification_url?: string;
  verificationUri?: string;
  expires_in?: number;
  interval?: number;
};

type CodexDeviceTokenResponse = CodexTokenResponse & {
  error?: string;
  error_description?: string;
  code?: string;
  authorization_code?: string;
  auth_code?: string;
  code_challenge?: string;
  code_verifier?: string;
};

type CodexModelCatalogEntry = {
  slug?: unknown;
  id?: unknown;
  display_name?: unknown;
  name?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
};

type StoredCodexAuthAttempt = CodexAuthAttempt & {
  deviceCode: string;
  codeVerifier: string;
  clientId: string;
};

export interface CodexModelOption {
  modelId: string;
  label: string;
}

export type CodexConsoleStatus = Pick<
  CodexAuthState,
  'authKind' | 'authStatus' | 'accountLabel' | 'authError' | 'tokenExpiresAt' | 'attempt'
>;

export interface CodexBridgeStateProvider {
  getRuntimeConfig(): Promise<CodexBridgeRuntimeConfig>;
  getConsoleStatus(options?: { probe?: boolean }): Promise<CodexConsoleStatus>;
  startLogin?: () => Promise<CodexConsoleStatus>;
  pollLogin?: (attemptId: string) => Promise<CodexConsoleStatus>;
  cancelLogin?: (attemptId: string) => Promise<CodexConsoleStatus>;
  logout?: () => Promise<CodexConsoleStatus>;
  proxyModels?: () => Promise<{ status: number; headers: Record<string, string>; body: string }>;
  proxyResponses?: (body: unknown) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

const STATIC_CODEX_MODEL_OPTIONS: readonly CodexModelOption[] = [
  { modelId: 'gpt-5.5', label: 'GPT-5.5' },
  { modelId: 'gpt-5.4', label: 'GPT-5.4' },
  { modelId: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
];

function trimOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function buildJsonError(message: string) {
  return {
    error: {
      message,
      type: 'invalid_request_error',
    },
  };
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  const raw = await readTextIfExists(filePath);
  if (!raw) return null;
  return parseJson<T>(raw, filePath);
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function resolveCodexCatalogHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHome(trimOptionalText(env.CODEX_HOME) ?? join(homedir(), '.codex')));
}

export function resolveCodexStateDir(rootDir: string, envFiles: ResolvedEnvFiles): string {
  if (envFiles.mode === 'layered') {
    return dirname(envFiles.editTarget);
  }
  return join(rootDir, '.runtime');
}

export function buildCodexBridgeBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = trimOptionalText(env.KOISHI_PORT) || DEFAULT_KOISHI_PORT;
  return `http://127.0.0.1:${port}${CODEX_BRIDGE_PATH}`;
}

function codexAuthBaseUrl(): string {
  return (trimOptionalText(process.env.CODEX_OAUTH_BASE_URL) ?? DEFAULT_CODEX_AUTH_BASE_URL).replace(/\/+$/, '');
}

function codexTokenUrl(): string {
  return `${codexAuthBaseUrl()}/oauth/token`;
}

function codexDeviceCodeUrl(): string {
  return `${codexAuthBaseUrl()}/api/accounts/deviceauth/usercode`;
}

function codexDeviceTokenUrl(): string {
  return `${codexAuthBaseUrl()}/api/accounts/deviceauth/token`;
}

function codexDeviceVerificationUri(): string {
  return `${codexAuthBaseUrl()}/codex/device`;
}

function codexDeviceRedirectUri(): string {
  return `${codexAuthBaseUrl()}/deviceauth/callback`;
}

function formatOpenAiErrorPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string') return trimOptionalText(error);
  if (!error || typeof error !== 'object') return null;
  const record = error as { code?: unknown; type?: unknown; message?: unknown };
  const code = trimOptionalText(record.code);
  const type = trimOptionalText(record.type);
  const message = trimOptionalText(record.message);
  return [code, type, message].filter(Boolean).join(' / ') || null;
}

function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  const value = trimOptionalText(token);
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function decodeJwtExpiresAtMs(token: string | null | undefined): number | null {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return exp * 1000;
}

function resolveClientId(auth?: CodexAuthRecord | null): string {
  const accessPayload = decodeJwtPayload(auth?.tokens?.access_token);
  const idPayload = decodeJwtPayload(auth?.tokens?.id_token);
  const fromAccess = trimOptionalText(accessPayload?.client_id);
  if (fromAccess) return fromAccess;
  const fromId = idPayload?.aud;
  if (typeof fromId === 'string') return trimOptionalText(fromId) ?? DEFAULT_CODEX_OAUTH_CLIENT_ID;
  if (Array.isArray(fromId)) {
    return fromId.map((value) => trimOptionalText(value)).find((value): value is string => Boolean(value)) ?? DEFAULT_CODEX_OAUTH_CLIENT_ID;
  }
  return trimOptionalText(process.env.CODEX_OAUTH_CLIENT_ID) ?? DEFAULT_CODEX_OAUTH_CLIENT_ID;
}

function formatAccountLabel(auth: CodexAuthRecord): string | null {
  const idPayload = decodeJwtPayload(auth.tokens?.id_token);
  const accessPayload = decodeJwtPayload(auth.tokens?.access_token);
  const email =
    trimOptionalText(idPayload?.email) ??
    trimOptionalText((accessPayload?.['https://api.openai.com/profile'] as { email?: unknown } | undefined)?.email);
  if (email) return email;
  return trimOptionalText(auth.tokens?.account_id) ?? null;
}

function assertManagedChatGptAuth(auth: CodexAuthRecord | null): asserts auth is CodexAuthRecord & { tokens: CodexAuthTokens } {
  if (!auth) {
    throw new Error('Codex 尚未登录；请在控制台 Codex Tab 发起 OAuth 登录。');
  }
  if (trimOptionalText(auth.auth_mode) !== 'chatgpt') {
    throw new Error('Codex OAuth 状态不是 ChatGPT OAuth 登录模式；请在控制台 Codex Tab 重新登录。');
  }
  if (!auth.tokens || typeof auth.tokens !== 'object') {
    throw new Error('Codex OAuth 状态缺少 tokens；请在控制台 Codex Tab 重新登录。');
  }
  if (!trimOptionalText(auth.tokens.access_token)) {
    throw new Error('Codex OAuth 状态缺少 access_token；请在控制台 Codex Tab 重新登录。');
  }
}

function classifyAuthErrorStatus(error: unknown): BotConsoleAuthStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (/尚未登录|缺少|not found|enoent/i.test(message)) return 'unauthenticated';
  if (/过期|expired|刷新失败|refresh/i.test(message)) return 'expired';
  return 'error';
}

function normalizeCodexModelId(model: unknown): string | null {
  const value = trimOptionalText(model);
  if (!value) return null;
  if (value.startsWith('openai/')) {
    const normalized = value.slice('openai/'.length).trim();
    return normalized && !normalized.includes('/') ? normalized : null;
  }
  return value.includes('/') ? null : value;
}

export function filterCodexModelCatalog(payload: unknown): CodexModelOption[] {
  const models = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { models?: unknown }).models)
      ? (payload as { models: unknown[] }).models
      : [];
  const result: CodexModelOption[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as CodexModelCatalogEntry;
    if (entry.supported_in_api !== true) continue;
    if (trimOptionalText(entry.visibility) !== 'list') continue;
    const rawModelId = trimOptionalText(entry.slug ?? entry.id);
    if (!rawModelId || rawModelId.includes('/')) continue;
    const modelId = normalizeCodexModelId(rawModelId);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    result.push({
      modelId,
      label: trimOptionalText(entry.display_name ?? entry.name) ?? modelId,
    });
  }
  return result;
}

function buildOpenAIModelsPayload(models: readonly CodexModelOption[]) {
  return {
    object: 'list',
    data: models.map((model) => ({
      id: model.modelId,
      object: 'model',
      name: model.label,
      owned_by: 'codex',
      supported_endpoints: ['/v1/responses'],
      capabilities: {
        structured_outputs: true,
      },
    })),
  };
}

function normalizeCodexRequestBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const source = body as Record<string, unknown>;
  const model = normalizeCodexModelId(source.model);
  return model ? { ...source, model } : { ...source };
}

function readPayloadString(payload: unknown, keys: readonly string[]): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = trimOptionalText(record[key]);
    if (value) return value;
  }
  return null;
}

function readPayloadNumber(payload: unknown, keys: readonly string[]): number | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function publicAttempt(attempt: StoredCodexAuthAttempt | null | undefined): CodexAuthAttempt | null {
  if (!attempt) return null;
  return {
    attemptId: attempt.attemptId,
    userCode: attempt.userCode,
    verificationUri: attempt.verificationUri,
    expiresAt: attempt.expiresAt,
    intervalSec: attempt.intervalSec,
    nextPollAt: attempt.nextPollAt,
    state: attempt.state,
    error: attempt.error,
  };
}

function buildAttemptStatus(attempt: StoredCodexAuthAttempt): CodexConsoleStatus {
  return {
    authKind: 'codex_oauth',
    authStatus: attempt.state === 'pending' ? 'pending' : attempt.state === 'authorized' ? 'ready' : attempt.state === 'expired' ? 'expired' : 'error',
    accountLabel: null,
    authError: attempt.error,
    tokenExpiresAt: null,
    attempt: publicAttempt(attempt),
  };
}

export class CodexOAuthBridgeService implements CodexBridgeStateProvider {
  readonly rootDir: string;
  readonly envFiles: ResolvedEnvFiles;
  readonly stateDir: string;
  readonly authFilePath: string;
  readonly modelsCacheFilePath: string;
  readonly secretFilePath: string;
  private readonly execFile: (file: string, args: string[], options?: { cwd?: string; timeout?: number; maxBuffer?: number }) => Promise<ExecResult>;
  private refreshPromise: Promise<CodexAuthRecord> | null = null;
  private readonly loginAttempts = new Map<string, StoredCodexAuthAttempt>();

  constructor(args: {
    rootDir: string;
    envFiles: ResolvedEnvFiles;
    modelsCacheDir?: string;
    execFile?: (file: string, args: string[], options?: { cwd?: string; timeout?: number; maxBuffer?: number }) => Promise<ExecResult>;
  }) {
    this.rootDir = args.rootDir;
    this.envFiles = args.envFiles;
    this.stateDir = resolveCodexStateDir(this.rootDir, this.envFiles);
    this.authFilePath = join(this.stateDir, 'codex-chatgpt.oauth.json');
    this.modelsCacheFilePath = join(resolve(expandHome(args.modelsCacheDir ?? resolveCodexCatalogHome(process.env))), 'models_cache.json');
    this.secretFilePath = join(this.stateDir, 'codex-oauth.bridge-secret');
    this.execFile = args.execFile ?? execFile;
  }

  async getRuntimeConfig(): Promise<CodexBridgeRuntimeConfig> {
    return {
      baseUrl: buildCodexBridgeBaseUrl(process.env),
      apiKey: await this.ensureBridgeSecret(),
    };
  }

  async getConsoleStatus(options: { probe?: boolean } = {}): Promise<CodexConsoleStatus> {
    const pending = [...this.loginAttempts.values()].find((attempt) => attempt.state === 'pending');
    if (pending) {
      if (pending.expiresAt <= Date.now()) {
        pending.state = 'expired';
        pending.error = 'Codex OAuth 登录验证码已过期，请重新开始登录。';
      }
      return buildAttemptStatus(pending);
    }

    try {
      const auth = await this.readAuthRecord();
      assertManagedChatGptAuth(auth);
      const expiresAt = decodeJwtExpiresAtMs(auth.tokens.access_token);
      const accountLabel = formatAccountLabel(auth);
      if (options.probe) {
        const refreshed = await this.resolveAuthRecord({ forceRefresh: false });
        return {
          authKind: 'codex_oauth',
          authStatus: 'ready',
          accountLabel: formatAccountLabel(refreshed) ?? accountLabel,
          authError: null,
          tokenExpiresAt: decodeJwtExpiresAtMs(refreshed.tokens?.access_token),
          attempt: null,
        };
      }
      return {
        authKind: 'codex_oauth',
        authStatus: expiresAt != null && expiresAt <= Date.now() ? 'expired' : 'ready',
        accountLabel,
        authError: null,
        tokenExpiresAt: expiresAt,
        attempt: null,
      };
    } catch (error) {
      return {
        authKind: 'codex_oauth',
        authStatus: classifyAuthErrorStatus(error),
        accountLabel: null,
        authError: error instanceof Error ? error.message : String(error),
        tokenExpiresAt: null,
        attempt: null,
      };
    }
  }

  async startLogin(): Promise<CodexConsoleStatus> {
    const response = await this.requestDeviceCode();
    const attemptId = randomUUID();
    const now = Date.now();
    const expiresInSec = Math.max(60, readPayloadNumber(response, ['expires_in']) ?? CODEX_DEVICE_EXPIRES_IN_SEC);
    const intervalSec = Math.max(1, readPayloadNumber(response, ['interval']) ?? CODEX_DEVICE_POLL_INTERVAL_SEC);
    const attempt: StoredCodexAuthAttempt = {
      attemptId,
      userCode: readPayloadString(response, ['user_code', 'userCode', 'usercode']) ?? '',
      verificationUri: readPayloadString(response, ['verification_uri', 'verification_url', 'verificationUri']) ?? codexDeviceVerificationUri(),
      expiresAt: now + expiresInSec * 1000,
      intervalSec,
      nextPollAt: now,
      state: 'pending',
      error: null,
      deviceCode: readPayloadString(response, ['device_auth_id', 'deviceAuthId', 'device_code', 'deviceCode']) ?? '',
      codeVerifier: '',
      clientId: String(response.__client_id ?? resolveClientId(null)),
    };
    if (!attempt.deviceCode) {
      throw new Error('Codex OAuth 设备登录失败：设备码响应缺少 device_code。');
    }
    if (!attempt.userCode) {
      throw new Error('Codex OAuth 设备登录失败：设备码响应缺少 user_code。');
    }
    this.loginAttempts.clear();
    this.loginAttempts.set(attemptId, attempt);
    return buildAttemptStatus(attempt);
  }

  async pollLogin(attemptId: string): Promise<CodexConsoleStatus> {
    const attempt = this.loginAttempts.get(String(attemptId ?? ''));
    if (!attempt) {
      return this.getConsoleStatus();
    }
    if (attempt.state !== 'pending') {
      return buildAttemptStatus(attempt);
    }
    if (attempt.expiresAt <= Date.now()) {
      attempt.state = 'expired';
      attempt.error = 'Codex OAuth 登录验证码已过期，请重新开始登录。';
      return buildAttemptStatus(attempt);
    }
    if (attempt.nextPollAt > Date.now()) {
      return buildAttemptStatus(attempt);
    }

    try {
      const payload = await this.pollDeviceToken(attempt);
      const error = trimOptionalText(payload.error);
      if (error === 'authorization_pending') {
        attempt.nextPollAt = Date.now() + attempt.intervalSec * 1000;
        return buildAttemptStatus(attempt);
      }
      if (error === 'slow_down') {
        attempt.intervalSec += 2;
        attempt.nextPollAt = Date.now() + attempt.intervalSec * 1000;
        return buildAttemptStatus(attempt);
      }
      if (error) {
        attempt.state = error === 'expired_token' ? 'expired' : 'failed';
        attempt.error = trimOptionalText(payload.error_description) ?? `Codex OAuth 登录失败：${error}`;
        return buildAttemptStatus(attempt);
      }

      const codeVerifier = readPayloadString(payload, ['code_verifier']);
      if (codeVerifier) {
        attempt.codeVerifier = codeVerifier;
      }
      const tokens = trimOptionalText(payload.access_token)
        ? payload
        : await this.exchangeAuthorizationCode(
          readPayloadString(payload, ['authorization_code', 'code', 'auth_code']),
          attempt,
        );
      const auth = await this.persistTokenResponse(tokens);
      attempt.state = 'authorized';
      attempt.error = null;
      this.loginAttempts.delete(attempt.attemptId);
      return {
        authKind: 'codex_oauth',
        authStatus: 'ready',
        accountLabel: formatAccountLabel(auth),
        authError: null,
        tokenExpiresAt: decodeJwtExpiresAtMs(auth.tokens?.access_token),
        attempt: null,
      };
    } catch (error) {
      attempt.state = 'failed';
      attempt.error = error instanceof Error ? error.message : String(error);
      return buildAttemptStatus(attempt);
    }
  }

  async cancelLogin(attemptId: string): Promise<CodexConsoleStatus> {
    const attempt = this.loginAttempts.get(String(attemptId ?? ''));
    if (attempt) {
      attempt.state = 'cancelled';
      attempt.error = 'Codex OAuth 登录已取消。';
      this.loginAttempts.delete(attempt.attemptId);
    }
    return this.getConsoleStatus();
  }

  async logout(): Promise<CodexConsoleStatus> {
    this.loginAttempts.clear();
    await rm(this.authFilePath, { force: true });
    return {
      authKind: 'codex_oauth',
      authStatus: 'unauthenticated',
      accountLabel: null,
      authError: null,
      tokenExpiresAt: null,
      attempt: null,
    };
  }

  async proxyModels(): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const models = await this.listModelOptions();
    return {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(buildOpenAIModelsPayload(models.length > 0 ? models : STATIC_CODEX_MODEL_OPTIONS)),
    };
  }

  async proxyResponses(body: unknown): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return this.proxyUpstreamResponses(normalizeCodexRequestBody(body), false);
  }

  async listModelOptions(): Promise<CodexModelOption[]> {
    const fromCli = await this.readModelCatalogFromCli();
    if (fromCli.length > 0) return fromCli;
    const cached = await readJsonIfExists<unknown>(this.modelsCacheFilePath);
    const fromCache = filterCodexModelCatalog(cached);
    return fromCache.length > 0 ? fromCache : [...STATIC_CODEX_MODEL_OPTIONS];
  }

  private async ensureBridgeSecret(): Promise<string> {
    const persisted = trimOptionalText(await readTextIfExists(this.secretFilePath));
    if (persisted) return persisted;

    const fallback =
      trimOptionalText(process.env.CHATLUNA_CODEX_API_KEY) ??
      `qqbot-codex-${randomBytes(24).toString('hex')}`;
    await writeFileAtomic(this.secretFilePath, `${fallback}\n`);
    return fallback;
  }

  private async readAuthRecord(): Promise<CodexAuthRecord | null> {
    return readJsonIfExists<CodexAuthRecord>(this.authFilePath);
  }

  private async resolveAccessToken(options: { forceRefresh?: boolean }): Promise<string> {
    const auth = await this.resolveAuthRecord(options);
    const token = trimOptionalText(auth.tokens?.access_token);
    if (!token) throw new Error('Codex OAuth 状态缺少 access_token；请在控制台 Codex Tab 重新登录。');
    return token;
  }

  private async resolveAuthRecord(options: { forceRefresh?: boolean }): Promise<CodexAuthRecord> {
    const auth = await this.readAuthRecord();
    assertManagedChatGptAuth(auth);
    const expiresAt = decodeJwtExpiresAtMs(auth.tokens.access_token);
    const usable = expiresAt == null || expiresAt - Date.now() > TOKEN_EXPIRY_SKEW_MS;
    if (!options.forceRefresh && usable) return auth;

    const refreshToken = trimOptionalText(auth.tokens.refresh_token);
    if (!refreshToken) {
      throw new Error('Codex OAuth access token 已过期，且状态文件缺少 refresh_token；请在控制台 Codex Tab 重新登录。');
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAuthRecord(auth, refreshToken).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async requestDeviceCode(): Promise<CodexDeviceCodeResponse & { __code_verifier: string; __client_id: string }> {
    const clientId = resolveClientId(null);
    const response = await fetch(codexDeviceCodeUrl(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as CodexDeviceCodeResponse;
    if (!response.ok) {
      const detail = formatOpenAiErrorPayload(payload);
      const hint = response.status === 404
        ? '；OpenAI 文档说明 device code 登录需要在 ChatGPT 账号或工作区权限中启用。'
        : '';
      throw new Error(`Codex OAuth 设备码申请失败：HTTP ${response.status}${detail ? ` (${detail})` : ''}${hint}`);
    }
    return {
      ...payload,
      __code_verifier: '',
      __client_id: clientId,
    };
  }

  private async pollDeviceToken(attempt: StoredCodexAuthAttempt): Promise<CodexDeviceTokenResponse> {
    const response = await fetch(codexDeviceTokenUrl(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_auth_id: attempt.deviceCode,
        user_code: attempt.userCode,
      }),
    });
    if (response.status === 403 || response.status === 404) {
      return { error: 'authorization_pending' };
    }
    const payload = (await response.json().catch(() => ({}))) as CodexDeviceTokenResponse;
    if (!response.ok && !payload.error) {
      throw new Error(`Codex OAuth 登录轮询失败：HTTP ${response.status}`);
    }
    return payload;
  }

  private async exchangeAuthorizationCode(code: string | null, attempt: StoredCodexAuthAttempt): Promise<CodexTokenResponse> {
    if (!code) {
      throw new Error('Codex OAuth 登录失败：轮询响应缺少 authorization code。');
    }
    if (!attempt.codeVerifier) {
      throw new Error('Codex OAuth 登录失败：轮询响应缺少 code_verifier。');
    }
    const response = await fetch(codexTokenUrl(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: codexDeviceRedirectUri(),
        client_id: attempt.clientId,
        code_verifier: attempt.codeVerifier,
      }),
    });
    if (!response.ok) {
      throw new Error(`Codex OAuth token 交换失败：HTTP ${response.status}`);
    }
    return (await response.json()) as CodexTokenResponse;
  }

  private async persistTokenResponse(payload: CodexTokenResponse, previousAuth?: CodexAuthRecord | null): Promise<CodexAuthRecord> {
    const accessToken = trimOptionalText(payload.access_token);
    if (!accessToken) {
      throw new Error('Codex OAuth token 响应缺少 access_token。');
    }
    const nextAuth: CodexAuthRecord = {
      ...(previousAuth ?? {}),
      auth_mode: 'chatgpt',
      tokens: {
        ...(previousAuth?.tokens ?? {}),
        access_token: accessToken,
        refresh_token: trimOptionalText(payload.refresh_token) ?? previousAuth?.tokens?.refresh_token ?? null,
        id_token: trimOptionalText(payload.id_token) ?? previousAuth?.tokens?.id_token ?? null,
        account_id: trimOptionalText(payload.account_id) ?? previousAuth?.tokens?.account_id ?? null,
      },
      last_refresh: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await writeJsonFile(this.authFilePath, nextAuth);
    return nextAuth;
  }

  private async refreshAuthRecord(auth: CodexAuthRecord, refreshToken: string): Promise<CodexAuthRecord> {
    const clientId = resolveClientId(auth);
    const response = await fetch(codexTokenUrl(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    if (!response.ok) {
      throw new Error(`Codex OAuth token 刷新失败：HTTP ${response.status}`);
    }
    return this.persistTokenResponse((await response.json()) as CodexTokenResponse, auth);
  }

  private async readModelCatalogFromCli(): Promise<CodexModelOption[]> {
    try {
      const result = await this.execFile('codex', ['debug', 'models'], {
        cwd: this.rootDir,
        timeout: 5000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return filterCodexModelCatalog(parseJson<unknown>(result.stdout, 'codex debug models'));
    } catch {
      return [];
    }
  }

  private async proxyUpstreamResponses(
    body: unknown,
    retried: boolean,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    try {
      const accessToken = await this.resolveAccessToken({ forceRefresh: retried });
      const upstreamBaseUrl = trimOptionalText(process.env.CHATLUNA_CODEX_UPSTREAM_BASE_URL) ?? DEFAULT_OPENAI_API_BASE_URL;
      const response = await fetch(`${upstreamBaseUrl.replace(/\/+$/, '')}/responses`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body ?? {}),
      });
      if (response.status === 401 && !retried) {
        return this.proxyUpstreamResponses(body, true);
      }
      const text = await response.text();
      return {
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8' },
        body: text,
      };
    } catch (error) {
      return {
        status: 401,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(buildJsonError(error instanceof Error ? error.message : String(error))),
      };
    }
  }
}
