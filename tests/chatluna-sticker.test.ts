import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, extractStickerTag, loadStickerIndex, type StickerEntry } from '../src/plugins/chatluna-sticker.js';

// ---------------------------------------------------------------------------
// Mock koishi (same pattern as web-search.test.ts)
// ---------------------------------------------------------------------------

vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
  });

  class MockLogger {
    info(): void {}
    warn(): void {}
    debug(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      string: () => createSchemaNode(),
    },
    h: {
      image: (buffer: Buffer, mime: string) => `<img src="data:${mime};base64,${buffer.toString('base64')}" />`,
    },
  };
});

// ---------------------------------------------------------------------------
// Mock yaml
// ---------------------------------------------------------------------------

let mockYamlContent: unknown = {};

vi.mock('yaml', () => ({
  parse: () => mockYamlContent,
}));

// ---------------------------------------------------------------------------
// Mock node:fs
// ---------------------------------------------------------------------------

const mockFiles = new Map<string, string | Buffer>();

vi.mock('node:fs', () => ({
  readFileSync: (filePath: string, encoding?: string) => {
    const content = mockFiles.get(filePath);
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    if (encoding === 'utf-8') return typeof content === 'string' ? content : content.toString('utf-8');
    return content;
  },
}));

// ---------------------------------------------------------------------------
// extractStickerTag tests
// ---------------------------------------------------------------------------

describe('extractStickerTag', () => {
  it('extracts tag from a plain string', () => {
    expect(extractStickerTag('smug')).toBe('smug');
  });

  it('extracts tag from an object with "tag" field', () => {
    expect(extractStickerTag({ tag: 'bored' })).toBe('bored');
  });

  it('extracts tag from an object with "name" field', () => {
    expect(extractStickerTag({ name: 'piano' })).toBe('piano');
  });

  it('extracts tag from a JSON-stringified object', () => {
    expect(extractStickerTag('{"tag":"cold"}')).toBe('cold');
  });

  it('extracts tag from nested args object', () => {
    expect(extractStickerTag({ args: { tag: 'embarrassed' } })).toBe('embarrassed');
  });

  it('extracts tag from a single-entry object with unknown key', () => {
    expect(extractStickerTag({ whatever: 'smug' })).toBe('smug');
  });

  it('returns empty string for null/undefined', () => {
    expect(extractStickerTag(null)).toBe('');
    expect(extractStickerTag(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(extractStickerTag('')).toBe('');
    expect(extractStickerTag('   ')).toBe('');
  });

  it('extracts from deeply nested JSON string', () => {
    expect(extractStickerTag('{"args":{"tag":"cold"}}')).toBe('cold');
  });

  it('handles array input by returning first non-empty tag', () => {
    expect(extractStickerTag(['', 'smug'])).toBe('smug');
  });
});

// ---------------------------------------------------------------------------
// loadStickerIndex tests
// ---------------------------------------------------------------------------

describe('loadStickerIndex', () => {
  beforeEach(() => {
    mockFiles.clear();
    mockYamlContent = {};
  });

  afterEach(() => {
    mockFiles.clear();
    mockYamlContent = {};
  });

  it('returns empty map when index.yml does not exist', () => {
    const result = loadStickerIndex('/nonexistent/dir');
    expect(result.size).toBe(0);
  });

  it('returns empty map when stickers key is missing', () => {
    mockFiles.set('/test/stickers/index.yml', 'other: true');
    mockYamlContent = { other: true };
    const result = loadStickerIndex('/test/stickers');
    expect(result.size).toBe(0);
  });

  it('loads stickers with valid files', () => {
    const imgBuffer = Buffer.from('fake-png-data');
    mockFiles.set('/test/stickers/index.yml', 'stickers: ...');
    mockFiles.set('/test/stickers/images/smug.png', imgBuffer);
    mockFiles.set('/test/stickers/images/bored.jpg', imgBuffer);

    mockYamlContent = {
      stickers: {
        smug: { file: 'images/smug.png', description: '得意' },
        bored: { file: 'images/bored.jpg', description: '无聊' },
      },
    };

    const result = loadStickerIndex('/test/stickers');
    expect(result.size).toBe(2);

    const smug = result.get('smug') as StickerEntry;
    expect(smug.tag).toBe('smug');
    expect(smug.mime).toBe('image/png');
    expect(smug.description).toBe('得意');
    expect(smug.buffer).toEqual(imgBuffer);

    const bored = result.get('bored') as StickerEntry;
    expect(bored.mime).toBe('image/jpeg');
  });

  it('skips entries with missing file field', () => {
    mockFiles.set('/test/stickers/index.yml', 'stickers: ...');
    mockYamlContent = {
      stickers: {
        broken: { description: 'no file field' },
      },
    };

    const result = loadStickerIndex('/test/stickers');
    expect(result.size).toBe(0);
  });

  it('skips entries when image file is not readable', () => {
    mockFiles.set('/test/stickers/index.yml', 'stickers: ...');
    mockYamlContent = {
      stickers: {
        missing: { file: 'images/missing.png', description: 'gone' },
      },
    };

    const result = loadStickerIndex('/test/stickers');
    expect(result.size).toBe(0);
  });

  it('handles gif and webp mime types', () => {
    const imgBuffer = Buffer.from('fake');
    mockFiles.set('/test/stickers/index.yml', 'stickers: ...');
    mockFiles.set('/test/stickers/images/anim.gif', imgBuffer);
    mockFiles.set('/test/stickers/images/modern.webp', imgBuffer);

    mockYamlContent = {
      stickers: {
        anim: { file: 'images/anim.gif', description: 'animated' },
        modern: { file: 'images/modern.webp', description: 'webp' },
      },
    };

    const result = loadStickerIndex('/test/stickers');
    expect(result.get('anim')?.mime).toBe('image/gif');
    expect(result.get('modern')?.mime).toBe('image/webp');
  });
});

describe('apply', () => {
  beforeEach(() => {
    mockFiles.clear();
    mockYamlContent = {};
  });

  afterEach(() => {
    mockFiles.clear();
    mockYamlContent = {};
  });

  it('registers sticker tool for private chats only', async () => {
    const imgBuffer = Buffer.from('fake-png-data');
    mockFiles.set('/test/stickers/index.yml', 'stickers: ...');
    mockFiles.set('/test/stickers/images/bored.png', imgBuffer);
    mockYamlContent = {
      stickers: {
        bored: { file: 'images/bored.png', description: '无聊' },
      },
    };

    const readyHandlers: Array<() => unknown> = [];
    const platform = {
      registerTool: vi.fn(),
    };
    const ctx = {
      chatluna: { platform },
      on: vi.fn((name: string, handler: () => unknown) => {
        if (name === 'ready') readyHandlers.push(handler);
      }),
      setInterval: vi.fn(),
    };

    apply(ctx as never, { stickerDir: '/test/stickers' });
    await readyHandlers[0]?.();

    expect(platform.registerTool).toHaveBeenCalledTimes(1);
    const toolDescriptor = platform.registerTool.mock.calls[0]?.[1] as {
      authorization?: (session: { isDirect?: boolean }) => boolean;
    };

    expect(toolDescriptor.authorization?.({ isDirect: true })).toBe(true);
    expect(toolDescriptor.authorization?.({ isDirect: false })).toBe(false);
  });
});
