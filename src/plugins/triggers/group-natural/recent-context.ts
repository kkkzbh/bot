import { HumanMessage, type MessageContent, type MessageContentComplex } from '@langchain/core/messages';
import { resolveSessionDisplayName } from '../../shared/session/index.js';

const DEFAULT_MAX_GROUPS = 128;
const DEFAULT_MAX_MESSAGES_PER_GROUP = 24;
const DEFAULT_RECENT_CONTEXT_TAIL_LIMIT = 12;

type SessionLike = {
  platform?: string;
  bot?: { selfId?: string | null } | undefined;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  isDirect?: boolean;
  messageId?: string | null;
  content?: unknown;
  stripped?: { content?: unknown } | undefined;
  elements?: unknown[] | undefined;
  author?: { nick?: string | null; name?: string | null } | undefined;
  username?: string | null;
};

export interface GroupRecentContextEntry {
  messageId: string | null;
  userId: string;
  speakerName: string;
  renderedText: string;
  imageCount: number;
  sessionSnapshot: SessionLike;
  capturedAt: number;
}

export class GroupRecentContextCache {
  private readonly buckets = new Map<string, GroupRecentContextEntry[]>();

  constructor(
    private readonly maxGroups = DEFAULT_MAX_GROUPS,
    private readonly maxMessagesPerGroup = DEFAULT_MAX_MESSAGES_PER_GROUP,
  ) {}

  append(groupScopeKey: string, entry: GroupRecentContextEntry): void {
    const normalizedKey = groupScopeKey.trim();
    if (!normalizedKey) return;

    const existing = this.buckets.get(normalizedKey) ?? [];
    const nextEntries = [...existing, entry];
    if (nextEntries.length > this.maxMessagesPerGroup) {
      nextEntries.splice(0, nextEntries.length - this.maxMessagesPerGroup);
    }

    this.buckets.delete(normalizedKey);
    this.buckets.set(normalizedKey, nextEntries);

    while (this.buckets.size > this.maxGroups) {
      const oldestKey = this.buckets.keys().next().value;
      if (!oldestKey) break;
      this.buckets.delete(oldestKey);
    }
  }

  get(groupScopeKey: string): GroupRecentContextEntry[] {
    const normalizedKey = groupScopeKey.trim();
    if (!normalizedKey) return [];

    const bucket = this.buckets.get(normalizedKey);
    if (!bucket?.length) return [];

    this.buckets.delete(normalizedKey);
    this.buckets.set(normalizedKey, bucket);
    return [...bucket];
  }

  remove(groupScopeKey: string, entry: GroupRecentContextEntry): void {
    const normalizedKey = groupScopeKey.trim();
    if (!normalizedKey) return;

    const bucket = this.buckets.get(normalizedKey);
    if (!bucket?.length) return;

    const nextBucket = bucket.filter(
      (current) =>
        !(
          current.messageId === entry.messageId &&
          current.userId === entry.userId &&
          current.renderedText === entry.renderedText &&
          current.capturedAt === entry.capturedAt
        ),
    );

    this.buckets.delete(normalizedKey);
    if (!nextBucket.length) return;
    this.buckets.set(normalizedKey, nextBucket);
  }

  consume(
    groupScopeKey: string,
    options: {
      limit?: number;
      exclude?: (entry: GroupRecentContextEntry) => boolean;
    } = {},
  ): GroupRecentContextEntry[] {
    const normalizedKey = groupScopeKey.trim();
    if (!normalizedKey) return [];

    const bucket = this.buckets.get(normalizedKey);
    if (!bucket?.length) return [];

    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit as number)) : DEFAULT_RECENT_CONTEXT_TAIL_LIMIT;
    const exclude = options.exclude ?? (() => false);
    const retained: GroupRecentContextEntry[] = [];
    const consumed: GroupRecentContextEntry[] = [];

    for (let index = bucket.length - 1; index >= 0; index -= 1) {
      const entry = bucket[index];
      if (exclude(entry)) {
        retained.unshift(entry);
        continue;
      }

      if (consumed.length < limit) {
        consumed.unshift(entry);
      }
    }

    this.buckets.delete(normalizedKey);
    if (retained.length > 0) {
      this.buckets.set(normalizedKey, retained);
    }

    return consumed;
  }

  clear(): void {
    this.buckets.clear();
  }
}

export const groupRecentContextCache = new GroupRecentContextCache();

function normalizeGroupId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function resolveGroupId(session: SessionLike): string | null {
  return normalizeGroupId(session.guildId) ?? normalizeGroupId(session.channelId);
}

export function buildGroupScopeKey(session: SessionLike): string | null {
  if (session.isDirect) return null;

  const groupId = resolveGroupId(session);
  if (!groupId) return null;

  const platform = session.platform?.trim() || 'default-platform';
  const botSelfId = session.bot?.selfId?.trim() || 'default-bot';
  return `${platform}:${botSelfId}:group:${groupId}`;
}

