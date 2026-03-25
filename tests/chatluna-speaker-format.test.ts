import { describe, expect, it } from 'vitest';
import { serializeQqbotHumanMessageContent } from '../../chatluna/packages/core/src/utils/qqbot_speaker';

describe('chatluna qqbot speaker serialization', () => {
  const speakerMeta = {
    qqbot_speaker_format: {
      version: 'speaker_id_v1' as const,
      speakerId: 'u2',
      speakerName: '小祥',
      isDirect: false,
    },
  };

  it('serializes group text messages with speaker_id lines', () => {
    expect(serializeQqbotHumanMessageContent('交个朋友怎么样？', speakerMeta)).toBe(
      '[speaker_id=u2 speaker_name="小祥"] 交个朋友怎么样？',
    );
  });

  it('preserves multimodal parts and rewrites the first text part', () => {
    expect(
      serializeQqbotHumanMessageContent(
        [
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          { type: 'text', text: '看这个' },
        ],
        speakerMeta,
      ),
    ).toEqual([
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      { type: 'text', text: '[speaker_id=u2 speaker_name="小祥"] 看这个' },
    ]);
  });

  it('inserts a speaker line for image-only group messages', () => {
    expect(
      serializeQqbotHumanMessageContent(
        [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
        speakerMeta,
      ),
    ).toEqual([
      { type: 'text', text: '[speaker_id=u2 speaker_name="小祥"]' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ]);
  });

  it('skips private messages and preformatted group messages', () => {
    expect(
      serializeQqbotHumanMessageContent('你好', {
        qqbot_speaker_format: {
          ...speakerMeta.qqbot_speaker_format,
          isDirect: true,
        },
      }),
    ).toBe('你好');

    expect(
      serializeQqbotHumanMessageContent('你好', {
        qqbot_speaker_format: {
          ...speakerMeta.qqbot_speaker_format,
          preformatted: true,
        },
      }),
    ).toBe('你好');
  });
});
