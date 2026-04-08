import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotConsoleManager } from '../src/plugins/bot-console/server.js';

vi.mock('@koishijs/plugin-console', () => ({}));
vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
    role: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
    role: () => createSchemaNode(),
  });

  class MockLogger {
    info(): void {}
    warn(): void {}
    error(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      boolean: () => createSchemaNode(),
      string: () => createSchemaNode(),
      natural: () => createSchemaNode(),
      number: () => createSchemaNode(),
    },
  };
});

import { apply } from '../src/plugins/bot-console/index.js';

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
    writeFileSync(join(dir, '.env.local'), 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');
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
    expect(addListener).toHaveBeenCalledTimes(20);
    for (const call of addListener.mock.calls) {
      expect(call[2]).toEqual({ authority: 4 });
    }
  });

  it('syncs chatluna-agent config on plugin startup', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
    writeFileSync(
      join(dir, '.env.local'),
      'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\nCHATLUNA_COMMON_FS=true\nCHATLUNA_COMMON_FS_SCOPE_PATH=~/system\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'data/chathub/presets/sakiko.yml'),
      'keywords: []\nprompts:\n  - role: system\n    content: hi\n',
      'utf8',
    );

    apply({
      baseDir: dir,
      console: {
        addEntry: vi.fn(),
        addListener: vi.fn(),
      },
    } as any);

    const config = JSON.parse(readFileSync(join(dir, 'data/chatluna/agent/config.json'), 'utf8'));
    expect(config.computer.local.enabled).toBe(true);
    expect(config.computer.local.scopePath).toContain('/system');
    expect(config.computer.local.approvalMode).toBe('never');
  });

  it('rejects unsupported env writes through the save-env listener', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');
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

  it('routes built-in model tab saves to the bot console manager', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');
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

    const saveModelTabsListener = addListener.mock.calls.find((call) => call[0] === 'bot-console/save-model-tabs')?.[1];
    expect(saveModelTabsListener).toBeTypeOf('function');

    const result = await saveModelTabsListener({
      activeTab: 'openai',
      tabs: [
        {
          id: 'siliconflow',
          title: '硅基流动',
          provider: 'siliconflow',
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-kimi',
          defaultModel: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
        },
        {
          id: 'openai',
          title: 'OpenAI',
          provider: 'openai',
          baseUrl: 'https://shell.wyzai.top/v1',
          apiKey: 'sk-openai',
          defaultModel: 'openai/gpt-5.4-medium-thinking',
        },
        {
          id: 'copilot',
          title: 'GitHub Copilot',
          provider: 'openai',
          baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
          apiKey: 'github_pat_123',
          defaultModel: 'openai/gpt-5.4-mini',
        },
      ],
    });

    expect(result).toMatchObject({
      restartRequired: true,
      modelTabs: expect.objectContaining({
        activeTab: 'openai',
      }),
      env: expect.objectContaining({
        CHATLUNA_PLATFORM: 'openai',
        CHATLUNA_DEFAULT_MODEL: 'openai/gpt-5.4-medium-thinking',
      }),
    });
  });

  it('includes runtime memory status in get-state payload when the service is available', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');
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
      featurePolicy: {
        listConsoleFeatureScopes: vi.fn().mockResolvedValue([
          {
            scopeKind: 'private_default',
            scopeId: 'private-default',
            roomId: null,
            roomName: '所有私聊',
            groupId: null,
            conversationId: null,
            visibility: 'private',
            updatedAt: null,
          },
        ]),
        getFeatureOverrides: vi.fn().mockResolvedValue([]),
        listConversationTargets: vi.fn().mockResolvedValue([]),
      },
      toolPolicy: {
        getToolPolicyState: vi.fn().mockResolvedValue({
          catalog: [
            {
              toolName: 'web_search',
              title: '联网搜索',
              category: '网页与网络',
              description: 'desc',
              compatibility: 'conditional',
              compatibilityNote: 'note',
              hardDependencies: [],
              relatedTools: [],
              riskLevel: 'medium',
              source: 'project',
              availableRoutes: ['agent', 'automation'],
              defaultEnabledByRoute: { agent: true, automation: true },
            },
          ],
          routeProfiles: ['agent', 'automation'],
          routeProfileInfo: [{ id: 'agent', title: 'Agent 回复', description: 'desc' }],
          defaultScopes: [{ scopeKind: 'global_default', scopeId: 'global-default', title: '全局默认', description: 'desc' }],
          scopes: [],
          overrides: [],
          conversationTargets: [],
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
    expect(state.featureScopes).toEqual([
      expect.objectContaining({ scopeKind: 'private_default', scopeId: 'private-default' }),
    ]);
    expect(state.toolPolicy.catalog).toEqual([
      expect.objectContaining({ toolName: 'web_search', title: '联网搜索' }),
    ]);
  });

  it('routes manual probe requests to memory-v2 status service', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');
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

  it('exposes memory explorer data through a protected listener', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');
    writeFileSync(
      join(dir, 'data/chathub/presets/sakiko.yml'),
      'keywords: []\nprompts:\n  - role: system\n    content: hi\n',
      'utf8',
    );

    const addListener = vi.fn();
    apply({
      baseDir: dir,
      database: {
        get: vi.fn(async (table: string) => {
          if (table === 'memory_fact') {
            return [
              {
                id: 1,
                scopeType: 'user',
                scopeKey: 'onebot:bot:user:10001',
                kind: 'preference',
                topicKey: 'nickname',
                content: '用户更喜欢被叫小嘉。',
                keywords: '["昵称"]',
                importance: 0.8,
                confidence: 0.9,
                firstSeenAt: 1,
                lastSeenAt: 10,
                sourceMessageIds: '[]',
                embeddingModel: null,
                embedding: null,
                version: 1,
                archived: 0,
              },
            ];
          }
          if (table === 'memory_episode') {
            return [
              {
                id: 2,
                scopeType: 'user',
                scopeKey: 'onebot:bot:user:10001',
                title: '第一次晚安语音',
                summary: '用户第一次主动索要晚安语音。',
                keywords: '["晚安","语音"]',
                importance: 0.9,
                confidence: 0.95,
                periodStart: 3,
                periodEnd: 4,
                firstSeenAt: 3,
                lastSeenAt: 12,
                lastAccessedAt: 15,
                sourceMessageIds: '[]',
                embeddingModel: 'Qwen/Qwen3-Embedding-8B',
                embedding: '[1,2,3]',
                archived: 0,
              },
            ];
          }
          if (table === 'memory_job') {
            return [
              {
                id: 9,
                jobKey: 'extract:conv-1',
                jobType: 'extract',
                status: 'processing',
                payload: '{"conversationId":"conv-1","scopeType":"user","scopeKey":"onebot:bot:user:10001","maxMessages":12}',
                retryCount: 0,
                nextRunAt: 20,
                lastError: null,
                createdAt: 16,
                updatedAt: 18,
              },
            ];
          }
          return [];
        }),
      },
      console: {
        addEntry: vi.fn(),
        addListener,
      },
    } as any);

    const memoryListener = addListener.mock.calls.find((call) => call[0] === 'bot-console/get-memory-state')?.[1];
    expect(memoryListener).toBeTypeOf('function');

    const result = await memoryListener();
    expect(result.available).toBe(true);
    expect(result.summary).toEqual(
      expect.objectContaining({
        scopeCount: 1,
        profileItemCount: 1,
        episodeCount: 1,
        processingJobs: 1,
      }),
    );
    expect(result.scopes).toEqual([
      expect.objectContaining({
        scopeKey: 'onebot:bot:user:10001',
        label: '私聊用户 10001',
      }),
    ]);
    expect(result.jobs).toEqual([
      expect.objectContaining({
        scopeKey: 'onebot:bot:user:10001',
        conversationId: 'conv-1',
      }),
    ]);
  });

  it('routes scoped override and conversation clear listeners to feature policy service', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');
    writeFileSync(
      join(dir, 'data/chathub/presets/sakiko.yml'),
      'keywords: []\nprompts:\n  - role: system\n    content: hi\n',
      'utf8',
    );

    const saveFeatureOverrides = vi.fn().mockResolvedValue([
      {
        id: 1,
        featureKey: 'QQ_VOICE_INPUT_ENABLED',
        scopeKind: 'private_default',
        scopeId: 'private-default',
        enabled: 0,
        updatedAt: 1,
      },
    ]);
    const clearConversationHistory = vi.fn().mockResolvedValue({
      ok: true,
      roomId: 11,
      conversationId: 'conv-1',
      deletedMessages: 4,
      updatedAt: 2,
    });
    const deleteConversationRoom = vi.fn().mockResolvedValue({
      ok: true,
      roomId: 11,
      conversationId: 'conv-1',
      deletedMessages: 4,
      deletedConversation: true,
      deletedRoom: true,
      clearedDefaultUsers: 1,
      updatedAt: 3,
    });
    const saveToolOverrides = vi.fn().mockResolvedValue([
      {
        id: 9,
        toolName: 'web_post',
        routeProfile: 'agent',
        scopeKind: 'group',
        scopeId: '1091330365',
        enabled: 0,
        updatedAt: 4,
      },
    ]);
    const getToolPolicyState = vi.fn().mockResolvedValue({
      catalog: [],
      routeProfiles: [],
      routeProfileInfo: [],
      defaultScopes: [],
      scopes: [],
      overrides: [],
      conversationTargets: [],
    });

    const addListener = vi.fn();
    apply({
      baseDir: dir,
      featurePolicy: {
        saveFeatureOverrides,
        clearConversationHistory,
        deleteConversationRoom,
      },
      toolPolicy: {
        saveToolOverrides,
        getToolPolicyState,
      },
      console: {
        addEntry: vi.fn(),
        addListener,
      },
    } as any);

    const saveOverridesListener = addListener.mock.calls.find((call) => call[0] === 'bot-console/save-feature-overrides')?.[1];
    await expect(
      saveOverridesListener({
        overrides: [{ featureKey: 'QQ_VOICE_INPUT_ENABLED', scopeKind: 'private_default', scopeId: 'private-default', enabled: false }],
      }),
    ).resolves.toEqual({
      overrides: [
        expect.objectContaining({ featureKey: 'QQ_VOICE_INPUT_ENABLED', scopeKind: 'private_default', scopeId: 'private-default' }),
      ],
    });
    expect(saveFeatureOverrides).toHaveBeenCalledTimes(1);

    const getToolPolicyListener = addListener.mock.calls.find((call) => call[0] === 'bot-console/get-tool-policy-state')?.[1];
    await expect(getToolPolicyListener()).resolves.toEqual({
      catalog: [],
      routeProfiles: [],
      routeProfileInfo: [],
      defaultScopes: [],
      scopes: [],
      overrides: [],
      conversationTargets: [],
    });
    expect(getToolPolicyState).toHaveBeenCalledTimes(1);

    const saveToolOverridesListener = addListener.mock.calls.find((call) => call[0] === 'bot-console/save-tool-overrides')?.[1];
      await expect(
      saveToolOverridesListener({
        overrides: [{ toolName: 'web_post', routeProfile: 'agent', scopeKind: 'group', scopeId: '1091330365', enabled: false }],
      }),
    ).resolves.toEqual({
      overrides: [
        expect.objectContaining({ toolName: 'web_post', routeProfile: 'agent', scopeKind: 'group', scopeId: '1091330365' }),
      ],
    });
    expect(saveToolOverrides).toHaveBeenCalledTimes(1);

    const clearListener = addListener.mock.calls.find((call) => call[0] === 'bot-console/clear-conversation-history')?.[1];
    await expect(clearListener({ roomId: 11, conversationId: 'conv-1' })).resolves.toEqual({
      result: expect.objectContaining({ ok: true, roomId: 11, conversationId: 'conv-1', deletedMessages: 4 }),
    });
    expect(clearConversationHistory).toHaveBeenCalledWith({ roomId: 11, conversationId: 'conv-1' });

    const deleteListener = addListener.mock.calls.find((call) => call[0] === 'bot-console/delete-conversation-room')?.[1];
    await expect(deleteListener({ roomId: 11, conversationId: 'conv-1' })).resolves.toEqual({
      result: expect.objectContaining({
        ok: true,
        roomId: 11,
        conversationId: 'conv-1',
        deletedMessages: 4,
        deletedRoom: true,
        clearedDefaultUsers: 1,
      }),
    });
    expect(deleteConversationRoom).toHaveBeenCalledWith({ roomId: 11, conversationId: 'conv-1' });
  });

  it('routes preset reorder listener to bot console manager', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'data/chathub/presets'), { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'CHATLUNA_DEFAULT_MODEL=siliconflow/Pro/moonshotai/Kimi-K2.5\n', 'utf8');
    writeFileSync(
      join(dir, 'data/chathub/presets/sakiko.yml'),
      'keywords: []\nprompts:\n  - role: system\n    content: hi\n',
      'utf8',
    );

    const reorderPresetsSpy = vi
      .spyOn(BotConsoleManager.prototype, 'reorderPresets')
      .mockResolvedValue([{ name: 'sakiko', path: join(dir, 'data/chathub/presets/sakiko.yml'), source: 'runtime' }]);

    const addListener = vi.fn();
    apply({
      baseDir: dir,
      console: {
        addEntry: vi.fn(),
        addListener,
      },
    } as any);

    const reorderListener = addListener.mock.calls.find((call) => call[0] === 'bot-console/reorder-presets')?.[1];
    await expect(reorderListener({ names: ['sakiko'] })).resolves.toEqual({
      presets: [{ name: 'sakiko', path: join(dir, 'data/chathub/presets/sakiko.yml'), source: 'runtime' }],
    });
    expect(reorderPresetsSpy).toHaveBeenCalledWith(['sakiko']);
    reorderPresetsSpy.mockRestore();
  });
});
