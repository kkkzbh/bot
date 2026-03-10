import { canonicalizeUrl, normalizeSearchToken, normalizeText } from './utils.js';

type ParsedSearchResult = {
  title: string;
  url: string;
  description: string;
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '));
}

export function looksLikeDuckDuckGoLiteAnomalyPage(html: string): boolean {
  return /Unfortunately, bots use DuckDuckGo too|anomaly-modal__title|challenge-form/i.test(html);
}

export function parseDuckDuckGoLiteResults(html: string, limit: number): ParsedSearchResult[] {
  const results: ParsedSearchResult[] = [];
  const cache = new Set<string>();
  const linkPattern = /<a[^>]*?href="([^"]*)"[^>]*?class=['"]result-link['"][^>]*?>(.*?)<\/a>/gims;
  const snippetPattern = /<td[^>]*?class=['"]result-snippet['"][^>]*?>(.*?)<\/td>/gims;

  const links: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];

  for (const match of html.matchAll(linkPattern)) {
    const href = String(match[1] ?? '');
    const title = normalizeSearchToken(stripHtml(String(match[2] ?? '')));
    let url = href;
    if (href.startsWith('/l/?uddg=')) {
      try {
        url = decodeURIComponent(href.replace('/l/?uddg=', ''));
      } catch {
        url = href;
      }
    }
    url = canonicalizeUrl(url);
    if (!url || !title) continue;
    links.push({ url, title });
  }

  for (const match of html.matchAll(snippetPattern)) {
    snippets.push(normalizeText(stripHtml(String(match[1] ?? ''))));
  }

  let snippetIndex = 0;
  for (const link of links) {
    if (results.length >= limit) break;
    if (cache.has(link.url)) continue;
    cache.add(link.url);
    results.push({
      title: link.title,
      url: link.url,
      description: snippets[snippetIndex++] ?? '',
    });
  }

  return results;
}

export function parseBingWebResults(html: string, limit: number): ParsedSearchResult[] {
  const results: ParsedSearchResult[] = [];
  const itemPattern = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/gim;

  for (const match of html.matchAll(itemPattern)) {
    if (results.length >= limit) break;
    const block = match[1] ?? '';
    const href = block.match(/<a[^>]*href="([^"]+)"/i)?.[1] ?? '';
    const title = normalizeSearchToken(stripHtml(block.match(/<h2>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? ''));
    const description = normalizeText(stripHtml(block.match(/<div[^>]*class="b_caption"[\s\S]*?<p>([\s\S]*?)<\/p>/i)?.[1] ?? ''));
    const url = canonicalizeUrl(href);
    if (!url || !title) continue;
    results.push({ title, url, description });
  }

  return results;
}

export function parseMediaWikiOpenSearchResults(payload: string, limit: number, sourceUrl: string): ParsedSearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length < 4) return [];

  const titles = Array.isArray(parsed[1]) ? parsed[1] : [];
  const descriptions = Array.isArray(parsed[2]) ? parsed[2] : [];
  const urls = Array.isArray(parsed[3]) ? parsed[3] : [];
  const results: ParsedSearchResult[] = [];
  const fallbackBase = sourceUrl.replace(/\/api\.php.*$/i, '');

  for (let index = 0; index < titles.length && results.length < limit; index += 1) {
    const title = normalizeSearchToken(String(titles[index] ?? ''));
    const description = normalizeText(String(descriptions[index] ?? ''));
    const rawUrl = normalizeText(String(urls[index] ?? ''));
    const url = canonicalizeUrl(rawUrl || `${fallbackBase}/${encodeURIComponent(title.replace(/\s+/g, '_'))}`);
    if (!title || !url) continue;
    results.push({ title, url, description });
  }

  return results;
}

export function parseMediaWikiExtractMap(payload: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return new Map();
  }
  const pages = (parsed as { query?: { pages?: Record<string, { title?: string; extract?: string }> } })?.query?.pages ?? {};
  const map = new Map<string, string>();
  for (const page of Object.values(pages)) {
    const title = normalizeSearchToken(String(page?.title ?? ''));
    const extract = normalizeText(String(page?.extract ?? ''));
    if (!title || !extract) continue;
    map.set(title, extract);
  }
  return map;
}
