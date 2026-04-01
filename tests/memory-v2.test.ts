import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => ({
  Context: class {},
  Session: class {},
  Logger: class {
    warn(): void {}
    debug(): void {}
  },
}));

import { MemoryV2StatusService, createUnavailableMemoryV2StatusSnapshot } from '../src/plugins/memory/status.js';
import {
  embedTexts,
  extractLongMemory,
  parseExtractionResponse,
  type MemoryEmbedRuntime,
} from '../src/plugins/memory/llm.js';
import {
  buildMemoryContextBlock,
  buildMemoryDocuments,
  decodeStoredMessageText,
  mergeFactRecord,
  MemoryV2Store,
  planMemoryRecall,
  rankMemoryDocumentsByVector,
} from '../src/plugins/memory/store.js';
import type { MemoryEpisodeRecord, MemoryFactRecord } from '../src/types/memory-v2.js';

vi.mock('koishi-plugin-chatluna/utils/string', async () => {
  const { gunzipSync } = await import('node:zlib');
  return {
    async gzipDecode(input: ArrayBuffer): Promise<string> {
      return gunzipSync(Buffer.from(input)).toString('utf8');
    },
  };
});

function createFact(partial: Partial<MemoryFactRecord>): MemoryFactRecord {
  return {
    id: 1,
    scopeType: 'user',
    scopeKey: 'onebot:bot:user:123',
    kind: 'preference',
    topicKey: 'preference-music',
    content: '用户更喜欢听少女乐队题材的歌。',
    keywords: JSON.stringify(['少女乐队', '音乐']),
    importance: 0.7,
    confidence: 0.9,
    firstSeenAt: Date.now() - 10_000,
    lastSeenAt: Date.now() - 5_000,
    sourceMessageIds: JSON.stringify(['a']),
    embeddingModel: 'Qwen/Qwen3-Embedding-8B',
    embedding: JSON.stringify([1, 0]),
    version: 1,
    archived: 0,
    ...partial,
  };
}

function createEpisode(partial: Partial<MemoryEpisodeRecord>): MemoryEpisodeRecord {
  return {
    id: 2,
    scopeType: 'user',
    scopeKey: 'onebot:bot:user:123',
    title: '上个月准备比赛',
    summary: '上个月用户一直在准备乐队比赛，反复提过排练和曲目安排。',
    keywords: JSON.stringify(['上个月', '比赛', '排练']),
    importance: 0.82,
    confidence: 0.88,
    periodStart: new Date('2026-02-01T00:00:00+08:00').getTime(),
    periodEnd: new Date('2026-02-28T23:59:59+08:00').getTime(),
    firstSeenAt: Date.now() - 8 * 24 * 3600_000,
    lastSeenAt: Date.now() - 2 * 24 * 3600_000,
    lastAccessedAt: Date.now() - 24 * 3600_000,
    sourceMessageIds: JSON.stringify(['b']),
    embeddingModel: 'Qwen/Qwen3-Embedding-8B',
    embedding: JSON.stringify([0.9, 0.1]),
    archived: 0,
    ...partial,
  };
}

