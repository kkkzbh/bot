import { describe, expect, it } from 'vitest';
import type { QqbotAttachmentRecord } from '../src/types/attachment.js';
import { resolveReferencedAttachmentsFromCatalog } from '../src/plugins/attachment/resolution.js';

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
