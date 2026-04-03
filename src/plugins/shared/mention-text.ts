const XML_MENTION_PATTERN = /<at\b([\s\S]*?)\/>/gi;
const CQ_MENTION_PATTERN = /\[CQ:at,([^\]]+)\]/gi;

function trimField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function extractXmlAttr(source: string, name: string): string {
  const matched = source.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return trimField(matched?.[1]);
}

function parseCqParams(source: string): Record<string, string> {
  return source
    .split(',')
    .slice(1)
    .reduce<Record<string, string>>((acc, item) => {
      const separatorIndex = item.indexOf('=');
      if (separatorIndex < 0) return acc;
      const key = item.slice(0, separatorIndex).trim();
      const value = item.slice(separatorIndex + 1).trim();
      if (key) {
        acc[key] = value;
      }
      return acc;
    }, {});
}

export function formatMentionText(attrs: { id?: string; name?: string }): string {
  const name = trimField(attrs.name);
  if (name) return `@${name}`;
  const id = trimField(attrs.id);
  if (id) return `@${id}`;
  return '';
}

export function normalizeMentionLikeText(text: string): string {
  return text
    .replace(XML_MENTION_PATTERN, (_matched, attrs) => {
      const mention = formatMentionText({
        id: extractXmlAttr(String(attrs ?? ''), 'id'),
        name: extractXmlAttr(String(attrs ?? ''), 'name'),
      });
      return mention ? ` ${mention} ` : ' ';
    })
    .replace(CQ_MENTION_PATTERN, (_matched, paramsSource) => {
      const params = parseCqParams(`CQ:at,${String(paramsSource ?? '')}`);
      const mention = formatMentionText({
        id: params.qq ?? params.id,
        name: params.name,
      });
      return mention ? ` ${mention} ` : ' ';
    });
}
