import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyEnvPatchToContent,
  buildModelTabsStateFromEnv,
  BotConsoleManager,
  mergeManagedEnvRecords,
  parsePresetDocument,
  parseSystemdShowOutput,
  resolveBotEnvFilePath,
  resolveBotEnvFiles,
  resolveBotPresetPaths,
  readManagedEnvPatchFromContent,
  serializePresetDocument,
  writeFileAtomicWithBackup,
} from '../src/plugins/bot-console/server.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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
      'CHATLUNA_BASE_URL=https://api.siliconflow.cn/v1',
      'UNMANAGED_FLAG=keep-me',
      'QQ_VOICE_INPUT_ENABLED=true',
      '',
    ].join('\n');

    const next = applyEnvPatchToContent(content, {
      CHATLUNA_BASE_URL: 'https://example.com/v1',
      QQ_VOICE_INPUT_ENABLED: 'false',
    });

    expect(next).toContain('# comment');
    expect(next).toContain('UNMANAGED_FLAG=keep-me');
    expect(next).toContain('CHATLUNA_BASE_URL=https://example.com/v1');
    expect(next).toContain('QQ_VOICE_INPUT_ENABLED=false');
  });

  it('keeps the original file when atomic write fails', async () => {
    const dir = createTempDir();
    const filePath = join(dir, '.env.local');
    writeFileSync(filePath, 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    await expect(
      writeFileAtomicWithBackup(
        filePath,
        'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5-preview\n',
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

    expect(readFileSync(filePath, 'utf8')).toBe('CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n');
  });

  it('falls back to .env.server when .env.local is absent', () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.server');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=deepseek-chat\n', 'utf8');

    expect(resolveBotEnvFilePath(dir)).toBe(envFilePath);
  });

  it('prefers QQBOT_ENV_FILE when explicitly set', () => {
    const dir = createTempDir();
    writeFileSync(join(dir, '.env.local'), 'CHATLUNA_DEFAULT_MODEL=local-model\n', 'utf8');
    writeFileSync(join(dir, '.env.server'), 'CHATLUNA_DEFAULT_MODEL=server-model\n', 'utf8');
    vi.stubEnv('QQBOT_ENV_FILE', '.env.server');

    expect(resolveBotEnvFilePath(dir)).toBe(join(dir, '.env.server'));
  });

  it('switches to layered env mode when runtime override files are configured', () => {
    const dir = createTempDir();
    vi.stubEnv('QQBOT_ENV_BASE_FILE', '/opt/qqbot/current/.env.server');
    vi.stubEnv('QQBOT_ENV_OVERRIDE_FILE', '/opt/qqbot/shared/.env.runtime');

    expect(resolveBotEnvFiles(dir)).toEqual({
      mode: 'layered',
      baseFilePath: '/opt/qqbot/current/.env.server',
      overrideFilePath: '/opt/qqbot/shared/.env.runtime',
      editTarget: '/opt/qqbot/shared/.env.runtime',
    });
  });

  it('merges managed env values with runtime override precedence', () => {
    const merged = mergeManagedEnvRecords(
      readManagedEnvPatchFromContent('CHATLUNA_DEFAULT_MODEL=base-model\nCHATLUNA_DEFAULT_PRESET=sakiko\n'),
      readManagedEnvPatchFromContent('CHATLUNA_DEFAULT_MODEL=runtime-model\nQQ_VOICE_OUTPUT_ENABLED=false\n'),
    );

    expect(merged).toMatchObject({
      CHATLUNA_DEFAULT_MODEL: 'runtime-model',
      CHATLUNA_DEFAULT_PRESET: 'sakiko',
      QQ_VOICE_OUTPUT_ENABLED: 'false',
    });
  });

  it('builds fixed built-in model tabs from active env state', () => {
    const state = buildModelTabsStateFromEnv({
      CHATLUNA_ACTIVE_TAB: 'openai',
      CHATLUNA_BASE_URL: 'https://shell.wyzai.top/v1',
      CHATLUNA_API_KEY: 'sk-active',
      CHATLUNA_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
      CHATLUNA_OPENAI_BASE_URL: 'https://shell.wyzai.top/v1',
      CHATLUNA_OPENAI_API_KEY: 'sk-openai',
      CHATLUNA_OPENAI_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'github_pat_123',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'gpt-5.4-mini',
      CHATLUNA_SILICONFLOW_BASE_URL: 'https://api.siliconflow.cn/v1',
      CHATLUNA_SILICONFLOW_API_KEY: 'sk-kimi',
      CHATLUNA_SILICONFLOW_DEFAULT_MODEL: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
    } as Record<string, string>);

    expect(state.activeTab).toBe('openai');
    expect(state.tabs).toEqual([
      expect.objectContaining({
        id: 'siliconflow',
        strategyId: 'siliconflow-kimi-main-chat',
        baseUrl: 'https://api.siliconflow.cn/v1',
        defaultModel: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
      }),
      expect.objectContaining({
        id: 'openai',
        requestMode: 'responses',
        structuredOutputProtocol: 'responses_text_format',
        baseUrl: 'https://shell.wyzai.top/v1',
        defaultModel: 'openai/gpt-5.4-medium-thinking',
      }),
      expect.objectContaining({
        id: 'copilot',
        strategyId: 'copilot-github-oauth-main-chat',
        requestMode: 'responses',
        structuredOutputProtocol: 'responses_text_format',
        defaultModel: 'gpt-5.4-mini',
      }),
    ]);
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

  it('lists presets by saved order and appends unordered presets alphabetically', async () => {
    const dir = createTempDir();
    const presetDir = join(dir, 'data/chathub/presets');
    const envFilePath = join(dir, '.env.local');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_PRESET=sakiko\n', 'utf8');
    await Promise.all([
      writeFile(join(presetDir, 'empty.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: empty\n', 'utf8'),
      writeFile(join(presetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: sakiko\n', 'utf8'),
      writeFile(join(presetDir, 'catgirl.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: catgirl\n', 'utf8'),
      writeFile(join(presetDir, 'sydney.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: sydney\n', 'utf8'),
      writeFile(join(presetDir, '.bot-console-preset-order.json'), JSON.stringify({ names: ['sakiko', 'catgirl'] }), 'utf8'),
    ]);

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, presetDirPath: presetDir });
    await expect(manager.listPresetSummaries()).resolves.toEqual([
      expect.objectContaining({ name: 'sakiko' }),
      expect.objectContaining({ name: 'catgirl' }),
      expect.objectContaining({ name: 'empty' }),
      expect.objectContaining({ name: 'sydney' }),
    ]);
  });

  it('resolves layered preset directories from runtime env vars', () => {
    const dir = createTempDir();
    vi.stubEnv('CHATLUNA_RUNTIME_PRESET_DIR', '/opt/qqbot/shared/presets');
    vi.stubEnv('CHATLUNA_PRESET_DIRS', '/opt/qqbot/shared/presets:/opt/qqbot/current/data/chathub/presets');

    expect(resolveBotPresetPaths(dir)).toEqual({
      mode: 'layered',
      runtimeDirPath: '/opt/qqbot/shared/presets',
      bundledDirPaths: ['/opt/qqbot/current/data/chathub/presets'],
      allDirPaths: ['/opt/qqbot/shared/presets', '/opt/qqbot/current/data/chathub/presets'],
    });
  });

  it('merges runtime presets ahead of bundled presets and tags their source', async () => {
    const dir = createTempDir();
    const runtimePresetDir = join(dir, 'runtime/presets');
    const bundledPresetDir = join(dir, 'data/chathub/presets');
    const envFilePath = join(dir, '.env.local');
    mkdirSync(runtimePresetDir, { recursive: true });
    mkdirSync(bundledPresetDir, { recursive: true });
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_PRESET=sakiko\n', 'utf8');
    await Promise.all([
      writeFile(join(runtimePresetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: runtime\n', 'utf8'),
      writeFile(join(runtimePresetDir, 'runtime-only.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: runtime-only\n', 'utf8'),
      writeFile(join(runtimePresetDir, '.bot-console-preset-order.json'), JSON.stringify({ names: ['sakiko', 'runtime-only'] }), 'utf8'),
      writeFile(join(bundledPresetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: bundled\n', 'utf8'),
      writeFile(join(bundledPresetDir, 'bundled-only.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: bundled-only\n', 'utf8'),
    ]);

    const manager = new BotConsoleManager({
      rootDir: dir,
      envFilePath,
      runtimePresetDirPath: runtimePresetDir,
      bundledPresetDirPaths: [bundledPresetDir],
    });

    await expect(manager.listPresetSummaries()).resolves.toEqual([
      expect.objectContaining({ name: 'sakiko', source: 'runtime' }),
      expect.objectContaining({ name: 'runtime-only', source: 'runtime' }),
      expect.objectContaining({ name: 'bundled-only', source: 'bundled' }),
    ]);
    await expect(manager.getPreset('sakiko')).resolves.toMatchObject({
      name: 'sakiko',
      source: 'runtime',
    });
  });

  it('rejects deleting a bundled-only preset and re-exposes bundled fallback after removing runtime shadow', async () => {
    const dir = createTempDir();
    const runtimePresetDir = join(dir, 'runtime/presets');
    const bundledPresetDir = join(dir, 'data/chathub/presets');
    const envFilePath = join(dir, '.env.local');
    mkdirSync(runtimePresetDir, { recursive: true });
    mkdirSync(bundledPresetDir, { recursive: true });
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_PRESET=sydney\n', 'utf8');
    await Promise.all([
      writeFile(join(runtimePresetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: runtime\n', 'utf8'),
      writeFile(join(bundledPresetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: bundled\n', 'utf8'),
      writeFile(join(bundledPresetDir, 'sydney.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: bundled-only\n', 'utf8'),
    ]);

    const manager = new BotConsoleManager({
      rootDir: dir,
      envFilePath,
      runtimePresetDirPath: runtimePresetDir,
      bundledPresetDirPaths: [bundledPresetDir],
    });

    await expect(manager.deletePreset('sydney', 'sakiko')).rejects.toThrow('只能删除运行时预设');
    await expect(manager.deletePreset('sakiko', 'sydney')).resolves.toBeUndefined();
    await expect(manager.getPreset('sakiko')).resolves.toMatchObject({
      name: 'sakiko',
      source: 'bundled',
    });
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
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(manager.saveEnv({ HACKED: '1' } as any)).rejects.toThrow('不支持这个配置项');
  });

  it('accepts QQBOT_REPLY_INTERRUPT_ENABLED through managed env saves', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(manager.saveEnv({ QQBOT_REPLY_INTERRUPT_ENABLED: 'false' })).resolves.toMatchObject({
      QQBOT_REPLY_INTERRUPT_ENABLED: 'false',
    });
  });

  it('accepts file system env controls through managed env saves', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveEnv({
        CHATLUNA_COMMON_FS: 'true',
        CHATLUNA_COMMON_FS_SCOPE_PATH: '/tmp/qqbot-scope',
      }),
    ).resolves.toMatchObject({
      CHATLUNA_COMMON_FS: 'true',
      CHATLUNA_COMMON_FS_SCOPE_PATH: '/tmp/qqbot-scope',
    });
  });

  it('reads state from .env.server when that is the active runtime env file', async () => {
    const dir = createTempDir();
    const presetDir = join(dir, 'data/chathub/presets');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(dir, '.env.server'), 'CHATLUNA_DEFAULT_MODEL=server-model\nCHATLUNA_DEFAULT_PRESET=sakiko\n', 'utf8');
    writeFileSync(join(presetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: hi\n', 'utf8');
    vi.stubEnv('QQBOT_ENV_FILE', '.env.server');

    const manager = new BotConsoleManager({ rootDir: dir });
    await expect(manager.getState()).resolves.toMatchObject({
      env: expect.objectContaining({
        CHATLUNA_DEFAULT_MODEL: 'server-model',
        CHATLUNA_DEFAULT_PRESET: 'sakiko',
      }),
      envFiles: expect.objectContaining({
        mode: 'single',
        editTarget: join(dir, '.env.server'),
      }),
      defaultPreset: 'sakiko',
    });
  });

  it('writes layered env updates into the runtime override file only', async () => {
    const dir = createTempDir();
    const baseEnvFilePath = join(dir, '.env.server');
    const overrideEnvFilePath = join(dir, '.env.runtime');
    writeFileSync(baseEnvFilePath, 'CHATLUNA_DEFAULT_MODEL=base-model\nCHATLUNA_DEFAULT_PRESET=sakiko\n', 'utf8');

    const manager = new BotConsoleManager({
      rootDir: dir,
      envBaseFilePath: baseEnvFilePath,
      envOverrideFilePath: overrideEnvFilePath,
    });

    await expect(manager.saveEnv({ CHATLUNA_DEFAULT_MODEL: 'runtime-model' })).resolves.toMatchObject({
      CHATLUNA_DEFAULT_MODEL: 'runtime-model',
      CHATLUNA_DEFAULT_PRESET: 'sakiko',
    });
    expect(readFileSync(baseEnvFilePath, 'utf8')).toContain('CHATLUNA_DEFAULT_MODEL=base-model');
    expect(readFileSync(overrideEnvFilePath, 'utf8')).toContain('CHATLUNA_DEFAULT_MODEL=runtime-model');
  });

  it('mirrors the active built-in tab into runtime chatluna env keys', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(
      envFilePath,
      [
        'CHATLUNA_BASE_URL=https://api.siliconflow.cn/v1',
        'CHATLUNA_API_KEY=sk-old',
        'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5',
        '',
      ].join('\n'),
      'utf8',
    );

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    const result = await manager.saveModelTabs({
      activeTab: 'openai',
      tabs: [
        {
          id: 'siliconflow',
          title: '硅基流动',
          provider: 'siliconflow',
          strategyId: 'siliconflow-kimi-main-chat',
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'chat_completions_json_schema',
          description: 'siliconflow',
          modelHint: 'kimi',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-kimi',
          defaultModel: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
        },
        {
          id: 'openai',
          title: 'OpenAI',
          provider: 'openai',
          strategyId: 'openai-gpt54-main-chat',
          requestMode: 'responses',
          structuredOutputProtocol: 'responses_text_format',
          description: 'openai',
          modelHint: 'gpt-5.4',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://shell.wyzai.top/v1',
          apiKey: 'sk-openai',
          defaultModel: 'openai/gpt-5.4-medium-thinking',
        },
        {
          id: 'copilot',
          title: 'GitHub Copilot',
          provider: 'openai',
          strategyId: 'copilot-github-oauth-main-chat',
          requestMode: 'responses',
          structuredOutputProtocol: 'responses_text_format',
          description: 'copilot',
          modelHint: 'gpt-5.4-mini',
          authKind: 'oauth_device',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
          apiKey: 'github_pat_123',
          defaultModel: 'gpt-5.4-mini',
        },
      ],
    });

    expect(result.modelTabs.activeTab).toBe('openai');
    expect(result.env).toMatchObject({
      CHATLUNA_ACTIVE_TAB: 'openai',
      CHATLUNA_PLATFORM: 'openai',
      CHATLUNA_BASE_URL: 'https://shell.wyzai.top/v1',
      CHATLUNA_API_KEY: 'sk-openai',
      CHATLUNA_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
      CHATLUNA_SILICONFLOW_DEFAULT_MODEL: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
      CHATLUNA_OPENAI_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'github_pat_123',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'gpt-5.4-mini',
    });
  });

  it('rejects unsupported OpenAI tab models', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveModelTabs({
        activeTab: 'openai',
        tabs: [
          {
            id: 'siliconflow',
            title: '硅基流动',
            provider: 'siliconflow',
          strategyId: 'siliconflow-kimi-main-chat',
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'chat_completions_json_schema',
          description: 'siliconflow',
          modelHint: 'kimi',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-kimi',
          defaultModel: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
        },
          {
            id: 'openai',
            title: 'OpenAI',
            provider: 'openai',
          strategyId: 'openai-gpt54-main-chat',
          requestMode: 'responses',
          structuredOutputProtocol: 'responses_text_format',
          description: 'openai',
          modelHint: 'gpt-5.4',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://shell.wyzai.top/v1',
          apiKey: 'sk-openai',
          defaultModel: 'openai/gpt-5.2',
        },
          {
          id: 'copilot',
          title: 'GitHub Copilot',
          provider: 'openai',
          strategyId: 'copilot-github-oauth-main-chat',
          requestMode: 'responses',
          structuredOutputProtocol: 'responses_text_format',
          description: 'copilot',
          modelHint: 'gpt-5.4-mini',
          authKind: 'oauth_device',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
          apiKey: 'github_pat_123',
          defaultModel: 'gpt-5.4-mini',
        },
      ],
    }),
    ).rejects.toThrow('OpenAI Tab 只支持当前允许的模型族');
  });

  it('rejects unsupported Copilot tab models', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath });
    await expect(
      manager.saveModelTabs({
        activeTab: 'copilot',
        tabs: [
          {
            id: 'siliconflow',
            title: '硅基流动',
            provider: 'siliconflow',
          strategyId: 'siliconflow-kimi-main-chat',
          requestMode: 'chat_completions',
          structuredOutputProtocol: 'chat_completions_json_schema',
          description: 'siliconflow',
          modelHint: 'kimi',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-kimi',
          defaultModel: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
        },
          {
            id: 'openai',
            title: 'OpenAI',
            provider: 'openai',
          strategyId: 'openai-gpt54-main-chat',
          requestMode: 'responses',
          structuredOutputProtocol: 'responses_text_format',
          description: 'openai',
          modelHint: 'gpt-5.4',
          authKind: 'manual',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'https://shell.wyzai.top/v1',
          apiKey: 'sk-openai',
          defaultModel: 'openai/gpt-5.4-medium-thinking',
        },
          {
          id: 'copilot',
          title: 'GitHub Copilot',
          provider: 'openai',
          strategyId: 'copilot-github-oauth-main-chat',
          requestMode: 'responses',
          structuredOutputProtocol: 'responses_text_format',
          description: 'copilot',
          modelHint: 'gpt-5.4-mini',
          authKind: 'oauth_device',
          authStatus: 'ready',
          accountLabel: null,
          authError: null,
          baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
          apiKey: 'github_pat_123',
          defaultModel: 'bad model',
        },
      ],
    }),
    ).rejects.toThrow('GitHub Copilot Tab 只支持当前允许的模型族');
  });

  it('schedules qqbot.target restart through a transient user unit', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');
    const execFile = vi
      .fn()
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
      'systemd-run',
      ['--user', '--quiet', '--on-active=1s', expect.stringMatching(/^--unit=qqbot-target-restart-\d+$/), 'systemctl', '--user', 'restart', 'qqbot.target'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'systemctl',
      ['--user', 'show', 'qqbot.target', '--property', 'Description,LoadState,ActiveState,SubState,UnitFileState'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(status.activeState).toBe('active');
  });

  it('schedules qqbot-koishi.service restart through a transient user unit', async () => {
    const dir = createTempDir();
    const envFilePath = join(dir, '.env.local');
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        stdout: [
          'Description=QQBot Koishi Service',
          'LoadState=loaded',
          'ActiveState=active',
          'SubState=running',
          'UnitFileState=enabled',
        ].join('\n'),
        stderr: '',
      });

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, execFile });
    const status = await manager.runServiceAction('qqbot-koishi.service', 'restart');

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'systemd-run',
      ['--user', '--quiet', '--on-active=1s', expect.stringMatching(/^--unit=qqbot-koishi-service-restart-\d+$/), 'systemctl', '--user', 'restart', 'qqbot-koishi.service'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      'systemctl',
      ['--user', 'show', 'qqbot-koishi.service', '--property', 'Description,LoadState,ActiveState,SubState,UnitFileState'],
      expect.objectContaining({ cwd: dir, timeout: 15_000 }),
    );
    expect(status.activeState).toBe('active');
  });

  it('persists custom preset order and removes deleted presets from it', async () => {
    const dir = createTempDir();
    const presetDir = join(dir, 'data/chathub/presets');
    const envFilePath = join(dir, '.env.local');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(envFilePath, 'CHATLUNA_DEFAULT_PRESET=sakiko\n', 'utf8');
    await Promise.all([
      writeFile(join(presetDir, 'catgirl.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: catgirl\n', 'utf8'),
      writeFile(join(presetDir, 'empty.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: empty\n', 'utf8'),
      writeFile(join(presetDir, 'sakiko.yml'), 'keywords: []\nprompts:\n  - role: system\n    content: sakiko\n', 'utf8'),
    ]);

    const manager = new BotConsoleManager({ rootDir: dir, envFilePath, presetDirPath: presetDir });
    await expect(manager.reorderPresets(['sakiko', 'catgirl', 'empty'])).resolves.toEqual([
      expect.objectContaining({ name: 'sakiko' }),
      expect.objectContaining({ name: 'catgirl' }),
      expect.objectContaining({ name: 'empty' }),
    ]);

    await manager.deletePreset('catgirl', 'sakiko');
    await expect(manager.listPresetSummaries()).resolves.toEqual([
      expect.objectContaining({ name: 'sakiko' }),
      expect.objectContaining({ name: 'empty' }),
    ]);
  });
});