function encodeStoredContent(content: unknown): ArrayBuffer {
  const buffer = gzipSync(Buffer.from(JSON.stringify(content), 'utf8'));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

type MemoryTableName =
  | 'chathub_conversation'
  | 'chathub_message'
  | 'memory_fact'
  | 'memory_episode'
  | 'memory_job';

type MemoryRow = Record<string, any>;

class MemoryStoreDatabaseMock {
  constructor(
    tables: Partial<Record<MemoryTableName, MemoryRow[]>> = {},
  ) {
    this.tables = {
      chathub_conversation: [],
      chathub_message: [],
      memory_fact: [],
      memory_episode: [],
      memory_job: [],
      ...tables,
    };
  }

  private readonly tables: Record<MemoryTableName, MemoryRow[]>;

  async get(table: string, query: Record<string, unknown>): Promise<MemoryRow[]> {
    const rows = this.tables[table as MemoryTableName] ?? [];
    return rows
      .filter((row) => Object.entries(query).every(([key, value]) => row[key] === value))
      .map((row) => ({ ...row }));
  }

  async set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<void> {
    const rows = this.tables[table as MemoryTableName] ?? [];
    for (const row of rows) {
      if (Object.entries(query).every(([key, value]) => row[key] === value)) {
        Object.assign(row, data);
      }
    }
  }

  async upsert(): Promise<void> {}

  async create(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.tables[table as MemoryTableName]?.push({ ...row });
    return row;
  }

  async remove(table: string, query: Record<string, unknown>): Promise<void> {
    const rows = this.tables[table as MemoryTableName] ?? [];
    this.tables[table as MemoryTableName] = rows.filter(
      (row) => !Object.entries(query).every(([key, value]) => row[key] === value),
    );
  }
}

describe('memory-v2 core behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not request semantic recall for ordinary chat without coarse hits', () => {
    const documents = buildMemoryDocuments([createFact({})], []);
    const plan = planMemoryRecall('今天天气怎么样', documents, Date.now(), 8);
    expect(plan.candidates).toHaveLength(0);
    expect(plan.needsSemanticSearch).toBe(false);
  });

  it('requests semantic recall when the user explicitly asks about the past', () => {
    const documents = buildMemoryDocuments([createFact({})], []);
    const plan = planMemoryRecall('你还记得上个月那件事吗', documents, Date.now(), 8);
    expect(plan.needsSemanticSearch).toBe(true);
    expect(plan.explicitRecallCue).toBe(true);
  });

  it('ranks the most similar past episode by vector similarity', () => {
    const docs = buildMemoryDocuments(
      [createFact({ id: 1, embedding: JSON.stringify([1, 0]) })],
      [
        createEpisode({ id: 2, embedding: JSON.stringify([0.95, 0.05]) }),
        createEpisode({
          id: 3,
          title: '去年换工作',
          summary: '去年用户在考虑换工作。',
          keywords: JSON.stringify(['去年', '工作']),
          embedding: JSON.stringify([0.05, 0.95]),
        }),
      ],
    );
    const ranked = rankMemoryDocumentsByVector(docs, [1, 0], Date.now(), 3);
    expect(ranked[0]?.recordId).toBe(2);
  });

  it('builds a stable context block grouped by facts and episodes', () => {
    const prompt = buildMemoryContextBlock([createFact({})], [createEpisode({})], 1200);
    expect(prompt).toContain('Relevant Long-Term Memory');
    expect(prompt).toContain('User Profile:');
    expect(prompt).toContain('Relevant Past Episodes:');
  });

  it('merges repeated fact updates into one evolving fact row', () => {
    const now = Date.now();
    const merged = mergeFactRecord(
      createFact({
        kind: 'plan',
        topicKey: 'plan-travel',
        content: '用户计划五月去上海。',
        keywords: JSON.stringify(['旅行', '上海']),
        version: 2,
      }),
      {
        subject: 'user',
        kind: 'plan',
        topicKey: 'plan-travel',
        content: '用户计划五月去上海看演出。',
        keywords: ['旅行', '上海', '演出'],
        importance: 0.85,
        confidence: 0.91,
      },
      now,
      ['m3'],
    );

    expect(merged.topicKey).toBe('plan-travel');
    expect(merged.content).toContain('看演出');
    expect(merged.keywords).toContain('演出');
    expect(merged.version).toBe(3);
  });

  it('rejects fenced extraction json and only accepts strict JSON', () => {
    const parsed = parseExtractionResponse(
      [
        '```json',
        '{"profile_items":[{"subject":"user","kind":"plan","topicKey":"plan-travel","content":"用户准备五月去上海看演出","keywords":["上海","演出"],"importance":0.9,"confidence":0.8}],"episodes":[],"drop":[]}',
        '```',
      ].join('\n'),
    );

    expect(parsed).toBeNull();
  });

  it('drops assistant-only profile items and preserves user-facing profile items', () => {
    const parsed = parseExtractionResponse(JSON.stringify({
      profile_items: [
        {
          subject: 'user',
          kind: 'trait',
          topicKey: 'boundary-name-test',
          content: '用户🥚会反复用“读名字”验证我发音，属于试探边界的行为模式。',
          keywords: ['读名字', '试探'],
          importance: 0.92,
          confidence: 0.9,
        },
        {
          subject: 'user',
          kind: 'preference',
          topicKey: 'assistant-music',
          content: '助手对音乐及 Ave Mujica 演出感兴趣。',
          keywords: ['音乐'],
          importance: 0.8,
          confidence: 0.8,
        },
      ],
      episodes: [],
      drop: [],
    }));

    expect(parsed?.profileItems).toEqual([
      expect.objectContaining({
        kind: 'trait',
        content: '用户🥚会反复用“读名字”验证我发音，属于试探边界的行为模式。',
      }),
    ]);
  });

  it('keeps user-related episodes that use bot-first wording and drops assistant-only episodes', () => {
    const parsed = parseExtractionResponse(JSON.stringify({
      profile_items: [],
      episodes: [
        {
          subject: 'user',
          title: '名字发音测试',
          summary: '我被用户反复要求读名字，以测试我的发音是否稳定。',
          keywords: ['读名字', '发音'],
          importance: 0.86,
          confidence: 0.88,
          periodStart: '2026-03-30',
          periodEnd: '2026-03-30',
        },
        {
          subject: 'user',
          title: '助手兴趣',
          summary: '助手最近更喜欢 Ave Mujica 的音乐。',
          keywords: ['音乐'],
          importance: 0.7,
          confidence: 0.8,
          periodStart: null,
          periodEnd: null,
        },
      ],
      drop: [],
    }));

    expect(parsed?.episodes).toEqual([
      expect.objectContaining({
        title: '名字发音测试',
        summary: '我被用户反复要求读名字，以测试我的发音是否稳定。',
      }),
    ]);
  });

  it('calls memory extraction with json_schema structured output and minimal prompt injection', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"profile_items":[],"episodes":[],"drop":[]}',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      extractLongMemory(
        {
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-test',
          model: 'moonshotai/Kimi-K2-Instruct-0905',
          timeoutMs: 5000,
        },
        [
          { id: 'm1', role: 'human', text: '我好像每天都睡得很晚。' },
          { id: 'm2', role: 'ai', text: '这样对身体不太好。' },
        ],
      ),
    ).resolves.toEqual({ profileItems: [], episodes: [], drop: [] });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body =
      init && typeof init === 'object' && 'body' in init && typeof init.body === 'string'
        ? JSON.parse(init.body)
        : null;

    expect(body?.response_format?.type).toBe('json_schema');
    expect(body?.response_format?.json_schema?.name).toBe('memory_extraction_v1');
    expect(body?.response_format?.json_schema?.strict).toBe(true);
    expect(body?.response_format?.json_schema?.schema?.properties?.profile_items?.description).toContain('绝不记录只关于我的');
    expect(body?.messages?.[0]?.content).toBe('请根据提供的 schema 提取我对用户的长期记忆。');
    expect(body?.messages?.[1]?.content).toContain('对话记录：');
    expect(body?.messages?.[1]?.content).toContain('坏例：');
    expect(body?.messages?.[1]?.content).toContain('好例：');
  });

  it('calls SiliconFlow embeddings with batched input', async () => {
    const runtime: MemoryEmbedRuntime = {
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'sk-test',
      model: 'Qwen/Qwen3-Embedding-8B',
      timeoutMs: 5000,
    };

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [1, 2, 3] },
            { index: 1, embedding: [4, 5, 6] },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const vectors = await embedTexts(runtime, ['第一条', '第二条']);
    expect(vectors).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body =
      init && typeof init === 'object' && 'body' in init && typeof init.body === 'string'
        ? JSON.parse(init.body)
        : null;
    expect(body?.model).toBe('Qwen/Qwen3-Embedding-8B');
    expect(body?.input).toEqual(['第一条', '第二条']);
  });
});

