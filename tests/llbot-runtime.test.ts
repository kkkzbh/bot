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
  patchLlbotMediaPathResolution,
  prepareManagedRuntime,
  prepareRuntimeVersion,
  rewritePmhqMediaPath,
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
  it('rewrites pmhq media paths from the container qq root into the host qq volume', () => {
    expect(
      rewritePmhqMediaPath(
        '/root/.config/QQ/nt_qq_test/nt_data/Pic/2026-04/Ori/test.png',
        '/var/lib/containers/storage/volumes/qqbot-stack_qq_volume/_data',
      ),
    ).toBe('/var/lib/containers/storage/volumes/qqbot-stack_qq_volume/_data/nt_qq_test/nt_data/Pic/2026-04/Ori/test.png');
  });

  it('leaves non-qq media paths unchanged', () => {
    expect(
      rewritePmhqMediaPath(
        '/tmp/not-qq/test.png',
        '/var/lib/containers/storage/volumes/qqbot-stack_qq_volume/_data',
      ),
    ).toBe('/tmp/not-qq/test.png');
  });

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

  it('patches llbot media path resolution to rewrite pmhq qq paths to the host volume', () => {
    const dir = createTempDir();
    const runtimeDir = join(dir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, 'llbot.js'),
      [
        'class NTFileApi {',
        '  async getRichMediaFilePath(md5HexStr, fileName, elementType, elementSubType = 0) {',
        '    return await invoke(NTMethod.MEDIA_FILE_PATH, [',
        '      {',
        '        md5HexStr,',
        '        fileName,',
        '        elementType,',
        '        elementSubType,',
        '        thumbSize: 0,',
        '        needCreate: true,',
        '        downloadType: 1,',
        '        file_uuid: ""',
        '      }',
        '    ]);',
        '  }',
        '  /** 上传文件到 QQ 的文件夹 */',
        '}',
      ].join('\n'),
      'utf8',
    );

    const changed = patchLlbotMediaPathResolution({
      runtimeDir,
      qqConfigMountSource: '/var/lib/containers/storage/volumes/qqbot-stack_qq_volume/_data',
    });

    const patched = readFileSync(join(runtimeDir, 'llbot.js'), 'utf8');
    expect(changed).toBe(true);
    expect(patched).toContain('qqbot-managed-pmhq-media-path-rewrite');
    expect(patched).toContain('const mediaPath = await invoke(NTMethod.MEDIA_FILE_PATH');
    expect(patched).toContain('qqbotManagedPmhqMediaRoot');
  });

  it('keeps the llbot media path patch idempotent across repeated prepare passes', () => {
    const dir = createTempDir();
    const runtimeDir = join(dir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, 'llbot.js'),
      [
        'class NTFileApi {',
        '  async getRichMediaFilePath(md5HexStr, fileName, elementType, elementSubType = 0) {',
        '    return await invoke(NTMethod.MEDIA_FILE_PATH, [',
        '      {',
        '        md5HexStr,',
        '        fileName,',
        '        elementType,',
        '        elementSubType,',
        '        thumbSize: 0,',
        '        needCreate: true,',
        '        downloadType: 1,',
        '        file_uuid: ""',
        '      }',
        '    ]);',
        '  }',
        '  /** 上传文件到 QQ 的文件夹 */',
        '}',
      ].join('\n'),
      'utf8',
    );

    expect(
      patchLlbotMediaPathResolution({
        runtimeDir,
        qqConfigMountSource: '/var/lib/containers/storage/volumes/qqbot-stack_qq_volume/_data',
      }),
    ).toBe(true);
    expect(
      patchLlbotMediaPathResolution({
        runtimeDir,
        qqConfigMountSource: '/var/lib/containers/storage/volumes/qqbot-stack_qq_volume/_data',
      }),
    ).toBe(false);
    expect(
      readFileSync(join(runtimeDir, 'llbot.js'), 'utf8').match(/qqbot-managed-pmhq-media-path-rewrite/g),
    ).toHaveLength(1);
  });

  it('fails fast when the llbot media path signature changes upstream', () => {
    const dir = createTempDir();
    const runtimeDir = join(dir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'llbot.js'), 'console.log("no media path hook here")\n', 'utf8');

    expect(() => patchLlbotMediaPathResolution({
      runtimeDir,
      qqConfigMountSource: '/var/lib/containers/storage/volumes/qqbot-stack_qq_volume/_data',
    })).toThrow(/getRichMediaFilePath/);
  });

  it('prepareManagedRuntime applies both the llbot bundle patch and the qq config bridge', async () => {
    const dir = createTempDir();
    const runtimeDir = join(dir, 'runtime');
    const dataDir = join(dir, 'data');
    const homeDir = join(dir, 'home');
    const qqMountSource = join(dir, 'pmhq-qq');
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(join(qqMountSource, 'nt_qq_test', 'nt_data', 'Pic'), { recursive: true });
    writeFileSync(join(runtimeDir, '.qqbot-llbot-version'), '7.11.0\n', 'utf8');
    writeFileSync(
      join(runtimeDir, 'llbot.js'),
      [
        'function authMiddleware(req, res, next) {',
        '\treturn res.status(401).end()',
        '}',
        'class NTFileApi {',
        '  async getRichMediaFilePath(md5HexStr, fileName, elementType, elementSubType = 0) {',
        '    return await invoke(NTMethod.MEDIA_FILE_PATH, [',
        '      {',
        '        md5HexStr,',
        '        fileName,',
        '        elementType,',
        '        elementSubType,',
        '        thumbSize: 0,',
        '        needCreate: true,',
        '        downloadType: 1,',
        '        file_uuid: ""',
        '      }',
        '    ]);',
        '  }',
        '  /** 上传文件到 QQ 的文件夹 */',
        '}',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(runtimeDir, 'default_config.json'),
      JSON.stringify({
        webui: { enable: false, host: '127.0.0.1', port: 3000 },
        ob11: {
          enable: false,
          connect: [
            { type: 'ws', enable: false, host: '127.0.0.1', port: 9000, token: 'old' },
          ],
        },
      }),
      'utf8',
    );

    await prepareManagedRuntime({
      LLBOT_VERSION: '7.11.0',
      LLBOT_RUNTIME_DIR: runtimeDir,
      LLONEBOT_DATA_DIR: dataDir,
      QQBOT_QQ_CONFIG_MOUNT_SOURCE: qqMountSource,
      HOME: homeDir,
    });

    const entrypoint = readFileSync(join(runtimeDir, 'llbot.js'), 'utf8');
    expect(entrypoint).toContain('qqbot-managed-pmhq-media-path-rewrite');
    expect(lstatSync(join(homeDir, '.config', 'QQ')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(qqMountSource, 'nt_qq_test', 'nt_data', 'Pic'))).toBe(true);
  });
});
