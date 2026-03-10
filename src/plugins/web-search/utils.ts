import type { SearchDomain, SearchIntent } from './types.js';

const SEARCH_PREFIX_PATTERN = /^(?:再)?(?:去)?(?:搜(?:索)?|查(?:询)?)(?:一下|一查|一搜)?[:：,\s]*/i;
const SEARCH_LEADING_PRONOUN_PATTERN = /^(?:请|麻烦)?(?:你|你再|你帮我|帮我|给我)\s*/i;
const SEARCH_SUFFIX_PATTERN = /(?:吧|呢|呀|吗|可以吗|行吗|谢谢)[!！?？。]*$/i;
const SOFT_STOPWORDS = new Set([
  '你',
  '我',
  '帮',
  '帮我',
  '一下',
  '搜索',
  '搜',
  '查',
  '查询',
  '请',
  '麻烦',
  '一下吧',
  '是谁',
  '是什么',
  '今天',
  '现在',
  '角色',
  '人物',
  '资料',
  '百科',
]);
const ACGN_HINT_PATTERN = /(角色|作品|动画|动漫|番剧|漫画|小说|游戏|乐队|声优|萌娘|wiki|设定|条目)/i;

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeSearchToken(token: string): string {
  return normalizeText(token)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[。！？!?，、;；]+$/g, '');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function takeUnique(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const normalized = normalizeSearchToken(item);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

export function parseJsonBlock(payload: string): Record<string, unknown> | null {
  const normalized = normalizeText(payload);
  if (!normalized) return null;

  try {
    const parsed = JSON.parse(normalized) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    const block = normalized.match(/\{[\s\S]*\}/)?.[0];
    if (!block) return null;
    try {
      const parsed = JSON.parse(block) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

export function sanitizeSearchQueryInput(raw: string): string {
  const normalized = normalizeText(raw);
  if (!normalized) return '';

  let value = normalized;
  value = value.replace(/^@\S+\s*/g, '');
  value = value.replace(SEARCH_LEADING_PRONOUN_PATTERN, '');
  value = value.replace(SEARCH_PREFIX_PATTERN, '');
  value = value.replace(SEARCH_PREFIX_PATTERN, '');
  value = value.replace(SEARCH_SUFFIX_PATTERN, '');
  value = normalizeSearchToken(value);
  return value || normalized;
}

function isUsefulKeyword(token: string): boolean {
  if (!token) return false;
  if (SOFT_STOPWORDS.has(token)) return false;
  if (token.length <= 1) return false;
  if (/^(是谁|是什么|多少|怎么|如何)$/.test(token)) return false;
  return true;
}

export function splitEntityCandidates(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const zhTokens = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  const enTokens = normalized.match(/[A-Za-z0-9][A-Za-z0-9\-_.]{1,}/g) ?? [];
  const results: string[] = [];

  for (const token of zhTokens) {
    const trimmed = token.replace(/(?:是谁|是什么|有哪些|介绍|资料|百科|新闻|消息|条目|角色|人物)$/g, '');
    const pieces = trimmed
      .split(/[与和跟及、]/g)
      .map((part) => part.trim())
      .filter(Boolean);
    results.push(...(pieces.length ? pieces : [trimmed]));
  }

  results.push(...enTokens);
  return takeUnique(results.filter((token) => isUsefulKeyword(token)), 12);
}

export function extractKeywordTokens(text: string): string[] {
  return splitEntityCandidates(text).map((token) => token.toLowerCase());
}

export function detectIntent(query: string): SearchIntent {
  if (/(最新|新闻|动态|今天|今日|recent|latest|news)/i.test(query)) return 'news';
  if (/[与和跟及、].*(区别|关系|比较|对比|谁更|vs)/.test(query) || /\bvs\b/i.test(query)) return 'compare';
  return 'lookup';
}

export function detectDomain(query: string): SearchDomain {
  return ACGN_HINT_PATTERN.test(query) ? 'acgn' : 'general';
}

export function shouldDisambiguate(query: string, entities: string[]): boolean {
  if (entities.length >= 2) return true;
  return /(还是|哪个|哪位|哪一个|同名|区别|关系|比较|对比)/.test(query);
}

export function buildFallbackQueries(query: string, entities: string[], needsDisambiguation: boolean): string[] {
  const queries = [query];

  if (needsDisambiguation && entities.length >= 2) {
    queries.push(entities.join(' '));
    queries.push(`${entities.join(' ')} 关系`);
  }

  queries.push(...entities);
  return takeUnique(queries, 6);
}

export function canonicalizeUrl(raw: string): string {
  let normalized = normalizeText(raw);
  if (!normalized) return '';

  if (normalized.startsWith('//')) {
    normalized = `https:${normalized}`;
  }

  if (normalized.startsWith('/l/?uddg=')) {
    normalized = `https://duckduckgo.com${normalized}`;
  }

  try {
    const url = new URL(normalized);
    const duckRedirectTarget = url.searchParams.get('uddg');
    if (/duckduckgo\.com$/i.test(url.hostname) && url.pathname === '/l/' && duckRedirectTarget) {
      return canonicalizeUrl(decodeURIComponent(duckRedirectTarget));
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm|from|src|source|ref|refer|ved|form|dc)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const search = url.searchParams.toString();
    return `${url.protocol}//${url.host}${pathname}${search ? `?${search}` : ''}`.toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
