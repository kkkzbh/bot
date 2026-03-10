import type { Session, Universal } from 'koishi';

const MIN_SMART_SEND_DELAY_MS = 1000;
const MAX_SMART_SEND_DELAY_MS = 4000;
const QQBOT_MULTILINE_OPEN_TAG = '<qqbot-multiline>';
const QQBOT_MULTILINE_CLOSE_TAG = '</qqbot-multiline>';
const META_LEAK_FALLBACK_TEXT = '你在说什么怪话……我听不懂';
const bypassSplitOptions = new WeakSet<Universal.SendOptions>();
const LEAKED_REASONING_LINE_PATTERN =
  /(根据(?:之前|以上|当前)?的?对话|根据我的身份设定|用户(?:让我|让我去|让我搜|只说|曾(?:经)?|问|想|没有|没说)|我(?:需要|得|先|要|应该)(?:确认|判断|看看|先确认|以角色身份自然回应)|没有指定(?:具体)?(?:搜索)?内容|确认用户想让|搜索什么具体内容|不应该有特殊的技术能力|搜索工具(?:似乎|好像)?(?:不可用|有问题|出问题))/;
const LEAKED_REASONING_MARKER_PATTERN =
  /(用户让我搜索|根据我的身份设定|我应该以角色身份|我需要确认|搜索工具似乎不可用|不应该有特殊的技术能力|工具好像又出问题了)/g;
const LEAKED_REASONING_START_PATTERN =
  /^(?:用户(?:让我|要我|叫我|希望我)|根据(?:之前|以上|当前)?的?对话|根据我的身份设定|我(?:需要|得|要|应该))/;
const SEARCH_INTENT_HINT_PATTERN = /(搜|搜索|web_search|联网|查一下|查一查)/i;
const META_LEAK_SELF_REFERENCE_PATTERN =
  /(?:^|[\s，。！？!?])(?:我(?:是|作为|不是|并非|需要|得|要|必须|不能|不会|没法)|根据(?:我的)?(?:身份|系统)?设定|按照(?:系统)?(?:提示词|规则|设定|指令)|提示词(?:要求|规定|写着)|系统(?:提示词|消息|规则|指令)(?:要求|规定)|(?:扮演|身份)设定(?:要求|规定))/i;
const META_LEAK_KEYWORD_PATTERN =
  /(系统提示词|system prompt|prompt|提示词|系统消息|隐藏指令|越狱|AI|人工智能|模型|语言模型|机器人|扮演设定|身份设定)/i;
