import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../src/plugins/web-search/index.js';
import { extractSearchQueryInput } from '../src/plugins/web-search/adapter.js';
import {
  looksLikeDuckDuckGoLiteAnomalyPage,
  parseBingWebResults,
  parseDuckDuckGoLiteResults,
  parseMediaWikiOpenSearchResults,
} from '../src/plugins/web-search/parsers.js';
import { buildFallbackSearchPlan, buildSearchPlan, parsePlannedSearchPayload } from '../src/plugins/web-search/planner.js';
import { isLowConfidence, rankCandidates, rerankCandidatesWithLLM } from '../src/plugins/web-search/ranker.js';
import type { SearchCandidate, SearchRuntimeConfig } from '../src/plugins/web-search/types.js';

vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
    min: () => MockSchemaNode;
    max: () => MockSchemaNode;
    role: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
    min: () => createSchemaNode(),
    max: () => createSchemaNode(),
    role: () => createSchemaNode(),
  });

  class MockLogger {
    info(): void {}
    warn(): void {}
    debug(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      boolean: () => createSchemaNode(),
      number: () => createSchemaNode(),
      natural: () => createSchemaNode(),
      union: () => createSchemaNode(),
      array: () => createSchemaNode(),
      string: () => createSchemaNode(),
      const: () => createSchemaNode(),
    },
  };
});

function createJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createBingHtml(results: Array<{ title: string; url: string; description: string }>): string {
  const items = results
    .map(
      (item) => `
        <li class="b_algo">
          <h2><a href="${item.url}">${item.title}</a></h2>
          <div class="b_caption"><p>${item.description}</p></div>
        </li>
      `,
    )
    .join('\n');
  return `<ul id="b_results">${items}</ul>`;
}

function createDuckDuckGoLiteHtml(results: Array<{ title: string; url: string; description: string }>): string {
  return `
    <table>
      ${results
        .map(
          (item) => `
            <tr>
              <td><a href="/l/?uddg=${encodeURIComponent(item.url)}" class="result-link">${item.title}</a></td>
            </tr>
            <tr>
              <td class="result-snippet">${item.description}</td>
            </tr>
          `,
        )
        .join('\n')}
    </table>
  `;
}

function createDuckDuckGoAnomalyHtml(): string {
  return `
    <html>
      <body>
        <form id="challenge-form"></form>
        <div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
      </body>
    </html>
  `;
}

function createArticleHtml(options: { title: string; description?: string; paragraphs: string[] }): string {
  return `
    <html>
      <head>
        <title>${options.title}</title>
        <meta name="description" content="${options.description ?? ''}">
      </head>
      <body>
        <main>
          ${options.paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('\n')}
        </main>
      </body>
    </html>
  `;
}

function createMediaWikiExtractPayload(pages: Array<{ title: string; extract: string }>): Record<string, unknown> {
  return {
    query: {
      pages: Object.fromEntries(
        pages.map((page, index) => [
          String(index + 1),
          {
            pageid: index + 1,
            ns: 0,
            title: page.title,
            extract: page.extract,
          },
        ]),
      ),
    },
  };
}

function createRuntime(overrides: Partial<SearchRuntimeConfig> = {}): SearchRuntimeConfig {
  const llmOverrides = overrides.llm ?? {};
  const baseRuntime: SearchRuntimeConfig = {
    topK: 5,
    timeoutMs: 12_000,
    providers: ['bing-web', 'duckduckgo-lite', 'wikipedia', 'moegirl'],
    acgnExtensionEnabled: false,
    llm: {
      baseURL: '',
      apiKey: '',
      model: '',
      plannerEnabled: false,
      rerankEnabled: false,
      ...llmOverrides,
    },
  };

  return {
    ...baseRuntime,
    ...overrides,
    llm: {
      ...baseRuntime.llm,
      ...llmOverrides,
    },
  };
}

