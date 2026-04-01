import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CopilotOAuthBridgeService,
  buildCopilotBridgeBaseUrl,
  normalizeCopilotModelId,
  resolveCopilotStateDir,
} from '../src/plugins/copilot-oauth/service.js';

function createTempDir() {
  return mkdtempSync(join(tmpdir(), 'qqbot-copilot-oauth-'));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('copilot oauth bridge helpers', () => {
  it('resolves state dir from env mode', () => {
    expect(
      resolveCopilotStateDir('/repo', {
        mode: 'single',
        baseFilePath: '/repo/.env.local',
        overrideFilePath: null,
        editTarget: '/repo/.env.local',
      }),
    ).toBe('/repo/.runtime');

    expect(
      resolveCopilotStateDir('/repo', {
        mode: 'layered',
        baseFilePath: '/opt/qqbot/current/.env.server',
        overrideFilePath: '/opt/qqbot/shared/.env.runtime',
        editTarget: '/opt/qqbot/shared/.env.runtime',
      }),
    ).toBe('/opt/qqbot/shared');
  });

  it('normalizes copilot model ids from legacy prefixes', () => {
    expect(normalizeCopilotModelId('openai/gpt-4o')).toBe('gpt-4o');
    expect(normalizeCopilotModelId('github-copilot/claude-haiku-4.5')).toBe('claude-haiku-4.5');
    expect(normalizeCopilotModelId('gpt-5-mini')).toBe('gpt-5-mini');
  });

  it('derives bridge url from koishi port', () => {
    vi.stubEnv('KOISHI_PORT', '6150');
    expect(buildCopilotBridgeBaseUrl(process.env)).toBe('http://127.0.0.1:6150/api/internal/copilot/v1');
  });

  it('seeds bridge secret from env and reports unauthenticated status by default', async () => {
    const dir = createTempDir();
    vi.stubEnv('KOISHI_PORT', '5140');
    vi.stubEnv('CHATLUNA_COPILOT_API_KEY', 'copilot-bridge-test-secret');

    const service = new CopilotOAuthBridgeService({
      rootDir: dir,
      envFiles: {
        mode: 'single',
        baseFilePath: join(dir, '.env.local'),
        overrideFilePath: null,
        editTarget: join(dir, '.env.local'),
      },
    });

    expect(await service.getConsoleStatus()).toMatchObject({
      authKind: 'oauth_device',
      authStatus: 'unauthenticated',
      accountLabel: null,
      authError: null,
      attempt: null,
    });

    expect(await service.getRuntimeConfig()).toEqual({
      baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      apiKey: 'copilot-bridge-test-secret',
    });

    expect((await readFile(join(dir, '.runtime/github-copilot.bridge-secret'), 'utf8')).trim()).toBe(
      'copilot-bridge-test-secret',
    );
  });
});
