import { describe, expect, it } from 'vitest';

import {
  buildStickerCapabilityPolicy,
  resolveStickerSelection,
  type LoadedStickerCatalog,
} from '../src/plugins/chatluna-sticker-core.js';

function createCatalog(): LoadedStickerCatalog {
  const entries = [
    {
      id: 'bored',
      file: 'images/personas/sakiko/bored.png',
      hash: 'hash-bored',
      mime: 'image/png',
      scopes: ['persona:sakiko'],
      caption: '银发二次元少女配六个省略号的无语表情包',
      keywords: ['省略号', '面无表情'],
      moods: ['无语', '茫然'],
      scenes: ['聊天互动'],
      historyLabel: '省略号无语少女',
      confidence: 0.95,
      buffer: Buffer.from('bored'),
    },
    {
      id: 'embarrassed',
      file: 'images/personas/sakiko/embarrassed.gif',
      hash: 'hash-embarrassed',
      mime: 'image/gif',
      scopes: ['persona:sakiko'],
      caption: '蓝发二次元少女愤怒噘嘴的表情包',
      keywords: ['生气表情', '噘嘴'],
      moods: ['愤怒', '气恼', '不满'],
      scenes: ['情绪表达'],
      historyLabel: '生气噘嘴少女',
      confidence: 0.94,
      buffer: Buffer.from('embarrassed'),
    },
  ];

  return {
    version: 1,
    generatedAt: '2026-03-16T00:00:00.000Z',
    model: 'doubao-seed-2-0-mini-260215',
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
  };
}

describe('chatluna sticker core', () => {
  it('describes how to split multi-sticker intent into distinct sticker segments', () => {
    const policy = buildStickerCapabilityPolicy({
      catalog: createCatalog(),
      preset: 'sakiko',
    });

    expect(policy).toContain('连续发多张表情包');
    expect(policy).toContain('严格保持用户要求的先后顺序');
    expect(policy).toContain('不要把“连续发两张”“先……再……”这类整句要求原样抄进每个 sticker.content');
    expect(policy).toContain('相邻 sticker 段默认不要重复同一句 content');
    expect(policy).toContain(
      '多张示例：{"segments":[{"kind":"sticker","content":"无语地看对方一眼"},{"kind":"sticker","content":"生气地噘嘴表达不满"}]}',
    );
  });

  it('maps narrow per-sticker intents to different sticker assets', () => {
    const catalog = createCatalog();

    expect(resolveStickerSelection(catalog, '无语地看对方一眼', 'sakiko')?.id).toBe('bored');
    expect(resolveStickerSelection(catalog, '生气地噘嘴表达不满', 'sakiko')?.id).toBe('embarrassed');
  });
});
