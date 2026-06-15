import { describe, expect, it, vi } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import type { QqbotAttachmentRecord } from '../src/types/attachment.js';
import { resolveReferencedAttachmentsFromCatalog } from '../src/plugins/attachment/resolution.js';

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

  class MockLogger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      natural: () => createSchemaNode(),
      number: () => createSchemaNode(),
      string: () => createSchemaNode(),
    },
  };
});

vi.mock('koishi-plugin-chatluna/utils/string', () => ({
  getMessageContent(content: unknown) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  },
  getMimeTypeFromSource(source: string) {
    if (source.endsWith('.pdf')) return 'application/pdf';
    if (source.endsWith('.mp3')) return 'audio/mpeg';
    if (source.endsWith('.png')) return 'image/png';
    return 'application/octet-stream';
  },
}));

vi.mock('koishi-plugin-chatluna/llm-core/platform/types', () => ({
  ModelCapabilities: {
    ToolCall: 'tool_call',
    ImageInput: 'image_input',
    Thinking: 'thinking',
    ImageGeneration: 'image_generation',
    AudioInput: 'audio_input',
    VideoInput: 'video_input',
    FileInput: 'file_input',
  },
}));

vi.mock('../src/plugins/shared/prompt-context/index.js', () => ({
  registerPromptFragment() {},
}));

vi.mock('../src/plugins/shared/voice/input.js', () => ({
  transcribeAudio: vi.fn(),
}));

import { AttachmentService } from '../src/plugins/attachment/index.js';

function createRecord(input: Partial<QqbotAttachmentRecord> & Pick<QqbotAttachmentRecord, 'refId' | 'conversationId' | 'kind'>): QqbotAttachmentRecord {
  return {
    id: Number(input.id ?? 1),
    refId: input.refId,
    conversationId: input.conversationId,
    messageRole: input.messageRole ?? 'human',
    messageId: input.messageId ?? null,
    senderId: input.senderId ?? null,
    senderName: input.senderName ?? '小祥',
    kind: input.kind,
    filename: input.filename ?? `${input.refId}.${input.kind === 'pdf' ? 'pdf' : 'png'}`,
    mimeType: input.mimeType ?? (input.kind === 'pdf' ? 'application/pdf' : 'image/png'),
    storageFileId: input.storageFileId ?? `${input.refId}-storage`,
    storageUrl: input.storageUrl ?? `http://127.0.0.1:5140/chatluna-storage/temp/${input.refId}`,
    byteSize: input.byteSize ?? 1024,
    hash: input.hash ?? null,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt ?? Date.now(),
    updatedAt: input.updatedAt ?? Date.now(),
  };
}

describe('attachment context resolution', () => {
  it('resolves explicit attachment refs from the structured store', async () => {
    const target = createRecord({
      refId: 'att_demo1234',
      conversationId: 'conv-1',
      kind: 'image',
    });
    const result = await resolveReferencedAttachmentsFromCatalog({
      userText: '请继续分析 att_demo1234',
      recent: [],
      limit: 5,
      resolveByRefs: async (refIds) => (refIds.includes(target.refId) ? [target] : []),
    });

    expect(result.reason).toBe('explicit_ref');
    expect(result.selected.map((item) => item.refId)).toEqual(['att_demo1234']);
    expect(result.ambiguous).toEqual([]);
  });

  it('selects up to five recent images for plural relative references', async () => {
    const recent = Array.from({ length: 6 }, (_, index) =>
      createRecord({
        id: index + 1,
        refId: `att_img${index + 1}`,
        conversationId: 'conv-2',
        kind: 'image',
        createdAt: Date.now() - index * 1000,
      }),
    );
    const result = await resolveReferencedAttachmentsFromCatalog({
      userText: '把这五张图对比一下',
      limit: 5,
      recent,
    });

    expect(result.reason).toBe('relative_batch');
    expect(result.selected).toHaveLength(5);
    expect(result.selected[0].refId).toBe('att_img1');
    expect(result.selected[4].refId).toBe('att_img5');
  });

  it('marks ambiguous pdf references instead of auto-injecting all candidates', async () => {
    const recent = [
      createRecord({
        refId: 'att_pdf1',
        conversationId: 'conv-3',
        kind: 'pdf',
        filename: 'rules.pdf',
      }),
      createRecord({
        refId: 'att_pdf2',
        conversationId: 'conv-3',
        kind: 'pdf',
        filename: 'spec.pdf',
        createdAt: Date.now() - 1000,
      }),
    ];
    const result = await resolveReferencedAttachmentsFromCatalog({
      userText: '那个 pdf 里写了什么？',
      limit: 5,
      recent,
    });

    expect(result.selected).toEqual([]);
    expect(result.ambiguous.map((item) => item.refId)).toEqual(['att_pdf1', 'att_pdf2']);
  });
});

