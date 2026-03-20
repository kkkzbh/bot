import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
    min: () => MockSchemaNode;
    max: () => MockSchemaNode;
    role: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
    min: () => createSchemaNode(),
    max: () => createSchemaNode(),
    role: () => createSchemaNode(),
  });

  const parseAttrs = (input: string) => {
    const attrs: Record<string, string> = {};
    for (const matched of input.matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[matched[1]] = matched[2];
    }
    return attrs;
  };

  const parse = (content: string) => {
    const elements: Array<{ type: string; attrs: Record<string, string>; children: never[] }> = [];
    const pattern = /<(audio|at)\b([\s\S]*?)\/>/gi;
    let lastIndex = 0;
    let matched: RegExpExecArray | null;

    while ((matched = pattern.exec(content))) {
      const text = content.slice(lastIndex, matched.index);
      if (text) {
        elements.push({ type: 'text', attrs: { content: text }, children: [] });
      }
      elements.push({ type: matched[1], attrs: parseAttrs(matched[2] ?? ''), children: [] });
      lastIndex = pattern.lastIndex;
    }

    const tail = content.slice(lastIndex);
    if (tail) {
      elements.push({ type: 'text', attrs: { content: tail }, children: [] });
    }

    return elements;
  };

  return {
    Context: class {},
    Logger: class {},
    Schema: {
      object: () => createSchemaNode(),
      boolean: () => createSchemaNode(),
      string: () => createSchemaNode(),
      natural: () => createSchemaNode(),
      number: () => createSchemaNode(),
      array: () => createSchemaNode(),
      union: () => createSchemaNode(),
      const: () => createSchemaNode(),
    },
    h: {
      parse,
      audio: (src: string) => ({
        toString: () => `<audio src="${src}"/>`,
      }),
    },
  };
});

import {
  buildVoiceFailureReply,
  extractFirstIncomingVoice,
  extractTextContentWithoutVoice,
  mergeVoiceInputText,
  normalizeVoiceSynthesisText,
  pickVoiceStyle,
} from '../src/plugins/reply/voice/tts.js';

describe('qq voice core', () => {
  it('extracts first incoming audio and counts all audio segments', () => {
    expect(extractFirstIncomingVoice('<audio src="https://example.com/a.amr"/>你好<audio file="second"/>')).toEqual({
      src: 'https://example.com/a.amr',
      file: undefined,
      audioCount: 2,
    });
  });

  it('extracts non-audio text content from mixed messages', () => {
    expect(extractTextContentWithoutVoice('<audio src="https://example.com/a.amr"/>你好呀<at id="123" name="祥子"/>')).toBe(
      '你好呀 @祥子',
    );
  });

  it('merges transcript with existing text without duplicating nested content', () => {
    expect(mergeVoiceInputText('前缀说明', '语音正文')).toBe('前缀说明\n语音正文');
    expect(mergeVoiceInputText('前缀说明 语音正文', '语音正文')).toBe('前缀说明 语音正文');
  });

  it('chooses negative voice style from text tone', () => {
    expect(pickVoiceStyle('……与你无关')).toBe('black');
    expect(pickVoiceStyle('晚安吧')).toBe('white');
  });

  it('normalizes synthesis text and provides persona failure replies', () => {
    expect(normalizeVoiceSynthesisText('  你好\n\n世界  ')).toBe('你好 世界');
    expect(normalizeVoiceSynthesisText('头发的事情怎么样了？5cm还是3.5cm？')).toBe(
      '头发的事情怎么样了？五厘米还是三点五厘米？',
    );
    expect(buildVoiceFailureReply('too-long', 60)).toContain('60秒');
    expect(buildVoiceFailureReply('empty')).toContain('几乎什么都没有');
    expect(buildVoiceFailureReply('broken')).toContain('没听清');
  });
});