describe('memory-v2 stored content extraction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts text from stored string content', async () => {
    await expect(decodeStoredMessageText(encodeStoredContent('用户喜欢蓝莓芝士贝果。'))).resolves.toBe('用户喜欢蓝莓芝士贝果。');
  });

  it('joins multiple text parts and ignores non-text parts', async () => {
    await expect(
      decodeStoredMessageText(
        encodeStoredContent([
          { type: 'text', text: '第一句。' },
          { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
          { type: 'text', text: '第二句。' },
        ]),
      ),
    ).resolves.toBe('第一句。第二句。');
  });

  it('returns empty text for attachment-only content', async () => {
    await expect(
      decodeStoredMessageText(
        encodeStoredContent([
          { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
          { type: 'audio_url', audio_url: { url: 'https://example.com/1.mp3' } },
        ]),
      ),
    ).resolves.toBe('');
  });

  it('treats malformed stored content as invalid', async () => {
    const invalid = Buffer.from('not-gzip', 'utf8').buffer.slice(0) as ArrayBuffer;
    await expect(decodeStoredMessageText(invalid)).rejects.toThrow();
  });

  it('reads only text turns from stored conversation content', async () => {
    const store = new MemoryV2Store(
      new MemoryStoreDatabaseMock({
        chathub_conversation: [
          {
            id: 'conversation-1',
            latestId: 'm4',
          },
        ],
        chathub_message: [
          {
            id: 'm1',
            conversation: 'conversation-1',
            parent: null,
            role: 'human',
            content: encodeStoredContent([{ type: 'text', text: '我最喜欢蓝莓芝士贝果。' }]),
          },
          {
            id: 'm2',
            conversation: 'conversation-1',
            parent: 'm1',
            role: 'ai',
            content: encodeStoredContent([{ type: 'image_url', image_url: { url: 'https://example.com/2.png' } }]),
          },
          {
            id: 'm3',
            conversation: 'conversation-1',
            parent: 'm2',
            role: 'human',
            content: encodeStoredContent([{ type: 'text', text: '明天提醒我买贝果。' }]),
          },
          {
            id: 'm4',
            conversation: 'conversation-1',
            parent: 'm3',
            role: 'ai',
            content: encodeStoredContent('收到，我明天再提醒你。'),
          },
        ],
      }) as any,
    );

    await expect(store.readConversationWindow('conversation-1', 6)).resolves.toEqual([
      {
        id: 'm1',
        role: 'human',
        text: '我最喜欢蓝莓芝士贝果。',
      },
      {
        id: 'm3',
        role: 'human',
        text: '明天提醒我买贝果。',
      },
      {
        id: 'm4',
        role: 'ai',
        text: '收到，我明天再提醒你。',
      },
    ]);
  });
});

