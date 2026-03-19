import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    expect(addListener).toHaveBeenCalledTimes(7);
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
});
