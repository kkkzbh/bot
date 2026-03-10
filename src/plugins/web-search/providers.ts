import type { SearchCandidate, SearchPlan, SearchProvider, SearchRequest } from './types.js';
import { fetchWithTimeout, normalizeText, takeUnique } from './utils.js';
import {
  looksLikeDuckDuckGoLiteAnomalyPage,
  parseBingWebResults,
  parseDuckDuckGoLiteResults,
  parseMediaWikiExtractMap,
  parseMediaWikiOpenSearchResults,
} from './parsers.js';

const DEFAULT_WIKIPEDIA_BASE_URLS = ['https://zh.wikipedia.org/w/api.php', 'https://en.wikipedia.org/w/api.php'];
const DEFAULT_MOEGIRL_BASE_URL = 'https://mzh.moegirl.org.cn/api.php';

function buildCandidate(
  item: { title: string; url: string; description: string },
  source: SearchCandidate['source'],
  tags: string[] = [],
): SearchCandidate {
  return {
    title: item.title,
    url: item.url,
    description: item.description,
    source,
    score: 0,
    tags,
    evidence: [],
  };
}

abstract class BaseSearchProvider implements SearchProvider {
  abstract id: SearchCandidate['source'];

  supports(_plan: SearchPlan): boolean {
    return true;
  }

  protected request(url: string, headers: HeadersInit, request: SearchRequest): Promise<Response> {
    return fetchWithTimeout(url, { headers }, request.timeoutMs, request.signal);
  }

  abstract search(plan: SearchPlan, request: SearchRequest): Promise<SearchCandidate[]>;
}

export class DuckDuckGoLiteProvider extends BaseSearchProvider {
  id = 'duckduckgo-lite' as const;

  async search(_plan: SearchPlan, request: SearchRequest): Promise<SearchCandidate[]> {
    const url = `https://lite.duckduckgo.com/lite/?dc=${request.limit}&q=${encodeURIComponent(request.query)}`;
    const response = await this.request(
      url,
      {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0 Safari/537.36',
        Referer: 'https://lite.duckduckgo.com/',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      },
      request,
    );

    if (!response.ok || response.status !== 200) {
      throw new Error(`duckduckgo-lite status=${response.status}`);
    }

    const html = await response.text();
    if (looksLikeDuckDuckGoLiteAnomalyPage(html)) {
      throw new Error('duckduckgo-lite anomaly challenge');
    }

    return parseDuckDuckGoLiteResults(html, request.limit).map((item) => buildCandidate(item, this.id));
  }
}

export class BingWebProvider extends BaseSearchProvider {
  id = 'bing-web' as const;

  async search(_plan: SearchPlan, request: SearchRequest): Promise<SearchCandidate[]> {
    const url = `https://cn.bing.com/search?form=QBRE&q=${encodeURIComponent(request.query)}`;
    const response = await this.request(
      url,
      {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      },
      request,
    );

    if (!response.ok) {
      throw new Error(`bing-web status=${response.status}`);
    }

    return parseBingWebResults(await response.text(), request.limit).map((item) => buildCandidate(item, this.id));
  }
}

export class WikipediaProvider extends BaseSearchProvider {
  id = 'wikipedia' as const;

  async search(_plan: SearchPlan, request: SearchRequest): Promise<SearchCandidate[]> {
    const tasks = DEFAULT_WIKIPEDIA_BASE_URLS.map(async (baseURL) => {
      const url = `${baseURL}?action=opensearch&search=${encodeURIComponent(request.query)}&limit=${request.limit}&namespace=0&format=json`;
      const response = await this.request(
        url,
        {
          'User-Agent': 'Mozilla/5.0',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
        },
        request,
      );
      if (!response.ok) {
        throw new Error(`wikipedia status=${response.status}`);
      }
      return parseMediaWikiOpenSearchResults(await response.text(), request.limit, baseURL).map((item) =>
        buildCandidate(item, this.id),
      );
    });

    return (await Promise.allSettled(tasks))
      .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
      .slice(0, request.limit * DEFAULT_WIKIPEDIA_BASE_URLS.length);
  }
}

export class MoegirlProvider extends BaseSearchProvider {
  id = 'moegirl' as const;

  supports(plan: SearchPlan): boolean {
    return plan.domain === 'acgn' || plan.entities.length > 0;
  }

  async search(_plan: SearchPlan, request: SearchRequest): Promise<SearchCandidate[]> {
    const searchUrl = `${DEFAULT_MOEGIRL_BASE_URL}?action=opensearch&search=${encodeURIComponent(request.query)}&limit=${request.limit}&namespace=0&format=json`;
    const response = await this.request(
      searchUrl,
      {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      },
      request,
    );
    if (!response.ok) {
      throw new Error(`moegirl status=${response.status}`);
    }

    const initialResults = parseMediaWikiOpenSearchResults(await response.text(), request.limit, DEFAULT_MOEGIRL_BASE_URL);
    if (!initialResults.length) return [];

    const titleList = takeUnique(initialResults.map((result) => result.title), request.limit).join('|');
    const extractUrl =
      `${DEFAULT_MOEGIRL_BASE_URL}?action=query&prop=extracts&explaintext=1&exintro=1&titles=` +
      `${encodeURIComponent(titleList)}&format=json`;
    const extractResponse = await this.request(
      extractUrl,
      {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      },
      request,
    );

    const extractMap = extractResponse.ok ? parseMediaWikiExtractMap(await extractResponse.text()) : new Map<string, string>();
    return initialResults.map((item) =>
      buildCandidate(
        {
          ...item,
          description: normalizeText(extractMap.get(item.title) || item.description),
        },
        this.id,
        ['acgn'],
      ),
    );
  }
}

export function createProviders(): SearchProvider[] {
  return [
    new BingWebProvider(),
    new DuckDuckGoLiteProvider(),
    new WikipediaProvider(),
    new MoegirlProvider(),
  ];
}
