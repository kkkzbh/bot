import { parseMediaWikiExtractMap } from './parsers.js';
import type { SearchCandidate, SearchPlan, SearchRuntimeConfig } from './types.js';
import { canonicalizeUrl, extractKeywordTokens, fetchWithTimeout, normalizeText, takeUnique } from './utils.js';

const MAX_DEEP_READ_PAGES = 10;
const MAX_CONTENT_CHARS = 2_400;
const MAX_DESCRIPTION_CHARS = 280;
const MIN_BLOCK_CHARS = 48;
const PAGE_READ_TIMEOUT_MS = 8_000;
const PAGE_HEADERS: HeadersInit = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
};
const LOW_VALUE_BLOCK_PATTERNS = [
  /(cookie|privacy|terms of service|版权声明|隐私政策|用户协议|免责声明)/i,
  /(登录|注册|打开 app|下载 app|继续阅读|展开全文|回到顶部|返回首页)/i,
  /(广告|赞助|推荐阅读|热门推荐|相关文章|目录收起|导航切换)/i,
];
const MAIN_SECTION_PATTERNS = [
  /<main\b[^>]*>([\s\S]*?)<\/main>/i,
  /<article\b[^>]*>([\s\S]*?)<\/article>/i,
  /<div\b[^>]*id=["']mw-content-text["'][^>]*>([\s\S]*?)<\/div>/i,
  /<div\b[^>]*class=["'][^"']*mw-parser-output[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  /<div\b[^>]*class=["'][^"']*(?:article-content|post-content|entry-content|content-body|article__content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
];

type ReadPageResult = {
  description: string;
  content: string;
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(maxLength - 1, 1)).trimEnd()}…`;
}

function extractMetaDescription(html: string): string {
  const match =
    html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["']/i);
  return normalizeText(decodeHtmlEntities(match?.[1] ?? ''));
}

function cleanHtmlForReading(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(svg|form|header|footer|nav|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|li|ul|ol|table|tr|blockquote|h[1-6])>/gi, '\n');
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '));
}

function extractMainSectionHtml(html: string): string {
  for (const pattern of MAIN_SECTION_PATTERNS) {
    const match = html.match(pattern)?.[1];
    if (match && match.length > 200) {
      return match;
    }
  }
  return html;
}

function isLowValueBlock(block: string): boolean {
  return LOW_VALUE_BLOCK_PATTERNS.some((pattern) => pattern.test(block));
}

function extractReadableBlocks(html: string): string[] {
  const sectionHtml = extractMainSectionHtml(cleanHtmlForReading(html));
  const text = stripHtml(sectionHtml);
  const blocks = text
    .split(/\n+/)
    .map((block) => normalizeText(block))
    .filter((block) => block.length >= MIN_BLOCK_CHARS && !isLowValueBlock(block));
  return takeUnique(blocks, 24);
}

function countTermMatches(text: string, terms: string[]): number {
  const normalized = text.toLowerCase();
  return terms.reduce((total, term) => (normalized.includes(term) ? total + 1 : total), 0);
}

function buildPageContent(blocks: string[], plan: SearchPlan): string {
  if (!blocks.length) return '';

  const terms = takeUnique([...plan.entities, ...extractKeywordTokens(plan.normalizedQuery)], 10).map((term) => term.toLowerCase());
  const scored = blocks.map((block, index) => ({
    block,
    index,
    score: countTermMatches(block, terms) + (index < 3 ? 1 : 0),
  }));
  const selected = (scored.some((item) => item.score > 0)
    ? scored
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, 6)
    : scored.slice(0, 4)
  ).sort((left, right) => left.index - right.index);

  const selectedIndexes = new Set(selected.map((item) => item.index));
  while (selected.length < Math.min(scored.length, 6)) {
    const currentLength = selected.reduce((total, item) => total + item.block.length, 0);
    if (currentLength >= 600) break;
    const next = scored.find((item) => !selectedIndexes.has(item.index));
    if (!next) break;
    selected.push(next);
    selectedIndexes.add(next.index);
    selected.sort((left, right) => left.index - right.index);
  }

  const content = selected.map((item) => item.block).join('\n\n');

  return truncateText(content, MAX_CONTENT_CHARS);
}

function buildFallbackDescription(description: string, content: string): string {
  if (description) return truncateText(description, MAX_DESCRIPTION_CHARS);
  return truncateText(content.replace(/\n+/g, ' '), MAX_DESCRIPTION_CHARS);
}

function resolveWikiExtractRequest(url: URL): { apiUrl: string; title: string } | null {
  if (/wikipedia\.org$/i.test(url.hostname) && url.pathname.startsWith('/wiki/')) {
    return {
      apiUrl: `${url.origin}/w/api.php`,
      title: decodeURIComponent(url.pathname.slice('/wiki/'.length)).replace(/_/g, ' '),
    };
  }

  if (/moegirl\.org\.cn$/i.test(url.hostname)) {
    const pathname = decodeURIComponent(url.pathname.replace(/^\/+/, '')).replace(/_/g, ' ');
    if (!pathname || pathname === 'api.php') return null;
    return {
      apiUrl: `${url.origin}/api.php`,
      title: pathname,
    };
  }

  return null;
}

async function readWikiExtract(
  url: URL,
  runtime: SearchRuntimeConfig,
  signal?: AbortSignal,
): Promise<ReadPageResult | null> {
  const target = resolveWikiExtractRequest(url);
  if (!target?.title) return null;

  const requestUrl =
    `${target.apiUrl}?action=query&prop=extracts&explaintext=1&redirects=1&titles=` +
    `${encodeURIComponent(target.title)}&format=json`;
  const response = await fetchWithTimeout(
    requestUrl,
    {
      headers: PAGE_HEADERS,
    },
    Math.min(runtime.timeoutMs, PAGE_READ_TIMEOUT_MS),
    signal,
  );
  if (!response.ok) return null;

  const extractMap = parseMediaWikiExtractMap(await response.text());
  const content = truncateText([...extractMap.values()][0] ?? '', MAX_CONTENT_CHARS);
  if (!content) return null;

  return {
    description: truncateText(content.replace(/\n+/g, ' '), MAX_DESCRIPTION_CHARS),
    content,
  };
}

async function readGenericPage(
  url: string,
  plan: SearchPlan,
  runtime: SearchRuntimeConfig,
  signal?: AbortSignal,
): Promise<ReadPageResult | null> {
  const response = await fetchWithTimeout(
    url,
    {
      headers: PAGE_HEADERS,
    },
    Math.min(runtime.timeoutMs, PAGE_READ_TIMEOUT_MS),
    signal,
  );
  if (!response.ok) return null;

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !/(text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) {
    return null;
  }

  const html = await response.text();
  const description = extractMetaDescription(html);
  const content = buildPageContent(extractReadableBlocks(html), plan);
  if (!description && !content) return null;

  return {
    description: buildFallbackDescription(description, content),
    content,
  };
}

async function readCandidatePage(
  candidate: SearchCandidate,
  plan: SearchPlan,
  runtime: SearchRuntimeConfig,
  signal?: AbortSignal,
): Promise<SearchCandidate> {
  const url = canonicalizeUrl(candidate.url);
  if (!/^https?:\/\//i.test(url)) return candidate;

  try {
    const parsedUrl = new URL(url);
    const page =
      (await readWikiExtract(parsedUrl, runtime, signal)) ?? (await readGenericPage(url, plan, runtime, signal));
    if (!page) return candidate;

    return {
      ...candidate,
      url,
      description: page.description || candidate.description,
      content: page.content || candidate.content,
      opened: true,
      evidence: [...candidate.evidence, `page-opened:${Math.min((page.content || '').length, MAX_CONTENT_CHARS)}`],
    };
  } catch {
    return candidate;
  }
}

function hasEnoughInformation(candidates: SearchCandidate[], plan: SearchPlan): boolean {
  const opened = candidates.filter((candidate) => candidate.content);
  if (!opened.length) return false;

  if (plan.intent === 'lookup' && !plan.needsDisambiguation) {
    const standaloneEnough = opened.some((candidate) => {
      const singleText = `${candidate.title}\n${candidate.description}\n${candidate.content ?? ''}`.toLowerCase();
      const singleLength = candidate.content?.length ?? 0;
      if (singleLength < 200) return false;
      if (plan.entities.length) {
        return plan.entities.some((entity) => singleText.includes(entity.toLowerCase()));
      }
      return extractKeywordTokens(plan.normalizedQuery)
        .slice(0, 2)
        .some((term) => singleText.includes(term.toLowerCase()));
    });
    if (standaloneEnough) return true;
  }

  const combinedText = opened
    .map((candidate) => `${candidate.title}\n${candidate.description}\n${candidate.content ?? ''}`)
    .join('\n')
    .toLowerCase();
  const combinedLength = opened.reduce((total, candidate) => total + (candidate.content?.length ?? 0), 0);
  const queryTerms = takeUnique([...plan.entities, ...extractKeywordTokens(plan.normalizedQuery)], 10).map((term) =>
    term.toLowerCase(),
  );
  const entityTerms = takeUnique(plan.entities, 8).map((term) => term.toLowerCase());
  const matchedQueryTerms = queryTerms.filter((term) => combinedText.includes(term)).length;
  const matchedEntityTerms = entityTerms.filter((term) => combinedText.includes(term)).length;

  if (plan.intent === 'compare') {
    return opened.length >= 2 && matchedEntityTerms >= Math.max(entityTerms.length, 2) && combinedLength >= 1_200;
  }
  if (plan.intent === 'news') {
    return opened.length >= 2 && matchedQueryTerms >= Math.max(Math.min(queryTerms.length, 3), 2) && combinedLength >= 1_400;
  }
  if (plan.needsDisambiguation) {
    return opened.length >= 2 && matchedEntityTerms >= Math.max(entityTerms.length, 2) && combinedLength >= 900;
  }

  if (entityTerms.length) {
    return matchedEntityTerms >= 1 && combinedLength >= 280;
  }

  return matchedQueryTerms >= Math.max(Math.min(queryTerms.length, 2), 1) && combinedLength >= 320;
}

export async function enrichCandidatesWithPageContent(
  candidates: SearchCandidate[],
  plan: SearchPlan,
  runtime: SearchRuntimeConfig,
  signal?: AbortSignal,
): Promise<SearchCandidate[]> {
  if (!candidates.length) return candidates;

  const enriched = [...candidates];
  let openedPages = 0;

  for (let index = 0; index < enriched.length; index += 1) {
    if (openedPages >= MAX_DEEP_READ_PAGES) break;

    const current = enriched[index];
    if (!/^https?:\/\//i.test(canonicalizeUrl(current.url))) continue;

    enriched[index] = await readCandidatePage(current, plan, runtime, signal);
    openedPages += 1;

    if (hasEnoughInformation(enriched, plan)) {
      break;
    }
  }

  return enriched;
}
