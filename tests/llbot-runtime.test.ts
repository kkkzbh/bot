import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  VERSION_MARKER,
  applyManagedConfig,
  disableWebUIAuthMiddleware,
  ensureQqConfigBridge,
  prepareRuntimeVersion,
} = require('../scripts/lib/llbot-runtime.cjs');

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-llbot-runtime-'));
  tempDirs.push(dir);
  return dir;
}

describe('llbot host runtime helpers', () => {
  it('downloads and extracts the requested llbot version on first prepare', async () => {
    const runtimeDir = join(createTempDir(), 'llbot-runtime');
    const extractZip = vi.fn(async (_zipPath: string, targetDir: string) => {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, 'llbot.js'), 'console.log("llbot")\n', 'utf8');
      writeFileSync(join(targetDir, 'default_config.json'), '{}\n', 'utf8');
    });

    const changed = await prepareRuntimeVersion({
      runtimeDir,
      version: '7.11.0',
      fetchImpl: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
      extractZip,
    });

    expect(changed).toBe(true);
    expect(extractZip).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(runtimeDir, VERSION_MARKER), 'utf8').trim()).toBe('7.11.0');
  });

  it('skips re-download when the runtime version already matches', async () => {
    const runtimeDir = join(createTempDir(), 'llbot-runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, VERSION_MARKER), '7.11.0\n', 'utf8');
    writeFileSync(join(runtimeDir, 'llbot.js'), 'console.log("llbot")\n', 'utf8');
    writeFileSync(join(runtimeDir, 'default_config.json'), '{}\n', 'utf8');

    const changed = await prepareRuntimeVersion({
      runtimeDir,
      version: '7.11.0',
      fetchImpl: vi.fn(),
      extractZip: vi.fn(),
    });

    expect(changed).toBe(false);
  });

  it('rewrites llbot managed config to host loopback pmhq and local websocket settings', () => {
    const config = applyManagedConfig({
      webui: { enable: false, host: '127.0.0.1', port: 3000 },
      ob11: {
        enable: false,
        connect: [
          { type: 'ws', enable: false, host: '127.0.0.1', port: 9000, token: 'old' },
          { type: 'ws-reverse', enable: true, url: 'ws://old', token: 'old' },
          { type: 'http', enable: true, host: '0.0.0.0', token: 'old' },
          { type: 'http-post', enable: true, url: 'http://old', token: 'old' },
        ],
      },
    }, {
      LLONEBOT_WEBUI_PORT: '3080',
      LLONEBOT_WS_PORT: '3001',
      ONEBOT_TOKEN: 'secret',
    });

    expect(config.webui).toMatchObject({ enable: true, host: '', port: 3080 });
    expect(config.ob11.enable).toBe(true);
    expect(config.ob11.connect[0]).toMatchObject({
      type: 'ws',
      enable: true,
      host: '0.0.0.0',
      port: 3001,
      token: 'secret',
    });
    expect(config.ob11.connect[1]).toMatchObject({ enable: false, url: '', token: '' });
    expect(config.ob11.connect[2]).toMatchObject({ enable: false, host: '127.0.0.1', token: '' });
    expect(config.ob11.connect[3]).toMatchObject({ enable: false, url: '', token: '' });
  });

  it('disables the webui auth middleware and clears stale tokens when requested', () => {
    const dir = createTempDir();
    const runtimeDir = join(dir, 'runtime');
    const dataDir = join(dir, 'data');
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, 'llbot.js'),
      [
        'function authMiddleware(req, res, next) {',
        '\treturn res.status(401).end()',
        '}',
        '//#endregion',
        '//#region src/webui/BE/utils.ts',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(join(dataDir, 'webui_token.txt'), 'secret-token\n', 'utf8');
    symlinkSync(dataDir, join(runtimeDir, 'data'), 'dir');

    disableWebUIAuthMiddleware({ runtimeDir, dataDir, disableAuth: true });

    expect(readFileSync(join(runtimeDir, 'llbot.js'), 'utf8')).toContain('\tnext();');
    expect(() => readFileSync(join(dataDir, 'webui_token.txt'), 'utf8')).toThrow();
  });

  it('bridges the host qq config path into the pmhq volume and prepares the monthly pic directories', async () => {
    const dir = createTempDir();
    const runtimeDir = join(dir, 'runtime');
    const bridgeHomeDir = join(dir, 'bridge-home');
    const qqMountSource = join(dir, 'pmhq-qq');
    const qqNtDir = join(qqMountSource, 'nt_qq_test');
    mkdirSync(join(qqNtDir, 'nt_data', 'Pic'), { recursive: true });

    const result = await ensureQqConfigBridge({
      runtimeDir,
      homeDir: bridgeHomeDir,
      qqConfigMountSource: qqMountSource,
      now: new Date('2026-04-08T09:00:00Z'),
    });

    const qqLinkPath = join(bridgeHomeDir, '.config', 'QQ');
    expect(result).toMatchObject({
      bridgeHomeDir,
      qqConfigMountSource: qqMountSource,
      linked: true,
    });
    expect(lstatSync(qqLinkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(join(qqMountSource, 'nt_qq_test', 'nt_data', 'Pic', '2026-04', 'Ori'))).toBe(true);
    expect(existsSync(join(qqMountSource, 'nt_qq_test', 'nt_data', 'Pic', '2026-04', 'Thumb'))).toBe(true);
  });
});
