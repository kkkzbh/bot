export interface WebHotTopicSummary {
  source: string;
  title: string;
  fetchedAt: number;
}

const HOT_TOPIC_URLS = [
  { source: 'zhihu_hot', url: 'https://www.zhihu.com/hot' },
  { source: 'weibo_hot', url: 'https://s.weibo.com/top/summary' },
  { source: 'tieba_hot', url: 'https://tieba.baidu.com/hottopic/browse/topicList' },
] as const;

function stripHtml(input: string): string {
  return input
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html: string): string | null {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const normalized = stripHtml(title ?? html).slice(0, 120).trim();
  return normalized || null;
}

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'qqbot-affinity/1.0 (+https://koishi.chat)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWebHotTopicSummary(
  random: () => number = Math.random,
  timeoutMs = 2500,
): Promise<WebHotTopicSummary | null> {
  const candidates = [...HOT_TOPIC_URLS].sort(() => random() - 0.5);
  for (const item of candidates) {
    const html = await fetchTextWithTimeout(item.url, timeoutMs);
    if (!html) continue;
    const title = extractTitle(html);
    if (!title) continue;
    return {
      source: item.source,
      title,
      fetchedAt: Date.now(),
    };
  }
  return null;
}