function sanitizeContextText(text: string): string {
  return text
    .replace(/\[CQ:reply,[^\]]+\]/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/\[CQ:image,[^\]]+\]/gi, ' ')
    .trim();
}

function normalizeMessageContent(session: SessionLike): string {
  const stripped = typeof session.stripped?.content === 'string' ? sanitizeContextText(session.stripped.content) : '';
  if (stripped) return stripped;
  return typeof session.content === 'string' ? sanitizeContextText(session.content) : '';
}

function normalizeImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function extractImageUrlsFromElements(session: SessionLike): string[] {
  const elements = Array.isArray(session.elements) ? session.elements : [];
  return [...new Set(elements
    .map((element) => {
      const typedElement =
        element && typeof element === 'object'
          ? (element as { type?: unknown; attrs?: Record<string, unknown> })
          : null;
      const type = typeof typedElement?.type === 'string' ? typedElement.type.toLowerCase() : '';
      if (type !== 'img' && type !== 'image') return null;

      const attrs = typedElement?.attrs ?? {};
      return (
        normalizeImageUrl(attrs.imageUrl) ??
        normalizeImageUrl(attrs.url) ??
        normalizeImageUrl(attrs.src)
      );
    })
    .filter((url): url is string => Boolean(url)))];
}

function extractImageUrlsFromRawContent(rawContent: string): string[] {
  const urls = [
    ...rawContent.matchAll(/<img\b[^>]*\bsrc=(["'])(.*?)\1/gi),
  ].map((match) => match[2]?.trim() ?? '').filter(Boolean);

  for (const match of rawContent.matchAll(/\[CQ:image,([^\]]+)\]/gi)) {
    const attrs = match[1] ?? '';
    const resolved =
      attrs.match(/(?:^|,)url=([^,\]]+)/i)?.[1] ??
      attrs.match(/(?:^|,)src=([^,\]]+)/i)?.[1] ??
      attrs.match(/(?:^|,)file=(base64:\/\/[^,\]]+)/i)?.[1] ??
      attrs.match(/(?:^|,)file=(data:image[^,\]]+)/i)?.[1];
    if (resolved?.trim()) {
      urls.push(resolved.trim());
    }
  }

  return [...new Set(urls)];
}

function collectImageUrls(session: SessionLike): string[] {
  const elementUrls = extractImageUrlsFromElements(session);
  if (elementUrls.length > 0) return elementUrls;

  const rawContent = typeof session.content === 'string' ? session.content : '';
  if (!rawContent) return [];
  return extractImageUrlsFromRawContent(rawContent);
}

function countImageInputParts(session: SessionLike): number {
  const imageUrls = collectImageUrls(session);
  if (imageUrls.length > 0) return imageUrls.length;

  const rawContent = typeof session.content === 'string' ? session.content : '';
  const cqMatches = rawContent.match(/\[CQ:image,[^\]]+\]/gi)?.length ?? 0;
  const tagMatches = rawContent.match(/<img\b/gi)?.length ?? 0;
  return cqMatches + tagMatches;
}

function formatSpeakerName(name: string): string {
  return JSON.stringify(name);
}

function formatSpeakerLine(speakerId: string, speakerName: string, text: string): string {
  const prefix = `[speaker_id=${speakerId} speaker_name=${formatSpeakerName(speakerName)}]`;
  return text ? `${prefix} ${text}` : prefix;
}

function buildImagePlaceholder(imageCount: number): string {
  return imageCount > 1 ? `[图片x${imageCount}]` : '[图片]';
}

function buildRenderedBody(text: string, imageCount: number): string {
  const normalizedText = text.trim();
  if (imageCount < 1) return normalizedText;

  const placeholder = buildImagePlaceholder(imageCount);
  if (!normalizedText) return placeholder;
  return `${normalizedText}\n${placeholder}`;
}

function resolveSpeakerName(session: SessionLike, userId: string): string {
  return resolveSessionDisplayName({
    author: session.author
      ? {
          ...(typeof session.author.nick === 'string' ? { nick: session.author.nick } : {}),
          ...(typeof session.author.name === 'string' ? { name: session.author.name } : {}),
        }
      : undefined,
    username: typeof session.username === 'string' ? session.username : undefined,
    userId,
  });
}

function buildSessionSnapshot(session: SessionLike): SessionLike {
  return {
    platform: session.platform,
    bot: session.bot,
    guildId: session.guildId,
    channelId: session.channelId,
    userId: session.userId,
    isDirect: session.isDirect,
    messageId: session.messageId,
    content: session.content,
    stripped: session.stripped ? { content: session.stripped.content } : undefined,
    elements: Array.isArray(session.elements) ? [...session.elements] : undefined,
    author: session.author
      ? {
          ...(typeof session.author.nick === 'string' ? { nick: session.author.nick } : {}),
          ...(typeof session.author.name === 'string' ? { name: session.author.name } : {}),
        }
      : undefined,
    username: session.username,
  };
}