function createMockDatabase(seed?: {
  attachments?: QqbotAttachmentRecord[];
  derivatives?: Array<Record<string, unknown>>;
  providerCache?: Array<Record<string, unknown>>;
}) {
  const tables = {
    qqbot_attachment: [...(seed?.attachments ?? [])],
    qqbot_attachment_derivative: [...(seed?.derivatives ?? [])],
    qqbot_attachment_provider_cache: [...(seed?.providerCache ?? [])],
  } as unknown as Record<string, Array<Record<string, unknown>>>;
  let nextId = 10_000;

  return {
    tables,
    async get(table: string, query: Record<string, unknown>) {
      return (tables[table] ?? []).filter((row) =>
        Object.entries(query).every(([key, value]) => row[key] === value),
      );
    },
    async create(table: string, row: Record<string, unknown>) {
      const created = {
        id: Number(row.id ?? nextId++),
        ...row,
      };
      tables[table] = [...(tables[table] ?? []), created];
      return created;
    },
    async set(table: string, query: Record<string, unknown>, patch: Record<string, unknown>) {
      tables[table] = (tables[table] ?? []).map((row) =>
        Object.entries(query).every(([key, value]) => row[key] === value)
          ? { ...row, ...patch }
          : row,
      );
    },
  };
}

function createAttachmentService(records: QqbotAttachmentRecord[], options?: {
  derivatives?: Array<Record<string, unknown>>;
  providerCache?: Array<Record<string, unknown>>;
}) {
  const database = createMockDatabase({
    attachments: records,
    derivatives: options?.derivatives,
    providerCache: options?.providerCache,
  });
  const ctx = {
    database,
    chatluna_storage: {
      async getTempFile() {
        return null;
      },
    },
    chatluna: {
      platform: {
        findModel() {
          return { value: { capabilities: [] } };
        },
      },
    },
  };

  const runtime = {
    maxInjectCount: 5,
    maxInjectTotalBytes: 16 * 1024 * 1024,
    maxInjectPerFileBytes: 6 * 1024 * 1024,
    maxPdfPreviewPagesPerFile: 6,
    maxPdfPreviewPagesTotal: 15,
    maxTextCharsPerFile: 24_000,
    recentCatalogSize: 12,
    historyWindow: 80,
    historyTriggerCount: 120,
    historyTokenRatio: 0.7,
    projectionTextChars: 1200,
    replayTextChars: 4000,
    replayMaxRefs: 5,
  };

  return {
    service: new AttachmentService(ctx as any, runtime),
    database,
  };
}

