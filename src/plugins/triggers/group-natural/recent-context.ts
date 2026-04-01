import { resolveSessionDisplayName } from '../../shared/session/index.js';

const DEFAULT_MAX_GROUPS = 128;
const DEFAULT_MAX_MESSAGES_PER_GROUP = 24;

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

type PromptRuntimeMessageLike = {
  id?: unknown;
  name?: string;
  content?: unknown;
  additional_kwargs?: Record<string, unknown>;
  getType: () => string;
};

type PromptRuntimeLike = {
  chatHistory?: PromptRuntimeMessageLike[];
  input?: PromptRuntimeMessageLike | null;
  configurable?: {
    session?: SessionLike | null;
  } | null;
};

export interface GroupRecentContextEntry {
  messageId: string | null;
  userId: string;
  renderedText: string;
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

function normalizeMessageContent(session: SessionLike): string {
  const stripped = typeof session.stripped?.content === 'string' ? session.stripped.content.trim() : '';
  if (stripped) return stripped;
  return typeof session.content === 'string' ? session.content.trim() : '';
}

function countImageInputParts(session: SessionLike): number {
  const elements = Array.isArray(session.elements) ? session.elements : [];
  const elementCount = elements.filter((element) => {
    const type =
      typeof (element as { type?: unknown } | null | undefined)?.type === 'string'
        ? String((element as { type?: unknown }).type).toLowerCase()
        : '';
    return type === 'img' || type === 'image';
  }).length;
  if (elementCount > 0) return elementCount;

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

function flattenInputContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      return typeof (part as { text?: unknown }).text === 'string'
        ? String((part as { text?: unknown }).text).trim()
        : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function isCurrentTurnEntry(
  entry: GroupRecentContextEntry,
  session: SessionLike,
  currentInput: PromptRuntimeLike['input'],
): boolean {
  const currentMessageId =
    typeof session.messageId === 'string' && session.messageId.trim() ? session.messageId.trim() : null;
  if (currentMessageId) {
    return entry.messageId === currentMessageId;
  }

  const currentUserId =
    typeof currentInput?.id === 'string' && currentInput.id.trim()
      ? currentInput.id.trim()
      : typeof session.userId === 'string' && session.userId.trim()
        ? session.userId.trim()
        : null;
  if (!currentUserId || entry.userId !== currentUserId) return false;

  const currentRenderedText = flattenInputContent(currentInput?.content);
  if (!currentRenderedText) return false;
  return entry.renderedText === currentRenderedText;
}

export function capturePassiveGroupRecentContext(session: SessionLike): GroupRecentContextEntry | null {
  const groupScopeKey = buildGroupScopeKey(session);
  if (!groupScopeKey) return null;

  const userId = typeof session.userId === 'string' ? session.userId.trim() : '';
  if (!userId || userId === session.bot?.selfId) return null;

  const text = normalizeMessageContent(session);
  const imageCount = countImageInputParts(session);
  if (!text && imageCount < 1) return null;

  const renderedText = formatSpeakerLine(
    userId,
    resolveSessionDisplayName({
      author: session.author
        ? {
            ...(typeof session.author.nick === 'string' ? { nick: session.author.nick } : {}),
            ...(typeof session.author.name === 'string' ? { name: session.author.name } : {}),
          }
        : undefined,
      username: typeof session.username === 'string' ? session.username : undefined,
      userId,
    }),
    buildRenderedBody(text, imageCount),
  );

  const entry: GroupRecentContextEntry = {
    messageId:
      typeof session.messageId === 'string' && session.messageId.trim() ? session.messageId.trim() : null,
    userId,
    renderedText,
    capturedAt: Date.now(),
  };
  groupRecentContextCache.append(groupScopeKey, entry);
  return entry;
}

export function replaceRuntimeChatHistoryWithGroupRecentContext(
  runtime: PromptRuntimeLike,
): void {
  const session = runtime.configurable?.session as SessionLike | undefined;
  if (!session || session.isDirect) return;

  const groupScopeKey = buildGroupScopeKey(session);
  if (!groupScopeKey) return;

  const cachedEntries = groupRecentContextCache
    .get(groupScopeKey)
    .filter((entry) => !isCurrentTurnEntry(entry, session, runtime.input));

  runtime.chatHistory = cachedEntries.map((entry) => ({
    content: entry.renderedText,
    id: entry.userId,
    getType: () => 'human',
  }));
}