function buildRenderedContextPayload(session: SessionLike): {
  userId: string;
  speakerName: string;
  renderedText: string;
  imageCount: number;
} | null {
  const userId = typeof session.userId === 'string' ? session.userId.trim() : '';
  if (!userId || userId === session.bot?.selfId) return null;

  const text = normalizeMessageContent(session);
  const imageCount = countImageInputParts(session);
  if (!text && imageCount < 1) return null;

  const speakerName = resolveSpeakerName(session, userId);
  return {
    userId,
    speakerName,
    imageCount,
    renderedText: formatSpeakerLine(userId, speakerName, buildRenderedBody(text, imageCount)),
  };
}

function isCurrentSessionEntry(
  entry: GroupRecentContextEntry,
  session: SessionLike,
): boolean {
  const currentMessageId =
    typeof session.messageId === 'string' && session.messageId.trim() ? session.messageId.trim() : null;
  if (currentMessageId) {
    return entry.messageId === currentMessageId;
  }

  const payload = buildRenderedContextPayload(session);
  if (!payload) return false;
  return entry.userId === payload.userId && entry.renderedText === payload.renderedText;
}

export function capturePassiveGroupRecentContext(session: SessionLike): GroupRecentContextEntry | null {
  const groupScopeKey = buildGroupScopeKey(session);
  if (!groupScopeKey) return null;

  const payload = buildRenderedContextPayload(session);
  if (!payload) return null;

  const entry: GroupRecentContextEntry = {
    messageId:
      typeof session.messageId === 'string' && session.messageId.trim() ? session.messageId.trim() : null,
    userId: payload.userId,
    speakerName: payload.speakerName,
    renderedText: payload.renderedText,
    imageCount: payload.imageCount,
    sessionSnapshot: buildSessionSnapshot(session),
    capturedAt: Date.now(),
  };
  groupRecentContextCache.append(groupScopeKey, entry);
  return entry;
}

export function consumePassiveGroupRecentContext(
  session: SessionLike,
  limit = DEFAULT_RECENT_CONTEXT_TAIL_LIMIT,
): GroupRecentContextEntry[] {
  const groupScopeKey = buildGroupScopeKey(session);
  if (!groupScopeKey) return [];

  return groupRecentContextCache.consume(groupScopeKey, {
    limit,
    exclude: (entry) => isCurrentSessionEntry(entry, session),
  });
}

function isTextContentPart(part: unknown): part is MessageContentComplex & { type: 'text'; text: string } {
  return Boolean(
    part &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string',
  );
}

function formatSpeakerTaggedMessageContent(
  content: MessageContent,
  speakerId: string,
  speakerName: string,
): MessageContent {
  if (typeof content === 'string') {
    return formatSpeakerLine(speakerId, speakerName, content);
  }

  if (!Array.isArray(content)) {
    return formatSpeakerLine(speakerId, speakerName, '');
  }

  const parts = content.filter((part): part is MessageContentComplex => Boolean(part && typeof part === 'object'));
  const textIndex = parts.findIndex((part) => isTextContentPart(part));
  if (textIndex < 0) {
    return [
      { type: 'text', text: formatSpeakerLine(speakerId, speakerName, '') },
      ...parts,
    ];
  }

  return parts.map((part, index) => {
    if (index !== textIndex || !isTextContentPart(part)) {
      return part;
    }

    return {
      ...part,
      text: formatSpeakerLine(speakerId, speakerName, part.text),
    } satisfies MessageContentComplex;
  });
}

export function buildGroupRecentContextFallbackContent(entry: GroupRecentContextEntry): MessageContent | null {
  const text = normalizeMessageContent(entry.sessionSnapshot);
  const imageUrls = collectImageUrls(entry.sessionSnapshot);
  if (!text && imageUrls.length < 1) return null;

  if (imageUrls.length < 1) return text;

  const parts: MessageContentComplex[] = imageUrls.map((url) => ({
    type: 'image_url',
    image_url: { url },
  }));
  if (text) {
    parts.unshift({ type: 'text', text });
  }

  return parts;
}

export function toGroupRecentContextHistoryMessage(
  entry: GroupRecentContextEntry,
  options: { content?: MessageContent } = {},
): HumanMessage {
  const content =
    options.content !== undefined
      ? formatSpeakerTaggedMessageContent(options.content, entry.userId, entry.speakerName)
      : entry.renderedText;
  return new HumanMessage({
    content,
    id: entry.userId,
    additional_kwargs: {
      qqbot_speaker_format: {
        version: 'speaker_id_v1',
        speakerId: entry.userId,
        speakerName: entry.speakerName,
        isDirect: false,
        preformatted: true,
      },
    },
  });
}
