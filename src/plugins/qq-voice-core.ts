import { h } from 'koishi';
import { hasVoiceSegments, parseOutboundMessagePlan } from './message-send-utils.js';

const NEGATIVE_STYLE_KEYWORDS = [
  '与你无关',
  '请别问了',
  '失陪了',
  '不方便',
  '不想',
  '不要',
  '别再',
  '闭嘴',
  '烦',
  '讨厌',
  '滚',
  '免了',
  '算了',
  '拒绝',
  '住口',
];
const WHITESPACE_PATTERN = /\s+/g;

export interface IncomingVoiceElement {
  src?: string;
  file?: string;
  audioCount: number;
}

export interface ParsedVoiceReplyControl {
  text: string;
  voiceText: string | null;
  voiceTagCount: number;
}

export type VoiceStyle = 'white' | 'black';

export function containsVoiceReplyControl(message: unknown): boolean {
  return hasVoiceSegments(parseOutboundMessagePlan(message));
}

export function parseVoiceReplyControl(message: unknown): ParsedVoiceReplyControl {
  const plan = parseOutboundMessagePlan(message);
  const voiceSegments = plan.segments.filter((segment) => segment.kind === 'voice-block');
  const textSegments = plan.segments.filter((segment) => segment.kind !== 'voice-block');
  const text = textSegments.map((segment) => segment.content).join('\n').trim();

  return {
    text,
    voiceText: voiceSegments[0]?.content ?? null,
    voiceTagCount: voiceSegments.length,
  };
}

export function extractFirstIncomingVoice(content: string): IncomingVoiceElement | null {
  const elements = h.parse(content);
  let firstVoice: IncomingVoiceElement | null = null;
  let audioCount = 0;

  for (const element of elements) {
    if (element.type !== 'audio') continue;
    audioCount += 1;
    if (!firstVoice) {
      firstVoice = {
        src: typeof element.attrs?.src === 'string' ? element.attrs.src : undefined,
        file: typeof element.attrs?.file === 'string' ? element.attrs.file : undefined,
        audioCount: 0,
      };
    }
  }

  if (!firstVoice) return null;
  firstVoice.audioCount = audioCount;
  return firstVoice;
}

export function extractTextContentWithoutVoice(content: string): string {
  const parts: string[] = [];
  const elements = h.parse(content);

  for (const element of elements) {
    if (element.type === 'audio') continue;
    if (element.type === 'text') {
      const text = typeof element.attrs?.content === 'string' ? element.attrs.content : '';
      if (text.trim()) parts.push(text.trim());
      continue;
    }

    if (element.type === 'at') {
      const name = typeof element.attrs?.name === 'string' ? element.attrs.name.trim() : '';
      const id = typeof element.attrs?.id === 'string' ? element.attrs.id.trim() : '';
      if (name) {
        parts.push(`@${name}`);
      } else if (id) {
        parts.push(`@${id}`);
      }
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function mergeVoiceInputText(originalText: string, transcript: string): string {
  const original = originalText.trim();
  const voice = transcript.trim();

  if (!original) return voice;
  if (!voice) return original;
  if (original.includes(voice)) return original;
  if (voice.includes(original)) return voice;

  return `${original}\n${voice}`;
}

export function pickVoiceStyle(text: string): VoiceStyle {
  const normalized = text.replace(WHITESPACE_PATTERN, '');
  return NEGATIVE_STYLE_KEYWORDS.some((keyword) => normalized.includes(keyword)) ? 'black' : 'white';
}

export function normalizeVoiceSynthesisText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

export function buildVoiceFailureReply(kind: 'too-long' | 'empty' | 'broken', maxSeconds = 60): string {
  switch (kind) {
    case 'too-long':
      return `……这段语音未免太长了些\n请控制在${maxSeconds}秒以内\n我可没有空听你漫无边际地拖下去`;
    case 'empty':
      return '……你这段语音里几乎什么都没有\n要么重新说清楚\n要么直接打字';
    case 'broken':
    default:
      return '……这段语音我没听清\n若还想让我回答\n就重新说一遍';
  }
}