const FENCED_CODE_BLOCK_PATTERN = /^```[^\n\r]*\r?\n([\s\S]*?)\r?\n```$/;
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const STRONG_EMPHASIS_PATTERN = /\*\*([^*\n]+)\*\*/g;
const ALT_STRONG_EMPHASIS_PATTERN = /__([^_\n]+)__/g;
const EMPHASIS_PATTERN = /(^|[^\w])\*([^*\n]+)\*(?=[^\w]|$)/g;
const ALT_EMPHASIS_PATTERN = /(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g;
const HEADING_PREFIX_PATTERN = /^\s{0,3}#{1,6}\s+/;
const BLOCKQUOTE_PREFIX_PATTERN = /^\s{0,3}>\s?/;
const UNORDERED_LIST_PREFIX_PATTERN = /^(\s*)[-*+]\s+/;
const ORDERED_LIST_PREFIX_PATTERN = /^\s*(?:\d+[.)、]|[一二三四五六七八九十]+[、.．])\s+\S/;
const COMMAND_LINE_PATTERN =
  /^\s*(?:[$#]\s*)?(?:git|pnpm|npm|yarn|node|python|python3|pip|docker|kubectl|ssh|curl|wget|ls|cd|cp|mv|rm|mkdir|touch|cat|grep|sed|awk|find|ps|kill|systemctl|journalctl|tail|head|tsc|npx)\b/i;
const CONFIG_LINE_PATTERN =
  /^\s*(?:[A-Za-z_][\w.-]*\s*[:=]\s*\S.+|"[^"\n]+"\s*:\s*.+|\[[^\]\n]+\]|\w+\s*\{\s*|\}\s*$)/;
const CODE_LINE_PATTERN =
  /^\s*(?:#include\b|using\s+namespace\b|import(?=\s+[A-Za-z_"'{])|from\b.+\bimport\b|export(?=\s+[A-Za-z_*{]|\s*$)|const(?=\s+[A-Za-z_$])|let(?=\s+[A-Za-z_$])|var(?=\s+[A-Za-z_$])|function(?=\s+[A-Za-z_$]|\s*[(])|class(?=\s+[A-Za-z_$<]|\s*[{(<])|interface(?=\s+[A-Za-z_$]|\s*[{<])|type(?=\s+[A-Za-z_$<{]|\s*[<{])|enum(?=\s+[A-Za-z_$]|\s*[{])|if(?=\s*[(])|else(?=\s*[{]|\s+if\b)|for(?=\s*[(])|while(?=\s*[(])|switch(?=\s*[(])|case\s+|return(?=\s+\S|\s*[;]|\s*$)|try(?=\s*[{])|catch(?=\s*[(])|finally(?=\s*[{])|public(?=\s+)|private(?=\s+)|protected(?=\s+)|static(?=\s+)|async(?=\s+[A-Za-z_(]|\s*[(])|await(?=\s+)|def(?=\s+[A-Za-z_])|print\s*\(|console\.(?:log|error|warn)\s*\(|std::|printf\s*\(|cout\b|cin\b|int\s+main\s*\()/i;
const SQL_KEYWORD_PATTERN =
  /^\s*(?:SELECT\b|INSERT\s+INTO\b|UPDATE\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|INDEX|VIEW|DATABASE)\b|DROP\s+(?:TABLE|INDEX|VIEW|DATABASE)\b|ALTER\s+TABLE\b|FROM\b|WHERE\b|(?:LEFT\s+|INNER\s+|RIGHT\s+|OUTER\s+)?JOIN\b|ORDER\s+BY\b|GROUP\s+BY\b|HAVING\b|LIMIT\b|UNION\b)/;
const HTML_TAG_PATTERN = /^\s*<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^>]*)?\s*\/?>/;

type AsyncTask<T> = () => Promise<T>;

export interface KeyedStrandRunner {
  run<T>(key: string, task: AsyncTask<T>): Promise<T>;
}

export type OutboundMessageMode = 'split' | 'preserve';

export interface NormalizedOutboundMessage {
  mode: OutboundMessageMode;
  content: string;
}

