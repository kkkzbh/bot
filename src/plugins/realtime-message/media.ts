import { HumanMessage, type MessageContent, type MessageContentComplex } from '@langchain/core/messages';
import type { Session } from 'koishi';
import { mergeVoiceInputText } from '../shared/voice/index.js';
import type { RealtimeMessageEntry } from './types.js';

type MessageTransformerLike = {
  transform: (
    session: unknown,
    message: unknown[],
    model?: string,
    command?: unknown,
    options?: Record<string, unknown>,
  ) => Promise<{ content?: unknown }>;
};

type PromotionRoom = {
  model?: string;
};

type ChatLunaMediaLike = {
  messageTransformer?: MessageTransformerLike;
};

function formatSpeakerName(name: string): string {
  return JSON.stringify(name);
}

export function formatRealtimeSpeakerLine(userId: string, speakerName: string, text: string): string {
  const prefix = `[speaker_id=${userId} speaker_name=${formatSpeakerName(speakerName)}]`;
  return text ? `${prefix} ${text}` : prefix;
}

function isTextContentPart(part: unknown): part is MessageContentComplex & { type: 'text'; text: string } {
  return Boolean(
    part &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string',
  );
}

function hasNonTextContentPart(content: MessageContent): boolean {
  return Array.isArray(content)
    && content.some((part) => typeof part === 'object' && part != null && (part as { type?: unknown }).type !== 'text');
}

function mergeVisibleText(baseText: string, extraText: string): string {
  if (!baseText.trim()) return extraText.trim();
  if (!extraText.trim()) return baseText.trim();
  return mergeVoiceInputText(baseText, extraText);
}

export function buildRealtimeVisibleText(entry: RealtimeMessageEntry): string {
  return mergeVisibleText(entry.text, entry.voiceTranscript ?? '');
}

function mergeTextIntoContent(content: MessageContent, extraText: string): MessageContent {
  const visibleText = extraText.trim();
  if (!visibleText) return content;

  if (typeof content === 'string') {
    return mergeVisibleText(content, visibleText);
  }

  if (!Array.isArray(content)) {
    return [{ type: 'text', text: visibleText }];
  }

  const parts = content.filter((part): part is MessageContentComplex => Boolean(part && typeof part === 'object'));
  const textIndex = parts.findIndex((part) => isTextContentPart(part));
  if (textIndex < 0) {
    return [{ type: 'text', text: visibleText }, ...parts];
  }

  return parts.map((part, index) => {
    if (index !== textIndex || !isTextContentPart(part)) {
      return part;
    }

    return {
      ...part,
      text: mergeVisibleText(part.text, visibleText),
    } satisfies MessageContentComplex;
  });
}

function formatSpeakerTaggedContent(
  content: MessageContent,
  speakerId: string,
  speakerName: string,
): MessageContent {
  if (typeof content === 'string') {
    return formatRealtimeSpeakerLine(speakerId, speakerName, content);
  }

  if (!Array.isArray(content)) {
    return formatRealtimeSpeakerLine(speakerId, speakerName, '');
  }

  const parts = content.filter((part): part is MessageContentComplex => Boolean(part && typeof part === 'object'));
  const textIndex = parts.findIndex((part) => isTextContentPart(part));
  if (textIndex < 0) {
    return [{ type: 'text', text: formatRealtimeSpeakerLine(speakerId, speakerName, '') }, ...parts];
  }

  return parts.map((part, index) => {
    if (index !== textIndex || !isTextContentPart(part)) {
      return part;
    }

    return {
      ...part,
      text: formatRealtimeSpeakerLine(speakerId, speakerName, part.text),
    } satisfies MessageContentComplex;
  });
}

export async function buildRealtimeHistoryContent(
  chatluna: ChatLunaMediaLike,
  room: PromotionRoom,
  entry: RealtimeMessageEntry,
): Promise<MessageContent | undefined> {
  if (entry.imageUrls.length < 1) return undefined;

  const messageTransformer = chatluna.messageTransformer;
  const elements = Array.isArray(entry.sessionSnapshot.elements) ? entry.sessionSnapshot.elements : [];
  const model = typeof room.model === 'string' ? room.model : '';

  if (!messageTransformer || elements.length < 1) return undefined;

  try {
    const transformed = await messageTransformer.transform(
      entry.sessionSnapshot as unknown as Session,
      elements,
      model,
      undefined,
      {
        quote: false,
        includeQuoteReply: false,
      },
    );
    const content = transformed?.content as MessageContent | undefined;
    if (content === undefined || !hasNonTextContentPart(content)) {
      return undefined;
    }

    return mergeTextIntoContent(content, buildRealtimeVisibleText(entry));
  } catch {
    return undefined;
  }
}

export function buildRealtimeMessageFallbackContent(entry: RealtimeMessageEntry): MessageContent | null {
  const visibleText = buildRealtimeVisibleText(entry);
  if (entry.imageUrls.length < 1) {
    return visibleText || null;
  }

  const parts: MessageContentComplex[] = entry.imageUrls.map((url) => ({
    type: 'image_url',
    image_url: { url },
  }));
  if (visibleText) {
    parts.unshift({ type: 'text', text: visibleText });
  }

  return parts;
}

export function toRealtimeHistoryMessage(
  entry: RealtimeMessageEntry,
  options: { content?: MessageContent } = {},
): HumanMessage {
  const content =
    options.content !== undefined
      ? formatSpeakerTaggedContent(options.content, entry.userId, entry.speakerName)
      : formatRealtimeSpeakerLine(entry.userId, entry.speakerName, buildRealtimeVisibleText(entry));

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
