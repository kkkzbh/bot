import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyEnvPatchToContent,
  BotConsoleManager,
  parsePresetDocument,
  parseSystemdShowOutput,
  serializePresetDocument,
  writeFileAtomicWithBackup,
} from '../src/plugins/bot-console-core.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-bot-console-'));
  tempDirs.push(dir);
  return dir;
}

describe('bot-console env helpers', () => {
  it('preserves comments and unknown lines while patching managed keys', () => {
    const content = [
      '# comment',
      'OPENAI_BASE_URL=https://api.deepseek.com/v1',
      'UNMANAGED_FLAG=keep-me',
      'QQ_VOICE_ENABLED=true',
      '',
    ].join('\n');

    const next = applyEnvPatchToContent(content, {
      OPENAI_BASE_URL: 'https://example.com/v1',
      QQ_VOICE_ENABLED: 'false',
    });

    expect(next).toContain('# comment');
    expect(next).toContain('UNMANAGED_FLAG=keep-me');
    expect(next).toContain('OPENAI_BASE_URL=https://example.com/v1');
    expect(next).toContain('QQ_VOICE_ENABLED=false');
  });

  it('keeps the original file when atomic write fails', async () => {
    const dir = createTempDir();
    const filePath = join(dir, '.env.local');
    writeFileSync(filePath, 'OPENAI_MODEL=deepseek/deepseek-chat\n', 'utf8');

    await expect(
      writeFileAtomicWithBackup(
        filePath,
        'OPENAI_MODEL=deepseek/deepseek-reasoner\n',
        {
          access: async () => undefined,
          copyFile: async (...args) => writeFile(args[1] as string, readFileSync(args[0] as string, 'utf8'), 'utf8'),
          mkdir: async () => undefined,
          readFile: (async (path: unknown, encoding: unknown) =>
            readFileSync(String(path), encoding as BufferEncoding)) as any,
          readdir: async () => [],
          rename: async () => undefined,
          rm: async () => undefined,
          stat: async () => ({}) as any,
          writeFile: async () => {
            throw new Error('disk full');
          },
        },
      ),
    ).rejects.toThrow('disk full');

    expect(readFileSync(filePath, 'utf8')).toBe('OPENAI_MODEL=deepseek/deepseek-chat\n');
  });
});

describe('bot-console preset helpers', () => {
  it('parses and serializes a valid preset document', () => {
    const raw = [
      'keywords:',
      '  - sakiko',
      'prompts:',
      '  - role: system',
      '    content: |-',
      '      hello',
      '',
    ].join('\n');

    const preset = parsePresetDocument('sakiko', '/tmp/sakiko.yml', raw);
    expect(preset.name).toBe('sakiko');
    expect(preset.prompts[0].role).toBe('system');

    const serialized = serializePresetDocument(preset);
    expect(serialized).toContain('keywords:');
    expect(serialized).toContain('role: system');
  });

  it('rejects presets with unsupported roles', () => {
    expect(() =>
      serializePresetDocument({
        name: 'bad-role',
        keywords: [],
        prompts: [{ role: 'moderator' as any, content: 'hi' }],
      }),
    ).toThrow('不支持这个角色类型');
  });

  it('prevents deleting the current default preset', async () => {
    const dir = createTempDir();
    const presetDir = join(dir, 'data/chathub/presets');
    const envFilePath = join(dir, '.env.local');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_PRESET=sakiko\n', 'utf8');
    await writeFile(join(presetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: hi\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, presetDirPath: presetDir });
    await expect(manager.deletePreset('sakiko', 'sakiko')).rejects.toThrow('不能删除当前正在使用的默认预设');
  });
});

describe('bot-console systemd helpers', () => {
  it('parses systemctl show output into service status flags', () => {
    const status = parseSystemdShowOutput(
      [
        'Description=QQ Bot target',
        'LoadState=loaded',
        'ActiveState=active',
        'SubState=active',
        'UnitFileState=enabled',
      ].join('\n'),
      'qqbot.target',
    );

    expect(status.description).toBe('QQ Bot target');
    expect(status.canRestart).toBe(true);
    expect(status.canStart).toBe(false);
    expect(status.canStop).toBe(true);
    expect(status.canEnable).toBe(false);
  });
});

describe('bot-console manager', () => {
  it('rejects unsupported env keys when saving env', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'OPENAI_MODEL=deepseek/deepseek-chat\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(manager.saveEnv({ HACKED: '1' } as any)).rejects.toThrow('不支持这个配置项');
  });

  it('restarts qqbot.target via explicit stop then start', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'OPENAI_MODEL=deepseek/deepseek-chat\n', 'utf8');
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        stdout: [
          'Description=QQ Bot target',
          'LoadState=loaded',
          'ActiveState=active',
          'SubState=active',
          'UnitFileState=enabled',
        ].join('\n'),
        stderr: '',
      });

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, execFile });
    const status = await manager.runServiceAction('qqbot.target', 'restart');

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'systemctl',
      ['--user', 'stop', 'qqbot.target'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'systemctl',
      ['--user', 'start', 'qqbot.target'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(execFile).toHaveBeenNthCalledWith(
      3,
      'systemctl',
      ['--user', 'show', 'qqbot.target', '--property', 'Description,LoadState,ActiveState,SubState,UnitFileState'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(status.activeState).toBe('active');
  });

  it('reads recent koishi logs from journalctl output', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'OPENAI_MODEL=deepseek/deepseek-chat\n', 'utf8');
    const execFile = vi.fn().mockResolvedValue({
      stdout: 'line one\nline two\n\n',
      stderr: '',
    });

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, execFile });
    const lines = await manager.getRecentLogs();

    expect(execFile).toHaveBeenCalledWith(
      'journalctl',
      [
        '--user',
        '-u',
        'qqbot-koishi.service',
        '-n',
        '200',
        '--no-pager',
        '--output',
        'short-precise',
      ],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(lines).toEqual(['line one', 'line two']);
  });
});