export type SessionStrandLike = {
  platform?: string;
  isDirect?: boolean;
  channelId?: string;
  guildId?: string;
  userId?: string;
  bot?: {
    selfId?: string;
  };
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createKeyedStrandRunner(): KeyedStrandRunner {
  const tails = new Map<string, Promise<void>>();

  return {
    async run<T>(key: string, task: AsyncTask<T>): Promise<T> {
      const tail = tails.get(key);
      const previous = tail ? tail.catch(() => undefined) : Promise.resolve();
      let releaseCurrent: () => void = () => {};
      const current = new Promise<void>((resolve) => {
        releaseCurrent = () => resolve();
      });
      const nextTail = previous.then(() => current);
      tails.set(key, nextTail);

      await previous;

      try {
        return await task();
      } finally {
        releaseCurrent();
        if (tails.get(key) === nextTail) {
          tails.delete(key);
        }
      }
    },
  };
}

function resolveSessionStrandScope(session: SessionStrandLike): string | null {
  if (session.isDirect) {
    const privateId = session.channelId?.trim() || session.userId?.trim();
    return privateId ? `private:${privateId}` : null;
  }

  const groupId = session.channelId?.trim() || session.guildId?.trim();
  if (groupId) return `group:${groupId}`;

  const fallbackPrivateId = session.userId?.trim();
  return fallbackPrivateId ? `private:${fallbackPrivateId}` : null;
}

export function resolveSessionStrandKey(session: SessionStrandLike): string | null {
  const platform = session.platform?.trim();
  if (!platform) return null;

  const botSelfId = session.bot?.selfId?.trim() || 'default-bot';
  const scope = resolveSessionStrandScope(session);
  if (!scope) return null;

  return `${platform}:${botSelfId}:${scope}`;
}

export function createBypassLineSplitOptions(session?: Session): Universal.SendOptions {
  const options: Universal.SendOptions = session ? { session } : {};
  bypassSplitOptions.add(options);
  return options;
}

export function shouldBypassLineSplit(options: Universal.SendOptions): boolean {
  return bypassSplitOptions.has(options);
}

function normalizeLineEndings(message: string): string {
  return message.replace(/\r\n?/g, '\n');
}

function stripMultilineControlTags(message: string): string {
  return message.replaceAll(QQBOT_MULTILINE_OPEN_TAG, '').replaceAll(QQBOT_MULTILINE_CLOSE_TAG, '');
}

function trimPreservedContent(content: string): string {
  const normalized = normalizeLineEndings(content);
  return normalized.replace(/^\n/, '').replace(/\n$/, '').trimEnd();
}

function unwrapFencedCodeBlock(message: string): string {
  const normalized = normalizeLineEndings(message).trim();
  const matched = normalized.match(FENCED_CODE_BLOCK_PATTERN);
  return matched?.[1] ?? message;
}

function stripSplitModeMarkdown(message: string): string {
  let normalized = normalizeLineEndings(message);
  normalized = unwrapFencedCodeBlock(normalized);
  normalized = normalized.replace(MARKDOWN_LINK_PATTERN, '$1 $2');
  normalized = normalized.replace(INLINE_CODE_PATTERN, '$1');
  normalized = normalized.replace(STRONG_EMPHASIS_PATTERN, '$1');
  normalized = normalized.replace(ALT_STRONG_EMPHASIS_PATTERN, '$1');
  normalized = normalized.replace(EMPHASIS_PATTERN, '$1$2');
  normalized = normalized.replace(ALT_EMPHASIS_PATTERN, '$1$2');

  const lines = normalized.split('\n').map((line) => {
    let next = line;
    next = next.replace(HEADING_PREFIX_PATTERN, '');
    next = next.replace(BLOCKQUOTE_PREFIX_PATTERN, '');
    next = next.replace(UNORDERED_LIST_PREFIX_PATTERN, '$1');
    return next;
  });

  return lines.join('\n').trim();
}

function stripPreserveModeMarkdown(message: string): string {
  return trimPreservedContent(unwrapFencedCodeBlock(message));
}

function hasDominantCJK(text: string): boolean {
  const cjkCount = (text.match(/[\u2e80-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latinCount = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjkCount > 0 && cjkCount > latinCount;
}

function looksLikeListLine(line: string): boolean {
  return ORDERED_LIST_PREFIX_PATTERN.test(line) || UNORDERED_LIST_PREFIX_PATTERN.test(line);
}

function looksLikeCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (CODE_LINE_PATTERN.test(trimmed)) return true;
  if (SQL_KEYWORD_PATTERN.test(trimmed)) return true;
  if (HTML_TAG_PATTERN.test(trimmed)) return true;
  if (/^[{}[\]()]+[;,]?$/.test(trimmed)) return true;
  if (/^\s{2,}\S/.test(line) && !hasDominantCJK(trimmed)) return true;
  if (/[{};]/.test(trimmed) && /[A-Za-z_]/.test(trimmed)) {
    const cjkCount = (trimmed.match(/[\u2e80-\u9fff\uf900-\ufaff]/g) ?? []).length;
    if (cjkCount === 0) return true;
    const latinCount = (trimmed.match(/[A-Za-z]/g) ?? []).length;
    if (cjkCount <= latinCount && /[()\[\]]/.test(trimmed) && /[=+\-*/<>!&|]/.test(trimmed)) return true;
  }
  if (/[)\w]\s*=>/.test(trimmed) && !hasDominantCJK(trimmed)) return true;
  if (/[A-Za-z_]::|::[A-Za-z_]/.test(trimmed)) return true;
  return false;
}

function isRealConfigLine(line: string): boolean {
  if (!CONFIG_LINE_PATTERN.test(line)) return false;
  if (/^\s*"[^"\n]+"\s*:/.test(line)) return true;
  if (/^\s*\[[^\]\n]+\]\s*$/.test(line)) return true;
  if (/\w+\s*\{\s*$/.test(line.trim())) return true;
  if (/^\s*\}/.test(line)) return true;
  const match = line.match(/^\s*[A-Za-z_][\w.-]*\s*[:=]\s*(.+)$/);
  if (!match) return false;
  return !hasDominantCJK(match[1].trim());
}

function shouldAutoPreserveStructuredMultiline(message: string): boolean {
  const normalized = normalizeLineEndings(message).trim();
  if (!normalized.includes('\n')) return false;
  if (FENCED_CODE_BLOCK_PATTERN.test(normalized)) return true;

  const lines = normalized.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length < 2) return false;

  const listCount = lines.filter((line) => looksLikeListLine(line)).length;
  if (listCount >= 2 && listCount >= Math.ceil(lines.length / 2)) {
    return true;
  }

  const commandCount = lines.filter((line) => COMMAND_LINE_PATTERN.test(line)).length;
  if (commandCount >= 2) {
    return true;
  }

  const configCount = lines.filter((line) => isRealConfigLine(line)).length;
  if (configCount >= 2 && lines.length <= 12) {
    return true;
  }

  const codeCount = lines.filter((line) => looksLikeCodeLine(line)).length;
  const hasBraceOnlyLine = lines.some((line) => /^[{}[\]()]+[;,]?$/.test(line.trim()));
  const hasIndentedLine = lines.some((line) => /^\s{2,}\S/.test(line) && !hasDominantCJK(line.trim()));
  return codeCount >= 2 && (lines.length >= 3 || hasBraceOnlyLine || hasIndentedLine);
}

