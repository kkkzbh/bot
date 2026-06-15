import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexOAuthBridgeService,
  buildCodexBridgeBaseUrl,
  decodeJwtExpiresAtMs,
  filterCodexModelCatalog,
  resolveCodexStateDir,
} from '../src/plugins/codex-oauth/service.js';

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-codex-oauth-'));
  tempDirs.push(dir);
  return dir;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(payload)}.sig`;
}

function createService(dir: string, modelsCacheDir = join(dir, '.codex'), execFile = async () => ({ stdout: '{"models":[]}', stderr: '' })) {
  return new CodexOAuthBridgeService({
    rootDir: dir,
    modelsCacheDir,
    execFile,
    envFiles: {
      mode: 'single',
      baseFilePath: join(dir, '.env.local'),
      overrideFilePath: null,
      editTarget: join(dir, '.env.local'),
    },
  });
}

function writeCodexAuth(dir: string, auth: unknown): void {
  const stateDir = join(dir, '.runtime');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'codex-chatgpt.oauth.json'), `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
}

function readCodexAuth(dir: string): any {
  return JSON.parse(readFileSync(join(dir, '.runtime/codex-chatgpt.oauth.json'), 'utf8'));
}

describe('codex oauth bridge helpers', () => {
  it('resolves state dir from env mode and derives bridge url from koishi port', () => {
    expect(
      resolveCodexStateDir('/repo', {
        mode: 'single',
        baseFilePath: '/repo/.env.local',
        overrideFilePath: null,
        editTarget: '/repo/.env.local',
      }),
    ).toBe('/repo/.runtime');

    expect(
      resolveCodexStateDir('/repo', {
        mode: 'layered',
        baseFilePath: '/opt/qqbot/current/.env.server',
        overrideFilePath: '/opt/qqbot/shared/.env.runtime',
        editTarget: '/opt/qqbot/shared/.env.runtime',
      }),
    ).toBe('/opt/qqbot/shared');

    vi.stubEnv('KOISHI_PORT', '6151');
    expect(buildCodexBridgeBaseUrl(process.env)).toBe('http://127.0.0.1:6151/api/internal/codex/v1');
  });

  it('filters Codex catalog to visible API-supported model slugs', () => {
    expect(filterCodexModelCatalog({
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_in_api: true },
        { slug: 'gpt-5.3-codex-spark', display_name: 'Spark', visibility: 'list', supported_in_api: false },
        { slug: 'codex-auto-review', display_name: 'Auto Review', visibility: 'hide', supported_in_api: true },
        { slug: 'openai/bad', display_name: 'Bad', visibility: 'list', supported_in_api: true },
        { slug: 'gpt-5.5', display_name: 'duplicate', visibility: 'list', supported_in_api: true },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4-Mini', visibility: 'list', supported_in_api: true },
      ],
    })).toEqual([
      { modelId: 'gpt-5.5', label: 'GPT-5.5' },
      { modelId: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
    ]);
  });

  it('reports missing Codex ChatGPT auth without token material', async () => {
    const dir = createTempDir();
    const status = await createService(dir).getConsoleStatus({ probe: true });

    expect(status).toMatchObject({
      authKind: 'codex_oauth',
      authStatus: 'unauthenticated',
      accountLabel: null,
      tokenExpiresAt: null,
    });
    expect(status.authError).toContain('控制台 Codex Tab');
    expect(JSON.stringify(status)).not.toContain('access_token');
    expect(JSON.stringify(status)).not.toContain('refresh_token');
  });

  it('starts and completes a managed Codex OAuth device login without exposing token material', async () => {
    const dir = createTempDir();
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      client_id: 'codex-client',
      'https://api.openai.com/profile': { email: 'managed@example.test' },
    });
    const idToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: ['codex-client'],
      email: 'managed@example.test',
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
        expect(JSON.parse(String(init?.body))).toMatchObject({
          client_id: expect.any(String),
        });
        return new Response(JSON.stringify({
          device_auth_id: 'device-123',
          user_code: 'ABCD-EFGH',
          interval: '1',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
        expect(JSON.parse(String(init?.body))).toEqual({
          device_auth_id: 'device-123',
          user_code: 'ABCD-EFGH',
        });
        return new Response(JSON.stringify({
          authorization_code: 'auth-code-123',
          code_challenge: 'challenge-from-codex',
          code_verifier: 'verifier-from-codex',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        expect(String(init?.body)).toContain('grant_type=authorization_code');
        expect(String(init?.body)).toContain('code=auth-code-123');
        expect(String(init?.body)).toContain('code_verifier=');
        return new Response(JSON.stringify({
          access_token: accessToken,
          refresh_token: 'managed-refresh',
          id_token: idToken,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const service = createService(dir);
    const started = await service.startLogin();
    expect(started).toMatchObject({
      authKind: 'codex_oauth',
      authStatus: 'pending',
      attempt: {
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://auth.openai.com/codex/device',
        state: 'pending',
      },
    });
    expect(JSON.stringify(started)).not.toContain(accessToken);

    const polled = await service.pollLogin(started.attempt?.attemptId ?? '');
    const persisted = readCodexAuth(dir);
    expect(polled).toMatchObject({
      authKind: 'codex_oauth',
      authStatus: 'ready',
      accountLabel: 'managed@example.test',
      tokenExpiresAt: decodeJwtExpiresAtMs(accessToken),
      attempt: null,
    });
    expect(persisted.tokens.access_token).toBe(accessToken);
    expect(persisted.tokens.refresh_token).toBe('managed-refresh');
    expect(JSON.stringify(polled)).not.toContain(accessToken);
    expect(JSON.stringify(polled)).not.toContain('managed-refresh');
  });

  it('keeps Codex OAuth device login pending while the Codex token endpoint returns 403', async () => {
    const dir = createTempDir();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        return new Response(JSON.stringify({
          device_auth_id: 'device-403',
          user_code: 'WAIT-403',
          interval: '1',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        return new Response('', { status: 403 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const service = createService(dir);
    const started = await service.startLogin();
    const polled = await service.pollLogin(started.attempt?.attemptId ?? '');

    expect(polled).toMatchObject({
      authKind: 'codex_oauth',
      authStatus: 'pending',
      authError: null,
      attempt: {
        userCode: 'WAIT-403',
        state: 'pending',
      },
    });
  });

  it('surfaces OpenAI device-code errors without exposing token material', async () => {
    const dir = createTempDir();
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        return new Response(JSON.stringify({
          error: {
            code: 'device_code_not_enabled',
            type: 'request_forbidden',
            message: 'Device code login is not enabled.',
          },
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const service = createService(dir);
    await expect(service.startLogin()).rejects.toThrow(/device_code_not_enabled/);
    await expect(service.startLogin()).rejects.toThrow(/device code 登录需要/);
    await expect(service.startLogin()).rejects.not.toThrow(/access_token|refresh_token/i);
  });

  it('refreshes near-expiry Codex OAuth tokens and preserves managed auth state atomically', async () => {
    const dir = createTempDir();
    const oldAccess = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 30,
      client_id: 'codex-client',
      'https://api.openai.com/profile': { email: 'tester@example.test' },
    });
    const oldRefresh = 'old-refresh-token';
    const newAccess = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, client_id: 'codex-client' });
    const newIdToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, aud: ['codex-client'], email: 'tester@example.test' });
    writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: oldAccess,
        refresh_token: oldRefresh,
        id_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, aud: ['codex-client'] }),
        account_id: 'acct_123',
      },
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://auth.openai.com/oauth/token');
      expect(String(init?.body)).toContain('grant_type=refresh_token');
      expect(String(init?.body)).toContain('client_id=codex-client');
      expect(String(init?.body)).toContain(`refresh_token=${oldRefresh}`);
      return new Response(JSON.stringify({
        access_token: newAccess,
        refresh_token: 'new-refresh-token',
        id_token: newIdToken,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const status = await createService(dir).getConsoleStatus({ probe: true });
    const persisted = readCodexAuth(dir);

    expect(status).toMatchObject({
      authKind: 'codex_oauth',
      authStatus: 'ready',
      accountLabel: 'tester@example.test',
      authError: null,
      tokenExpiresAt: decodeJwtExpiresAtMs(newAccess),
    });
    expect(persisted.tokens.access_token).toBe(newAccess);
    expect(persisted.tokens.refresh_token).toBe('new-refresh-token');
    expect(JSON.stringify(status)).not.toContain(oldAccess);
    expect(JSON.stringify(status)).not.toContain(newAccess);
    expect(JSON.stringify(status)).not.toContain(oldRefresh);
  });

  it('serves models from Codex catalog and proxies responses with stripped model ids', async () => {
    const dir = createTempDir();
    const accessToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, client_id: 'codex-client' });
    writeCodexAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
      },
    });

    const service = createService(
      dir,
      join(dir, '.codex'),
      async () => ({
        stdout: JSON.stringify({
          models: [
            { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_in_api: true },
            { slug: 'gpt-5.3-codex-spark', display_name: 'Spark', visibility: 'list', supported_in_api: false },
          ],
        }),
        stderr: '',
      }),
    );
    const models = await service.proxyModels();
    expect(models.status).toBe(200);
    expect(JSON.parse(models.body)).toMatchObject({
      data: [
        {
          id: 'gpt-5.5',
          supported_endpoints: ['/v1/responses'],
          capabilities: { structured_outputs: true },
        },
      ],
    });
    expect(models.body).not.toContain(accessToken);

    const fetchMock = vi.fn(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await service.proxyResponses({
      model: 'openai/gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });

    expect(result).toMatchObject({
      status: 200,
      body: '{"ok":true}',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${accessToken}`,
        }),
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        }),
      }),
    );
  });
});