function createTool(overrides: Record<string, unknown> = {}): {
  invoke: (input: unknown) => Promise<string>;
  intervalHandlers: Array<() => void>;
  registerTool: ReturnType<typeof vi.fn>;
} {
  const readyHandlers: Array<() => void> = [];
  const intervalHandlers: Array<() => void> = [];
  const registerTool = vi.fn();
  const ctx = {
    chatluna: {
      platform: { registerTool },
    },
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'ready') readyHandlers.push(handler);
    }),
    setInterval: vi.fn((handler: () => void) => {
      intervalHandlers.push(handler);
      return {} as unknown;
    }),
  };

  apply(ctx as never, {
    enabled: true,
    topK: 5,
    timeoutMs: 12_000,
    providers: ['bing-web', 'duckduckgo-lite', 'wikipedia', 'moegirl'],
    plannerEnabled: false,
    rerankEnabled: false,
    acgnExtensionEnabled: false,
    ...overrides,
  });
  readyHandlers[0]();
  const [, descriptor] = registerTool.mock.calls[0] as [string, { createTool: (params: unknown) => unknown }];
  const tool = descriptor.createTool({}) as {
    invoke: (input: unknown) => Promise<string>;
  };

  return {
    registerTool,
    intervalHandlers,
    invoke: (input: unknown) => tool.invoke(typeof input === 'string' ? { input } : input),
  };
}