describe('attachment multimodal projection', () => {
  it('projects referenced attachments into text-only context instead of rehydrating file blocks', async () => {
    const image = createRecord({
      refId: 'att_image01',
      conversationId: 'conv-projection',
      kind: 'image',
      filename: 'screen.png',
    });
    const pdf = createRecord({
      refId: 'att_pdf01',
      conversationId: 'conv-projection',
      kind: 'pdf',
      filename: 'spec.pdf',
      mimeType: 'application/pdf',
    });
    const { service } = createAttachmentService([image, pdf], {
      derivatives: [
        {
          id: 1,
          attachmentRefId: pdf.refId,
          kind: 'pdf_text',
          orderIndex: 0,
          mimeType: 'text/plain',
          storageFileId: null,
          storageUrl: null,
          textContent: '这是 PDF 的摘录内容。',
          metadata: null,
          byteSize: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    const result = await service.buildAttachmentContextMessages({
      attachments: [image, pdf],
      userText: '继续看这两个附件',
      model: 'openai/gpt-5.4-mini',
      maxInjectTotalBytes: 16 * 1024 * 1024,
      maxInjectPerFileBytes: 6 * 1024 * 1024,
      maxPdfPreviewPagesPerFile: 6,
      maxPdfPreviewPagesTotal: 15,
      maxTextCharsPerFile: 24_000,
    });

    expect(result.projections).toHaveLength(2);
    expect(result.messages).toHaveLength(1);
    expect(typeof result.messages[0]?.content).toBe('string');
    expect(String(result.messages[0]?.content)).toContain('历史附件引用上下文');
    expect(String(result.messages[0]?.content)).toContain('att_pdf01');
    expect(String(result.messages[0]?.content)).toContain('这是 PDF 的摘录内容');
    expect(String(result.messages[0]?.content)).not.toContain(image.storageUrl);
    expect(Array.isArray(result.messages[0]?.content)).toBe(false);
  });

  it('rewrites archived audio input into transcript text for the current turn', async () => {
    const audio = createRecord({
      refId: 'att_audio01',
      conversationId: 'conv-audio',
      kind: 'audio',
      filename: 'voice.mp3',
      mimeType: 'audio/mpeg',
    });
    const { service } = createAttachmentService([audio], {
      derivatives: [
        {
          id: 2,
          attachmentRefId: audio.refId,
          kind: 'audio_transcript',
          orderIndex: 0,
          mimeType: 'text/plain',
          storageFileId: null,
          storageUrl: null,
          textContent: '你好，这是一段转写。',
          metadata: null,
          byteSize: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    const message = new HumanMessage({
      content: [
        {
          type: 'audio_url',
          audio_url: {
            url: 'http://127.0.0.1:5140/audio/voice.mp3',
            mimeType: 'audio/mpeg',
          },
        } as any,
      ],
    }) as HumanMessage & { additional_kwargs?: Record<string, unknown> };

    await service.rewriteArchivedInputMessage(message, [
      {
        refId: audio.refId,
        kind: 'audio',
        filename: audio.filename,
        mimeType: audio.mimeType,
        storageFileId: audio.storageFileId,
        storageUrl: audio.storageUrl,
        byteSize: audio.byteSize,
        hash: audio.hash,
        createdAt: audio.createdAt,
      },
    ]);

    expect(Array.isArray(message.content)).toBe(true);
    expect((message.content as any[])[0]?.type).toBe('text');
    expect(JSON.stringify(message.content)).toContain('音频附件 att_audio01 转写');
    expect(JSON.stringify(message.content)).toContain('你好，这是一段转写');
  });

  it('reuses provider cache on repeated attachment replay', async () => {
    const pdf = createRecord({
      refId: 'att_pdf_cache',
      conversationId: 'conv-cache',
      kind: 'pdf',
      filename: 'cached.pdf',
      mimeType: 'application/pdf',
    });
    const { service, database } = createAttachmentService([pdf], {
      derivatives: [
        {
          id: 3,
          attachmentRefId: pdf.refId,
          kind: 'pdf_text',
          orderIndex: 0,
          mimeType: 'text/plain',
          storageFileId: null,
          storageUrl: null,
          textContent: '缓存测试 PDF 摘录。',
          metadata: null,
          byteSize: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    const first = await service.replayAttachments({
      conversationId: pdf.conversationId,
      refs: [pdf.refId],
      purpose: '重新查看这个 PDF',
      provider: 'openai',
      model: 'openai/gpt-5.4-mini',
    });
    const second = await service.replayAttachments({
      conversationId: pdf.conversationId,
      refs: [pdf.refId],
      purpose: '重新查看这个 PDF',
      provider: 'openai',
      model: 'openai/gpt-5.4-mini',
    });

    expect(first.cacheHits).toBe(0);
    expect(second.cacheHits).toBe(1);
    expect(second.resolved[0]?.representationKind).toBe('file_url');
    expect((database.tables.qqbot_attachment_provider_cache ?? []).length).toBe(1);
  });
});
