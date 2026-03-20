import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotConsoleManager } from '../src/plugins/bot-console-core.js';

vi.mock('@koishijs/plugin-console', () => ({}));
vi.mock('koishi', () => {
  class MockLogger {
    info(): void {}
    warn(): void {}
    error(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
  };
});

import { apply } from '../src/plugins/bot-console.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-bot-console-plugin-'));
  tempDirs.push(dir);
  return dir;
}

describe('bot-console plugin', () => {
  it('registers console entry and protected listeners', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'OPENAI_MODEL=deepseek/deepseek-chat\n', 'utf8');
    writeFileSync(
      join(dir, 'data/chathub/presets/sakiko.yml'),
      'keywords: []\nprompts:\n  - role: system\n    content: hi\n',
      'utf8',
    );

    const addEntry = vi.fn();
    const addListener = vi.fn();
    const ctx = {
      baseDir: dir,
      console: {
        addEntry,
        addListener,
      },
    };

    apply(ctx as any);

    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(addListener).toHaveBeenCalledTimes(8);
    for (const call of addListener.mock.calls) {
      expect(call[2]).toEqual({ authority: 4 });
    }
  });

  it('rejects unsupported env writes through the save-env listener', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'OPENAI_MODEL=deepseek/deepseek-chat\n', 'utf8');
    writeFileSync(
      join(dir, 'data/chathub/presets/sakiko.yml'),
      'keywords: []\nprompts:\n  - role: system\n    content: hi\n',
      'utf8',
    );

    const addListener = vi.fn();
    apply({
      baseDir: dir,
      console: {
        addEntry: vi.fn(),
        addListener,
      },
    } as any);

    const saveEnvListener = addListener.mock.calls.find((call) => call[0] === 'bot-console/save-env')?.[1];
    expect(saveEnvListener).toBeTypeOf('function');
    await expect(saveEnvListener({ HACKED: '1' })).rejects.toThrow('不支持这个配置项');
  });

  it('includes runtime memory status in get-state payload when the service is available', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'OPENAI_MODEL=deepseek/deepseek-chat\n', 'utf8');
    writeFileSync(
      join(dir, 'data/chathub/presets/sakiko.yml'),
      'keywords: []\nprompts:\n  - role: system\n    content: hi\n',
      'utf8',
    );

    const addListener = vi.fn();
    apply({
      baseDir: dir,
      memoryV2Status: {
        getSnapshot: vi.fn().mockResolvedValue({
          available: true,
          enabled: true,
          extractConfigured: true,
          embedConfigured: true,
          extractModel: 'deepseek/deepseek-chat',
          embedBaseUrl: 'https://api.siliconflow.cn/v1',
          embedModel: 'Qwen/Qwen3-Embedding-8B',
          jobs: { extractPending: 1, extractProcessing: 0, embedPending: 2, embedProcessing: 1 },
          lastArchiveAt: null,
          extract: {
            configured: true,
            state: 'never',
            lastSource: null,
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastLatencyMs: null,
            lastError: null,
            consecutiveFailures: 0,
          },
          embed: {
            configured: true,
            state: 'success',
            lastSource: 'runtime',
            lastAttemptAt: 1,
            lastSuccessAt: 1,
            lastFailureAt: null,
            lastLatencyMs: 22,
            lastError: null,
            consecutiveFailures: 0,
          },
        }),
      },
      console: {
        addEntry: vi.fn(),
        addListener,
      },
    } as any);

    const getStateListener = addListener.mock.calls.find((call) => call[0] === 'bot-console/get-state')?.[1];
    const state = await getStateListener();
    expect(state.runtimeStatus.memoryV2.embedModel).toBe('Qwen/Qwen3-Embedding-8B');
    expect(state.runtimeStatus.memoryV2.jobs.embedPending).toBe(2);
  });

  it('routes manual probe requests to memory-v2 status service', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'OPENAI_MODEL=deepseek/deepseek-chat\n', 'utf8');
    writeFileSync(
      join(dir, 'data/chathub/presets/sakiko.yml'),
      'keywords: []\nprompts:\n  - role: system\n    content: hi\n',
      'utf8',
    );

    const probeEmbedding = vi.fn().mockResolvedValue({
      target: 'embedding',
      ok: true,
      checkedAt: 1,
      latencyMs: 33,
      error: null,
      snapshot: {
        available: true,
        enabled: true,
        extractConfigured: true,
        embedConfigured: true,
        extractModel: 'deepseek/deepseek-chat',
        embedBaseUrl: 'https://api.siliconflow.cn/v1',
        embedModel: 'Qwen/Qwen3-Embedding-8B',
        jobs: { extractPending: 0, extractProcessing: 0, embedPending: 0, embedProcessing: 0 },
        lastArchiveAt: null,
        extract: {
          configured: true,
          state: 'never',
          lastSource: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastLatencyMs: null,
          lastError: null,
          consecutiveFailures: 0,
        },
        embed: {
          configured: true,
          state: 'success',
          lastSource: 'probe',
          lastAttemptAt: 1,
          lastSuccessAt: 1,
          lastFailureAt: null,
          lastLatencyMs: 33,
          lastError: null,
          consecutiveFailures: 0,
        },
      },
    });

    const addListener = vi.fn();
    apply({
      baseDir: dir,
      memoryV2Status: {
        getSnapshot: vi.fn(),
        probeEmbedding,
      },
      console: {
        addEntry: vi.fn(),
        addListener,
      },
    } as any);

    const probeListener = addListener.mock.calls.find((call) => call[0] === 'bot-console/run-status-probe')?.[1];
    const result = await probeListener('embedding');
    expect(probeEmbedding).toHaveBeenCalledTimes(1);
    expect(result.memoryV2.ok).toBe(true);
    expect(result.memoryV2.snapshot.embed.lastSource).toBe('probe');
  });

  it('returns recent koishi logs through the protected listener', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'OPENAI_MODEL=deepseek/deepseek-chat\n', 'utf8');
    writeFileSync(
      join(dir, 'data/chathub/presets/sakiko.yml'),
      'keywords: []\nprompts:\n  - role: system\n    content: hi\n',
      'utf8',
    );

    const getRecentLogsSpy = vi
      .spyOn(BotConsoleManager.prototype, 'getRecentLogs')
      .mockResolvedValue(['2026-03-20 16:00:00 [I] bot-console test']);

    const addListener = vi.fn();
    apply({
      baseDir: dir,
      console: {
        addEntry: vi.fn(),
        addListener,
      },
    } as any);

    const getRecentLogsListener = addListener.mock.calls.find((call) => call[0] === 'bot-console/get-recent-logs')?.[1];
    expect(getRecentLogsListener).toBeTypeOf('function');
    await expect(getRecentLogsListener()).resolves.toEqual({
      lines: ['2026-03-20 16:00:00 [I] bot-console test'],
    });
    expect(getRecentLogsSpy).toHaveBeenCalledTimes(1);
    getRecentLogsSpy.mockRestore();
  });
});