describe('memory-v2 extraction persistence', () => {
  it('stores profile items without creating embedding jobs and keeps episodes vectorized', async () => {
    const store = new MemoryV2Store(new MemoryStoreDatabaseMock() as any);

    await store.applyExtraction(
      {
        scopeType: 'user',
        scopeKey: 'onebot:bot:user:123',
      },
      {
        profileItems: [
          {
            subject: 'user',
            kind: 'trait',
            topicKey: 'boundary-name-test',
            content: '用户会反复用“读名字”验证我发音，属于试探边界的行为模式。',
            keywords: ['读名字', '试探'],
            importance: 0.92,
            confidence: 0.91,
          },
        ],
        episodes: [
          {
            subject: 'user',
            title: '名字发音测试',
            summary: '我被用户反复要求读名字，以测试我的发音是否稳定。',
            keywords: ['读名字', '发音'],
            importance: 0.8,
            confidence: 0.84,
            periodStart: '2026-03-30',
            periodEnd: '2026-03-30',
          },
        ],
        drop: [],
      },
      ['m1', 'm2'],
    );

    const rows = await (store as any).database.get('memory_fact', {} as Record<string, never>);
    const jobs = await (store as any).database.get('memory_job', {} as Record<string, never>);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'trait',
        content: '用户会反复用“读名字”验证我发音，属于试探边界的行为模式。',
        embedding: null,
        embeddingModel: null,
      }),
    ]);
    expect(jobs).toEqual([
      expect.objectContaining({
        jobType: 'embed',
        payload: expect.stringContaining('"recordType":"episode"'),
      }),
    ]);
  });

  it('merges profile items by kind and topic key', async () => {
    const store = new MemoryV2Store(
      new MemoryStoreDatabaseMock({
        memory_fact: [
          createFact({
            id: 7,
            kind: 'preference',
            topicKey: 'preferred-name',
            content: '用户更喜欢被叫小嘉。',
            version: 2,
          }),
        ],
      }) as any,
    );

    await store.applyExtraction(
      {
        scopeType: 'user',
        scopeKey: 'onebot:bot:user:123',
      },
      {
        profileItems: [
          {
            subject: 'user',
            kind: 'preference',
            topicKey: 'preferred-name',
            content: '用户更喜欢我叫她小嘉。',
            keywords: ['昵称'],
            importance: 0.88,
            confidence: 0.93,
          },
        ],
        episodes: [],
        drop: [],
      },
      ['m3'],
    );

    const rows = await (store as any).database.get('memory_fact', {} as Record<string, never>);
    expect(rows).toEqual([
      expect.objectContaining({
        id: 7,
        kind: 'preference',
        topicKey: 'preferred-name',
        content: '用户更喜欢我叫她小嘉。',
        version: 3,
      }),
    ]);
  });
});

