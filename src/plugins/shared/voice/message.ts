import { h } from 'koishi';
import { formatMentionText } from '../mention-text.js';

export interface IncomingVoiceElement {
  src?: string;
  file?: string;
  audioCount: number;
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
      const mention = formatMentionText({
        name: typeof element.attrs?.name === 'string' ? element.attrs.name : undefined,
        id: typeof element.attrs?.id === 'string' ? element.attrs.id : undefined,
      });
      if (mention) parts.push(mention);
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
