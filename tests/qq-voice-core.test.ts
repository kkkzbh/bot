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
  containsExplicitVoiceRequest,
  containsVoiceReplyControl,
  extractFirstIncomingVoice,
  extractTextContentWithoutVoice,
  mergeVoiceInputText,
  normalizeVoiceSynthesisText,
  parseVoiceReplyControl,
  pickVoiceStyle,
} from '../src/plugins/qq-voice-core.js';

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

  it('parses qqbot voice reply blocks into text plus first voice text', () => {
    expect(parseVoiceReplyControl('外层<qqbot-voice>附带语音</qqbot-voice>结尾')).toEqual({
      text: '外层附带语音结尾',
      voiceText: '附带语音',
      voiceTagCount: 1,
    });
    expect(containsVoiceReplyControl('<qqbot-voice>test</qqbot-voice>')).toBe(true);
    expect(containsVoiceReplyControl('&lt;qqbot-voice&gt;test&lt;/qqbot-voice&gt;')).toBe(true);
    expect(parseVoiceReplyControl('&lt;qqbot-voice&gt;晚安&lt;/qqbot-voice&gt;')).toEqual({
      text: '晚安',
      voiceText: '晚安',
      voiceTagCount: 1,
    });
  });

  it('parses qqbot voice reply blocks from structured rich-text content', () => {
    const structured = [
      '晚安\n\n',
      {
        type: 'p',
        attrs: {},
        children: [
          { type: 'text', attrs: { content: '<qqbot-voice>' }, children: [] },
          { type: 'text', attrs: { content: '晚安' }, children: [] },
          { type: 'text', attrs: { content: '</qqbot-voice>' }, children: [] },
        ],
      },
    ];

    expect(containsVoiceReplyControl(structured)).toBe(true);
    expect(parseVoiceReplyControl(structured)).toEqual({
      text: '晚安',
      voiceText: '晚安',
      voiceTagCount: 1,
    });
  });

  it('keeps inline voice blocks in text but removes standalone voice-only lines', () => {
    expect(parseVoiceReplyControl('普通文本<qqbot-voice>附带语音</qqbot-voice>')).toEqual({
      text: '普通文本附带语音',
      voiceText: '附带语音',
      voiceTagCount: 1,
    });
    expect(parseVoiceReplyControl('正文\n<qqbot-voice>晚安</qqbot-voice>')).toEqual({
      text: '正文',
      voiceText: '晚安',
      voiceTagCount: 1,
    });
    expect(parseVoiceReplyControl('<qqbot-voice>晚安</qqbot-voice>')).toEqual({
      text: '晚安',
      voiceText: '晚安',
      voiceTagCount: 1,
    });
  });

  it('detects explicit voice request and chooses negative voice style', () => {
    expect(containsExplicitVoiceRequest('请发一条语音给我听')).toBe(true);
    expect(containsExplicitVoiceRequest('普通闲聊一下')).toBe(false);
    expect(pickVoiceStyle('……与你无关')).toBe('black');
    expect(pickVoiceStyle('晚安吧')).toBe('white');
  });

  it('normalizes synthesis text and provides persona failure replies', () => {
    expect(normalizeVoiceSynthesisText('  你好\n\n世界  ')).toBe('你好 世界');
    expect(buildVoiceFailureReply('too-long', 60)).toContain('60秒');
    expect(buildVoiceFailureReply('empty')).toContain('几乎什么都没有');
    expect(buildVoiceFailureReply('broken')).toContain('没听清');
  });
});