function sanitizePromptLeakMessage(message: string): string {
  const normalized = normalizeLineEndings(message).trim();
  if (!normalized) return normalized;
  if (!META_LEAK_SELF_REFERENCE_PATTERN.test(normalized)) return normalized;
  if (!META_LEAK_KEYWORD_PATTERN.test(normalized)) return normalized;
  return META_LEAK_FALLBACK_TEXT;
}

function parseOutboundMessageControl(message: string): NormalizedOutboundMessage {
  const normalized = normalizeLineEndings(message);
  const trimmed = normalized.trim();
  const fullyWrapped =
    trimmed.startsWith(QQBOT_MULTILINE_OPEN_TAG) &&
    trimmed.endsWith(QQBOT_MULTILINE_CLOSE_TAG) &&
    trimmed.indexOf(QQBOT_MULTILINE_OPEN_TAG) === 0;

  if (fullyWrapped) {
    const inner = trimmed.slice(QQBOT_MULTILINE_OPEN_TAG.length, trimmed.length - QQBOT_MULTILINE_CLOSE_TAG.length);
    return {
      mode: 'preserve',
      content: trimPreservedContent(inner),
    };
  }

  if (normalized.includes(QQBOT_MULTILINE_OPEN_TAG) || normalized.includes(QQBOT_MULTILINE_CLOSE_TAG)) {
    return {
      mode: 'split',
      content: stripMultilineControlTags(normalized).trim(),
    };
  }

  return {
    mode: 'split',
    content: normalized.trim(),
  };
}

export function splitMessageByLines(message: string): string[] {
  const normalized = normalizeLineEndings(message);
  const lines = normalized.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length) return lines;
  const fallback = message.trim();
  return fallback ? [fallback] : [];
}

export function looksLikeLeakedReasoningLine(line: string): boolean {
  const text = line.trim();
  if (text.length < 20) return false;
  return LEAKED_REASONING_LINE_PATTERN.test(text);
}

export function dropLeadingLeakedReasoningLines(lines: string[]): string[] {
  let index = 0;
  while (lines.length - index > 1 && looksLikeLeakedReasoningLine(lines[index])) {
    index += 1;
  }
  return index > 0 ? lines.slice(index) : lines;
}

function splitBySentence(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  return normalized.match(/[^。！？!?]+[。！？!?]?/g)?.map((item) => item.trim()).filter(Boolean) ?? [normalized];
}