describe('web-search', () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('extracts search text from structured tool-call input', () => {
    expect(extractSearchQueryInput({ query: '查一下 丰川祥子 是谁' })).toBe('查一下 丰川祥子 是谁');
    expect(extractSearchQueryInput({ payload: { input: '彩叶和辉夜是谁' } })).toBe('彩叶和辉夜是谁');
    expect(extractSearchQueryInput({ input: '[object Object]' })).toBe('');
  });

  it('parses bing html search blocks into structured results', () => {
    expect(
      parseBingWebResults(
        createBingHtml([
          {
            title: '丰川祥子',
            url: 'https://example.com/a',
            description: '角色介绍',
          },
        ]),
        5,
      ),
    ).toEqual([
      {
        title: '丰川祥子',
        url: 'https://example.com/a',
        description: '角色介绍',
      },
    ]);
  });

  it('parses duckduckgo lite results and detects anomaly pages', () => {
    expect(
      parseDuckDuckGoLiteResults(
        createDuckDuckGoLiteHtml([
          {
            title: '超时空辉夜姬! - 萌娘百科',
            url: 'https://example.com/moe',
            description: '原创网络动画电影。',
          },
        ]),
        5,
      ),
    ).toEqual([
      {
        title: '超时空辉夜姬! - 萌娘百科',
        url: 'https://example.com/moe',
        description: '原创网络动画电影。',
      },
    ]);
    expect(looksLikeDuckDuckGoLiteAnomalyPage(createDuckDuckGoAnomalyHtml())).toBe(true);
  });

  it('unwraps scheme-relative duckduckgo redirect urls', () => {
    expect(
      parseDuckDuckGoLiteResults(
        `
          <table>
            <tr>
              <td><a href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/article')}" class="result-link">示例结果</a></td>
            </tr>
            <tr>
              <td class="result-snippet">示例摘要</td>
            </tr>
          </table>
        `,
        5,
      ),
    ).toEqual([
      {
        title: '示例结果',
        url: 'https://example.com/article',
        description: '示例摘要',
      },
    ]);
  });

  it('parses mediawiki open search payload', () => {
    expect(
      parseMediaWikiOpenSearchResults(
        JSON.stringify([
          '祥子',
          ['丰川祥子'],
          ['BanG Dream! 角色'],
          ['https://zh.wikipedia.org/wiki/%E4%B8%B0%E5%B7%9D%E7%A5%A5%E5%AD%90'],
        ]),
        5,
        'https://zh.wikipedia.org/w/api.php',
      ),
    ).toEqual([
      {
        title: '丰川祥子',
        url: 'https://zh.wikipedia.org/wiki/%e4%b8%b0%e5%b7%9d%e7%a5%a5%e5%ad%90',
        description: 'BanG Dream! 角色',
      },
    ]);
  });

  it('builds deterministic multi-entity fallback plan', () => {
    const plan = buildFallbackSearchPlan('查一下 彩叶和辉夜是谁？', createRuntime());
    expect(plan.normalizedQuery).toBe('彩叶和辉夜是谁');
    expect(plan.entities).toEqual(['彩叶', '辉夜']);
    expect(plan.needsDisambiguation).toBe(true);
    expect(plan.queries).toContain('彩叶 辉夜 关系');
  });

  it('merges llm planner output with fallback plan', async () => {
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                intent: 'lookup',
                entities: ['丰川祥子'],
                queries: ['丰川祥子 Bang Dream'],
                provider_hints: ['bing-web', 'wikipedia'],
                domain: 'acgn',
                needs_disambiguation: false,
              }),
            },
          },
        ],
      }),
    );

    const plan = await buildSearchPlan(
      '丰川祥子是谁',
      createRuntime({
        llm: {
          baseURL: 'https://api.deepseek.com/v1',
          apiKey: 'test-key',
          model: 'deepseek/deepseek-chat',
          plannerEnabled: true,
          rerankEnabled: false,
        },
      }),
    );

    expect(plan.entities).toEqual(['丰川祥子']);
    expect(plan.queries).toContain('丰川祥子 Bang Dream');
    expect(plan.providerHints).toEqual(['bing-web', 'wikipedia']);
    expect(plan.domain).toBe('acgn');
  });

  it('parses planner payload with deterministic fallback when fields are missing', () => {
    const fallbackPlan = buildFallbackSearchPlan('丰川祥子是谁', createRuntime());
    const parsed = parsePlannedSearchPayload('{"queries":["丰川祥子"]}', fallbackPlan, createRuntime());
    expect(parsed.entities).toEqual(fallbackPlan.entities);
    expect(parsed.queries).toContain('丰川祥子');
  });

  it('ranks candidates by entity and domain evidence', () => {
    const plan = buildFallbackSearchPlan('丰川祥子是谁', createRuntime());
    const results = rankCandidates(
      [
        {
          title: '丰川祥子',
          url: 'https://zh.wikipedia.org/wiki/abc',
          description: 'BanG Dream! 角色',
          source: 'wikipedia',
          score: 0,
          tags: [],
          evidence: [],
        },
        {
          title: '无关结果',
          url: 'https://example.com/other',
          description: '其他内容',
          source: 'bing-web',
          score: 0,
          tags: [],
          evidence: [],
        },
      ],
      plan,
      5,
    );

    expect(results[0].title).toBe('丰川祥子');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('detects low-confidence result sets for ambiguous queries', () => {
    const plan = buildFallbackSearchPlan('彩叶和辉夜是谁', createRuntime());
    const results: SearchCandidate[] = [
      {
        title: '结果 A',
        url: 'https://example.com/a',
        description: '彩叶',
        source: 'bing-web',
        score: 6,
        tags: [],
        evidence: [],
      },
      {
        title: '结果 B',
        url: 'https://example.com/b',
        description: '辉夜',
        source: 'bing-web',
        score: 5,
        tags: [],
        evidence: [],
      },
    ];
    expect(isLowConfidence(results, plan)).toBe(true);
  });

  it('reranks candidates with llm when enabled', async () => {
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                ordered_urls: ['https://example.com/b', 'https://example.com/a'],
              }),
            },
          },
        ],
      }),
    );

    const reranked = await rerankCandidatesWithLLM(
      [
        {
          title: '结果 A',
          url: 'https://example.com/a',
          description: 'A',
          source: 'bing-web',
          score: 10,
          tags: [],
          evidence: [],
        },
        {
          title: '结果 B',
          url: 'https://example.com/b',
          description: 'B',
          source: 'wikipedia',
          score: 9,
          tags: [],
          evidence: [],
        },
      ],
      buildFallbackSearchPlan('谁是丰川祥子', createRuntime()),
      createRuntime({
        llm: {
          baseURL: 'https://api.deepseek.com/v1',
          apiKey: 'test-key',
          model: 'deepseek/deepseek-chat',
          plannerEnabled: false,
          rerankEnabled: true,
        },
      }),
    );

    expect(reranked[0].url).toBe('https://example.com/b');
  });

  it('registers web_search once even after interval retries', async () => {
    const { registerTool, intervalHandlers } = createTool();
    expect(registerTool).toHaveBeenCalledTimes(1);
    intervalHandlers[0]();
    expect(registerTool).toHaveBeenCalledTimes(1);
  });

  it('returns array output for normal search queries', async () => {
    const requestedTerms: string[] = [];
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('lite.duckduckgo.com/lite/')) {
        requestedTerms.push(new URL(url).searchParams.get('q') ?? '');
        return new Response(
          createDuckDuckGoLiteHtml([
            {
              title: '丰川祥子 - 萌娘百科',
              url: 'https://example.com/moe',
              description: 'BanG Dream! 角色',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('cn.bing.com/search')) {
        return new Response(createBingHtml([]), { status: 200 });
      }
      if (url.includes('wikipedia.org/w/api.php')) {
        return createJsonResponse(['祥子', [], [], []]);
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const tool = createTool();
    const output = JSON.parse(await tool.invoke({ query: '查一下丰川祥子是谁' })) as Array<{ url: string }>;

    expect(output[0].url).toBe('https://example.com/moe');
    expect(requestedTerms).toContain('丰川祥子是谁');
  });

  it('opens result pages and includes detailed content in output', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('lite.duckduckgo.com/lite/')) return new Response(createDuckDuckGoLiteHtml([]), { status: 200 });
      if (url.includes('cn.bing.com/search')) {
        return new Response(
          createBingHtml([
            {
              title: '丰川祥子',
              url: 'https://example.com/sakiko',
              description: 'BanG Dream! 角色',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('wikipedia.org/w/api.php')) {
        return createJsonResponse(['祥子', [], [], []]);
      }
      if (url === 'https://example.com/sakiko') {
        return new Response(
          createArticleHtml({
            title: '丰川祥子',
            description: '祥子角色词条',
            paragraphs: [
              '丰川祥子是《BanG Dream! Ave Mujica》相关作品的重要角色，常以冷静、自律和强烈目标感作为人物印象。',
              '在作品剧情里，她与乐队成员之间的关系、家庭背景以及对舞台与自我认同的追问，构成了角色讨论的核心信息。',
              '这类正文信息明显比搜索结果页摘要更完整，可供模型直接组织最终回答。',
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const tool = createTool();
    const output = JSON.parse(await tool.invoke('丰川祥子是谁')) as Array<{ content?: string; opened?: boolean }>;

    expect(output[0].opened).toBe(true);
    expect(output[0].content).toContain('丰川祥子是《BanG Dream! Ave Mujica》相关作品的重要角色');
  });

  it('stops opening more pages once enough content is collected', async () => {
    const openedUrls: string[] = [];
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('lite.duckduckgo.com/lite/')) return new Response(createDuckDuckGoLiteHtml([]), { status: 200 });
      if (url.includes('cn.bing.com/search')) {
        return new Response(
          createBingHtml([
            { title: '丰川祥子 A', url: 'https://example.com/a', description: '结果 A' },
            { title: '丰川祥子 B', url: 'https://example.com/b', description: '结果 B' },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('wikipedia.org/w/api.php')) {
        return createJsonResponse(['祥子', [], [], []]);
      }
      if (url === 'https://example.com/a' || url === 'https://example.com/b') {
        openedUrls.push(url);
        return new Response(
          createArticleHtml({
            title: '丰川祥子',
            description: '角色正文',
            paragraphs: [
              '丰川祥子是作品中的关键人物，角色经历、乐队经历、家庭背景、人格特征与剧情转折都可以从正文直接获取，这一段先提供基础设定和人物定位。',
              '这一页继续补充她和乐队成员之间的互动、舞台表现、角色冲突与成长脉络，并明确说明这些细节已经足够支持一个 lookup 查询形成较完整的最终回答，而不需要再去打开第二个页面。',
              '如果深读策略生效，抓完这一页之后就应当停止，因为人物介绍、剧情背景、关键关系和讨论重点都已经在同一页里给全了。',
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const tool = createTool();
    await tool.invoke('丰川祥子是谁');
    expect(openedUrls).toEqual(['https://example.com/a']);
  });

  it('never opens more than ten result pages', async () => {
    const openedUrls: string[] = [];
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('lite.duckduckgo.com/lite/')) return new Response(createDuckDuckGoLiteHtml([]), { status: 200 });
      if (url.includes('cn.bing.com/search')) {
        return new Response(
          createBingHtml(
            Array.from({ length: 12 }, (_, index) => ({
              title: `结果 ${index + 1}`,
              url: `https://example.com/page-${index + 1}`,
              description: '简短摘要',
            })),
          ),
          { status: 200 },
        );
      }
      if (url.includes('wikipedia.org/w/api.php')) {
        return createJsonResponse(['query', [], [], []]);
      }
      if (url.startsWith('https://example.com/page-')) {
        openedUrls.push(url);
        return new Response(
          createArticleHtml({
            title: '普通页面',
            paragraphs: ['信息不足。'],
          }),
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const tool = createTool({ topK: 10 });
    await tool.invoke('查询一个没有足够细节的主题');
    expect(openedUrls).toHaveLength(10);
  });

  it('survives partial provider failures and still returns results', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('lite.duckduckgo.com/lite/')) {
        return new Response('bad gateway', { status: 502 });
      }
      if (url.includes('cn.bing.com/search')) {
        return new Response(
          createBingHtml([
            {
              title: '丰川祥子',
              url: 'https://example.com/bing',
              description: 'BanG Dream! 角色',
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('wikipedia.org/w/api.php')) {
        return createJsonResponse(['祥子', [], [], []]);
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const tool = createTool();
    const output = JSON.parse(await tool.invoke('丰川祥子是谁')) as Array<{ url: string }>;
    expect(output[0].url).toBe('https://example.com/bing');
  });

  it('does not call moegirl when acgn extension is disabled', async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('lite.duckduckgo.com/lite/')) return new Response(createDuckDuckGoLiteHtml([]), { status: 200 });
      if (url.includes('cn.bing.com/search')) return new Response(createBingHtml([]), { status: 200 });
      if (url.includes('wikipedia.org/w/api.php')) return createJsonResponse(['祥子', [], [], []]);
      if (url.includes('mzh.moegirl.org.cn/api.php')) throw new Error('moegirl should not be called');
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const tool = createTool({ acgnExtensionEnabled: false });
    const output = JSON.parse(await tool.invoke('丰川祥子是谁')) as Array<{ url: string }>;
    expect(output).toEqual([]);
  });

  it('calls moegirl only when extension is enabled and core results are weak', async () => {
    let moegirlCalls = 0;
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('lite.duckduckgo.com/lite/')) return new Response(createDuckDuckGoLiteHtml([]), { status: 200 });
      if (url.includes('cn.bing.com/search')) return new Response(createBingHtml([]), { status: 200 });
      if (url.includes('wikipedia.org/w/api.php')) return createJsonResponse(['祥子', [], [], []]);
      if (url.includes('mzh.moegirl.org.cn/api.php')) {
        moegirlCalls += 1;
        if (url.includes('action=query')) {
          return createJsonResponse(
            createMediaWikiExtractPayload([
              {
                title: '丰川祥子',
                extract: '丰川祥子是《BanG Dream!》及其衍生作品的登场角色。',
              },
            ]),
          );
        }
        return createJsonResponse([
          '丰川祥子',
          ['丰川祥子'],
          [''],
          ['https://mzh.moegirl.org.cn/%E4%B8%B0%E5%B7%9D%E7%A5%A5%E5%AD%90'],
        ]);
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const tool = createTool({
      acgnExtensionEnabled: true,
      providers: ['bing-web', 'duckduckgo-lite', 'wikipedia', 'moegirl'],
    });
    const output = JSON.parse(await tool.invoke('角色 丰川祥子是谁')) as Array<{ url: string }>;
    expect(moegirlCalls).toBeGreaterThan(0);
    expect(output[0].url).toContain('mzh.moegirl.org.cn');
  });
});