describe('memory-v2 configuration cleanup', () => {
  it('registers the new plugin and removes old long-memory plugins from koishi.yml', () => {
    const content = readFileSync(resolve(process.cwd(), 'koishi.yml'), 'utf8');
    expect(content).toContain('./dist/plugins/memory:memory-v2:');
    expect(content).not.toContain('chatluna-ollama-adapter');
    expect(content).not.toContain('chatluna-long-memory');
    expect(content).not.toContain('chatluna-vector-store-service');
  });

  it('removes ollama from compose and documents SiliconFlow env in templates', () => {
    const composeContent = readFileSync(resolve(process.cwd(), 'compose.yaml'), 'utf8');
    const envContent = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');
    const serverEnvContent = readFileSync(resolve(process.cwd(), '.env.server.example'), 'utf8');

    expect(composeContent).not.toContain('ollama:');
    expect(composeContent).not.toContain('OLLAMA_PORT');
    expect(envContent).toContain('MEMORY_EMBED_BASE_URL=https://api.siliconflow.cn/v1');
    expect(envContent).toContain('MEMORY_EMBED_MODEL=Qwen/Qwen3-Embedding-8B');
    expect(serverEnvContent).toContain('MEMORY_EXTRACT_BASE_URL=https://api.siliconflow.cn/v1');
    expect(serverEnvContent).toContain('MEMORY_EXTRACT_MODEL=moonshotai/Kimi-K2-Instruct-0905');
    expect(serverEnvContent).not.toContain('CHATLUNA_LONG_MEMORY_EXTRACT_MODEL');
  });
});

describe('memory-v2 status service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tracks runtime success/failure and exposes queue summary', async () => {
    const service = new MemoryV2StatusService(
      {
        enabled: true,
        extract: {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-test',
          model: 'deepseek-chat',
          timeoutMs: 15000,
        },
        embed: {
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-test',
          model: 'Qwen/Qwen3-Embedding-8B',
          timeoutMs: 12000,
        },
      },
      {
        getJobSummary: async () => ({
          extractPending: 2,
          extractProcessing: 1,
          embedPending: 3,
          embedProcessing: 0,
        }),
      } as any,
      async () => undefined,
    );

    service.recordAttempt('extract', 'runtime', 100);
    service.recordFailure('extract', 'runtime', new Error('extract boom'), 25, 125);
    service.recordSuccess('embed', 'runtime', 40, 200);
    service.recordArchive(300);

    const snapshot = await service.getSnapshot();
    expect(snapshot.jobs.extractPending).toBe(2);
    expect(snapshot.extract.state).toBe('failed');
    expect(snapshot.extract.lastError).toContain('extract boom');
    expect(snapshot.embed.state).toBe('success');
    expect(snapshot.lastArchiveAt).toBe(300);
  });

  it('marks manual embedding probes as probe results', async () => {
    const service = new MemoryV2StatusService(
      {
        enabled: true,
        extract: {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-test',
          model: 'deepseek-chat',
          timeoutMs: 15000,
        },
        embed: {
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-test',
          model: 'Qwen/Qwen3-Embedding-8B',
          timeoutMs: 12000,
        },
      },
      {
        getJobSummary: async () => ({
          extractPending: 0,
          extractProcessing: 0,
          embedPending: 0,
          embedProcessing: 0,
        }),
      } as any,
      async () => undefined,
    );

    const result = await service.probeEmbedding();
    expect(result.ok).toBe(true);
    expect(result.snapshot.embed.lastSource).toBe('probe');
    expect(result.snapshot.embed.state).toBe('success');
  });

  it('returns an unavailable snapshot fallback', () => {
    const snapshot = createUnavailableMemoryV2StatusSnapshot();
    expect(snapshot.available).toBe(false);
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.embedConfigured).toBe(false);
  });
});

describe('memory-v2 job recovery', () => {
  it('requeues orphaned processing jobs on startup recovery', async () => {
    const store = new MemoryV2Store(
      new MemoryStoreDatabaseMock({
        memory_job: [
          {
            id: 1,
            jobKey: 'extract:conv-1',
            jobType: 'extract',
            status: 'processing',
            payload: '{"conversationId":"conv-1","scopeType":"user","scopeKey":"onebot:bot:user:1","maxMessages":12}',
            retryCount: 0,
            nextRunAt: 10,
            lastError: null,
            createdAt: 1,
            updatedAt: 2,
          },
          {
            id: 2,
            jobKey: 'embed:fact:1',
            jobType: 'embed',
            status: 'pending',
            payload: '{"recordType":"fact","recordId":1}',
            retryCount: 0,
            nextRunAt: Date.now() + 30_000,
            lastError: null,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }) as any,
    );

    await expect(store.requeueProcessingJobs()).resolves.toBe(1);

    const rows = await (store as any).database.get('memory_job', {} as Record<string, never>);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 1,
          status: 'pending',
          lastError: null,
        }),
        expect.objectContaining({
          id: 2,
          status: 'pending',
        }),
      ]),
    );
  });
});