function stripLeakedReasoningFromLine(line: string): string {
  const segments = splitBySentence(line);
  if (!segments.length) return '';
  const filtered = segments.filter((segment) => !LEAKED_REASONING_LINE_PATTERN.test(segment));
  return filtered.join('').trim();
}

export function sanitizeLeakedReasoningMessage(message: string): string {
  const normalized = normalizeLineEndings(message).trim();
  if (!normalized) return normalized;

  const markerCount = (normalized.match(LEAKED_REASONING_MARKER_PATTERN) ?? []).length;
  const startsLikeLeak = LEAKED_REASONING_START_PATTERN.test(normalized);
  const likelyLeak = startsLikeLeak || markerCount >= 2;
  if (!likelyLeak) return normalized;

  const strippedLines = dropLeadingLeakedReasoningLines(splitMessageByLines(normalized))
    .map((line) => stripLeakedReasoningFromLine(line))
    .filter(Boolean);

  if (strippedLines.length) return strippedLines.join('\n');

  return SEARCH_INTENT_HINT_PATTERN.test(normalized)
    ? '你想让我搜什么具体内容呢？'
    : '你再具体说一下，我好准确回复你';
}

export function normalizeOutboundMessage(message: string): NormalizedOutboundMessage {
  const parsed = parseOutboundMessageControl(message);
  if (parsed.mode === 'preserve') {
    return {
      mode: 'preserve',
      content: sanitizePromptLeakMessage(stripPreserveModeMarkdown(parsed.content)),
    };
  }

  if (shouldAutoPreserveStructuredMultiline(parsed.content)) {
    return {
      mode: 'preserve',
      content: sanitizePromptLeakMessage(stripPreserveModeMarkdown(parsed.content)),
    };
  }

  const markdownStripped = stripSplitModeMarkdown(parsed.content);
  const reasoningSanitized = sanitizeLeakedReasoningMessage(markdownStripped);
  const promptSanitized = sanitizePromptLeakMessage(reasoningSanitized);
  const lines = dropLeadingLeakedReasoningLines(splitMessageByLines(promptSanitized));

  return {
    mode: 'split',
    content: lines.length ? lines.join('\n') : promptSanitized.trim(),
  };
}

export function calculateSmartSendDelayMs(line: string): number {
  const text = line.trim();
  if (!text) return MIN_SMART_SEND_DELAY_MS;

  const cjkCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const alphaNumCount = (text.match(/[A-Za-z0-9]/g) ?? []).length;
  const nonSpaceCount = text.replace(/\s+/g, '').length;
  const symbolCount = Math.max(0, nonSpaceCount - cjkCount - alphaNumCount);
  const punctuationCount = (text.match(/[，。！？；：,.!?;:]/g) ?? []).length;

  const weightedLength = cjkCount + alphaNumCount * 0.6 + symbolCount * 0.8;
  const estimate = Math.round(900 + weightedLength * 55 + punctuationCount * 180);
  return clamp(estimate, MIN_SMART_SEND_DELAY_MS, MAX_SMART_SEND_DELAY_MS);
}

export async function sendByLinesWithSmartInterval(
  message: string,
  sendLine: (line: string) => Promise<unknown>,
): Promise<void> {
  const lines = splitMessageByLines(message);
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) {
      const delayMs = calculateSmartSendDelayMs(lines[index - 1]);
      await sleep(delayMs);
    }
    await sendLine(lines[index]);
  }
}

export async function dispatchNormalizedOutboundMessage(
  message: NormalizedOutboundMessage,
  sendWhole: (content: string) => Promise<unknown>,
  sendLine: (line: string) => Promise<unknown>,
): Promise<void> {
  if (message.mode === 'preserve') {
    if (!message.content.trim()) return;
    await sendWhole(message.content);
    return;
  }

  const content = message.content.trim();
  if (!content) return;

  const lines = splitMessageByLines(content);
  if (!lines.length) return;
  if (lines.length === 1) {
    await sendWhole(lines[0]);
    return;
  }

  await sendByLinesWithSmartInterval(lines.join('\n'), sendLine);
}
