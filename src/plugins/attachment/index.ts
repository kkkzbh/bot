import {
  BaseMessage,
  HumanMessage,
  type MessageContent,
  type MessageContentComplex,
} from '@langchain/core/messages';
import { Context, Logger, Schema } from 'koishi';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getMessageContent, getMimeTypeFromSource } from 'koishi-plugin-chatluna/utils/string';
import { ModelCapabilities } from 'koishi-plugin-chatluna/llm-core/platform/types';
import { registerPromptFragment } from '../shared/prompt-context/index.js';
import { transcribeAudio } from '../shared/voice/input.js';
import type {
  QqbotAttachmentDerivativeKind,
  QqbotAttachmentDerivativeRecord,
  QqbotAttachmentKind,
  QqbotAttachmentProviderCacheRecord,
  QqbotAttachmentRecord,
  QqbotAttachmentRef,
  QqbotAttachmentServiceLike,
  QqbotResolvedAttachmentSelection,
} from '../../types/attachment.js';
import '../../types/attachment.js';

const logger = new Logger('qqbot-attachment');
const execFileAsync = promisify(execFile);
const CHAT_CHAIN_CONTINUE = 2;
const DEFAULT_MAX_INJECT_COUNT = 5;
const DEFAULT_MAX_INJECT_TOTAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_INJECT_PER_FILE_BYTES = 6 * 1024 * 1024;
const DEFAULT_MAX_PDF_PREVIEW_PAGES_PER_FILE = 6;
const DEFAULT_MAX_PDF_PREVIEW_PAGES_TOTAL = 15;
const DEFAULT_MAX_TEXT_CHARS_PER_FILE = 24_000;
const DEFAULT_RECENT_CATALOG_SIZE = 12;
const DEFAULT_IMAGE_DETAIL = 'high';
const HIGH_DETAIL_IMAGE_KEYWORDS = [
  'ocr',
  '识别',
  '看清',
  '细节',
  '小字',
  '放大',
  '局部',
  '左上',
  '右上',
  '左下',
  '右下',
  '坐标',
  '位置',
  '按钮',
  '界面',
  'ui',
  '图表',
  '表格',
  '版式',
];
const PDF_VISUAL_KEYWORDS = ['图表', '图', '页面', '版式', '排版', '截图', '第', '页'];
const ATTACHMENT_REFERENCE_KEYWORDS = ['附件', '文件', '图片', '图', 'pdf', '文档', '语音', '音频', '录音'];

export const name = 'qqbot-attachment';
export const inject = { required: ['database', 'chatluna', 'chatluna_storage'] } as const;

export interface Config {
  maxInjectCount?: number;
  maxInjectTotalBytes?: number;
  maxInjectPerFileBytes?: number;
  maxPdfPreviewPagesPerFile?: number;
  maxPdfPreviewPagesTotal?: number;
  maxTextCharsPerFile?: number;
  recentCatalogSize?: number;
}

export const Config: Schema<Config> = Schema.object({
  maxInjectCount: Schema.natural().default(DEFAULT_MAX_INJECT_COUNT).description('每轮最多回灌多少个历史附件。'),
  maxInjectTotalBytes: Schema.natural().default(DEFAULT_MAX_INJECT_TOTAL_BYTES).description('单轮附件回灌的总字节预算。'),
  maxInjectPerFileBytes: Schema.natural().default(DEFAULT_MAX_INJECT_PER_FILE_BYTES).description('单个附件回灌的字节预算。'),
  maxPdfPreviewPagesPerFile: Schema.natural().default(DEFAULT_MAX_PDF_PREVIEW_PAGES_PER_FILE).description('单个 PDF 最多生成多少页预览。'),
  maxPdfPreviewPagesTotal: Schema.natural().default(DEFAULT_MAX_PDF_PREVIEW_PAGES_TOTAL).description('单轮所有 PDF 最多回灌多少页预览。'),
  maxTextCharsPerFile: Schema.natural().default(DEFAULT_MAX_TEXT_CHARS_PER_FILE).description('单个文本派生物的最大字符数。'),
  recentCatalogSize: Schema.natural().default(DEFAULT_RECENT_CATALOG_SIZE).description('最近附件目录最多列出多少个附件。'),
});

interface RuntimeConfig {
  maxInjectCount: number;
  maxInjectTotalBytes: number;
  maxInjectPerFileBytes: number;
  maxPdfPreviewPagesPerFile: number;
  maxPdfPreviewPagesTotal: number;
  maxTextCharsPerFile: number;
  recentCatalogSize: number;
}

type StorageTempFileLike = {
  id: string;
  name: string;
  type?: string | null;
  size: number;
  hash?: string | null;
  url: string;
  data: Promise<Buffer>;
};

type MessageWithAttachments = {
  content?: MessageContent | null;
  id?: string | null;
  name?: string | null;
  additional_kwargs?: Record<string, unknown>;
  getType?: () => string;
};

type ContextWithAttachment = Context & {
  provide?: (name: string) => void;
  set?: (name: string, value: unknown) => void;
  qqbotAttachment?: QqbotAttachmentServiceLike;
  chatluna_storage: {
    createTempFile: (
      buffer: Buffer,
      filename: string,
      expireHours?: number,
      mimeType?: string,
    ) => Promise<StorageTempFileLike>;
    getTempFile: (id: string) => Promise<StorageTempFileLike | null>;
  };
  chatluna: {
    chatChain?: {
      middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => {
        after: (name: string) => any;
        before: (name: string) => any;
      };
    };
    contextManager?: {
      inject: (options: {
        name: string;
        value: unknown;
        once?: boolean;
        conversationId?: string;
        stage?: string;
      }) => void;
    };
    platform?: {
      findModel: (model?: string) => { value?: { capabilities?: ModelCapabilities[] } } | undefined;
    };
  };
};

type AttachmentSource = {
  kind: QqbotAttachmentKind;
  sourceUrl: string;
  mimeType: string | null;
  filename: string | null;
};

function clampNatural(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  return {
    maxInjectCount: clampNatural(config.maxInjectCount ?? process.env.QQBOT_ATTACHMENT_MAX_INJECT_COUNT, DEFAULT_MAX_INJECT_COUNT),
    maxInjectTotalBytes: clampNatural(
      config.maxInjectTotalBytes ?? process.env.QQBOT_ATTACHMENT_MAX_INJECT_TOTAL_BYTES,
      DEFAULT_MAX_INJECT_TOTAL_BYTES,
    ),
    maxInjectPerFileBytes: clampNatural(
      config.maxInjectPerFileBytes ?? process.env.QQBOT_ATTACHMENT_MAX_INJECT_PER_FILE_BYTES,
      DEFAULT_MAX_INJECT_PER_FILE_BYTES,
    ),
    maxPdfPreviewPagesPerFile: clampNatural(
      config.maxPdfPreviewPagesPerFile ?? process.env.QQBOT_ATTACHMENT_MAX_PDF_PREVIEW_PAGES_PER_FILE,
      DEFAULT_MAX_PDF_PREVIEW_PAGES_PER_FILE,
    ),
    maxPdfPreviewPagesTotal: clampNatural(
      config.maxPdfPreviewPagesTotal ?? process.env.QQBOT_ATTACHMENT_MAX_PDF_PREVIEW_PAGES_TOTAL,
      DEFAULT_MAX_PDF_PREVIEW_PAGES_TOTAL,
    ),
    maxTextCharsPerFile: clampNatural(
      config.maxTextCharsPerFile ?? process.env.QQBOT_ATTACHMENT_MAX_TEXT_CHARS_PER_FILE,
      DEFAULT_MAX_TEXT_CHARS_PER_FILE,
    ),
    recentCatalogSize: clampNatural(
      config.recentCatalogSize ?? process.env.QQBOT_ATTACHMENT_RECENT_CATALOG_SIZE,
      DEFAULT_RECENT_CATALOG_SIZE,
    ),
  };
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function toContentParts(content: MessageContent | null | undefined): MessageContentComplex[] {
  if (content == null) return [];
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }

  return Array.isArray(content) ? content.filter(Boolean) : [];
}

function resolveFileLikeUrl(
  part: MessageContentComplex,
): { url: string; mimeType: string | null } | null {
  if (part.type === 'image_url') {
    const raw = part.image_url;
    if (typeof raw === 'string') {
      return { url: raw, mimeType: getMimeTypeFromSource(raw) };
    }
    if (raw && typeof raw === 'object' && typeof raw.url === 'string') {
      return { url: raw.url, mimeType: getMimeTypeFromSource(raw.url) };
    }
    return null;
  }

  if (part.type === 'file_url' || part.type === 'audio_url' || part.type === 'video_url') {
    const key = part.type;
    const raw = (part as Record<string, unknown>)[key] as string | { url?: string; mimeType?: string } | undefined;
    if (typeof raw === 'string') {
      return { url: raw, mimeType: getMimeTypeFromSource(raw) };
    }
    if (raw && typeof raw === 'object' && typeof raw.url === 'string') {
      return { url: raw.url, mimeType: normalizeText(raw.mimeType) || getMimeTypeFromSource(raw.url) };
    }
  }

  return null;
}

function guessAttachmentKind(part: MessageContentComplex, mimeType: string | null): QqbotAttachmentKind | null {
  if (part.type === 'image_url') return 'image';
  if (part.type === 'audio_url') return 'audio';
  if (part.type === 'video_url') return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType?.startsWith('text/') || mimeType === 'application/json') return 'text';
  if (part.type === 'file_url') return 'file';
  return null;
}

function resolveFilenameFromUrl(url: string, fallback: string): string {
  if (url.startsWith('data:')) {
    return fallback;
  }

  try {
    const parsed = new URL(url);
    const fileName = decodeURIComponent(path.posix.basename(parsed.pathname));
    return fileName || fallback;
  } catch {
    const candidate = decodeURIComponent(url.split('?')[0].split('#')[0].split('/').pop() ?? '');
    return candidate || fallback;
  }
}

function toAttachmentSources(message: MessageWithAttachments): AttachmentSource[] {
  const parts = toContentParts(message.content);
  const sources: AttachmentSource[] = [];

  for (const part of parts) {
    if (part == null || typeof part !== 'object' || part.type === 'text') {
      continue;
    }

    const urlInfo = resolveFileLikeUrl(part);
    if (!urlInfo?.url) {
      continue;
    }

    const mimeType = urlInfo.mimeType ?? getMimeTypeFromSource(urlInfo.url);
    const kind = guessAttachmentKind(part, mimeType);
    if (!kind) {
      continue;
    }

    const fallbackName = `${kind}-${randomUUID().slice(0, 8)}`;
    sources.push({
      kind,
      sourceUrl: urlInfo.url,
      mimeType,
      filename: resolveFilenameFromUrl(urlInfo.url, fallbackName),
    });
  }

  return sources;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function formatAttachmentKind(kind: QqbotAttachmentKind): string {
  switch (kind) {
    case 'image':
      return '图片';
    case 'pdf':
      return 'PDF';
    case 'text':
      return '文本文件';
    case 'audio':
      return '音频';
    case 'video':
      return '视频';
    default:
      return '文件';
  }
}

function formatAge(createdAt: number): string {
  const deltaMs = Math.max(0, Date.now() - createdAt);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

function normalizeForMatch(value: string | null | undefined): string {
  return normalizeText(value).toLowerCase();
}

function parseChineseCount(raw: string): number {
  if (!raw) return 1;
  if (/^\d+$/.test(raw)) return Math.max(1, Number(raw));
  switch (raw) {
    case '一':
      return 1;
    case '二':
    case '两':
      return 2;
    case '三':
      return 3;
    case '四':
      return 4;
    case '五':
      return 5;
    default:
      return 1;
  }
}

function detectRequestedCount(userText: string): number {
  const match = userText.match(/(?:这|这几|最近的?)(\d+|一|二|两|三|四|五)(?:个附件|个文件|张图|张图片|份文档|个pdf)/i);
  if (match) {
    return parseChineseCount(match[1]);
  }

  return 1;
}

function detectKindHint(userText: string): QqbotAttachmentKind | 'attachment' | null {
  const lower = userText.toLowerCase();
  if (lower.includes('.pdf') || lower.includes('pdf')) return 'pdf';
  if (lower.includes('语音') || lower.includes('音频') || lower.includes('录音')) return 'audio';
  if (lower.includes('视频')) return 'video';
  if (lower.includes('图片') || lower.includes('截图') || lower.includes('照片') || lower.includes('这张图') || lower.includes('那张图')) {
    return 'image';
  }
  if (lower.includes('文本') || lower.includes('.txt') || lower.includes('.md') || lower.includes('.json')) {
    return 'text';
  }
  if (lower.includes('附件') || lower.includes('文件') || lower.includes('文档')) {
    return 'attachment';
  }
  return null;
}

function mentionsAttachmentReference(userText: string): boolean {
  const lower = userText.toLowerCase();
  if (/\batt_[a-z0-9]+\b/i.test(lower)) return true;
  return ATTACHMENT_REFERENCE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function needsOriginalImageDetail(userText: string): boolean {
  const lower = userText.toLowerCase();
  return HIGH_DETAIL_IMAGE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function needsPdfVisualContext(userText: string): boolean {
  const lower = userText.toLowerCase();
  return PDF_VISUAL_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function createAttachmentCatalogText(records: QqbotAttachmentRecord[]): string {
  const lines = ['最近附件目录：'];
  for (const record of records) {
    lines.push(
      `- ${record.refId} | ${record.kind} | ${record.filename ?? 'unnamed'} | ${record.senderName ?? '未知发送者'} | ${formatAge(record.createdAt)}`,
    );
  }
  lines.push('当用户提到某个旧附件时，只能依据引用 ID、文件名或明确指代来解析；若存在多个候选，请先澄清。');
  return lines.join('\n');
}

function createResolutionText(resolution: QqbotResolvedAttachmentSelection): string {
  if (resolution.selected.length < 1) {
    return '';
  }

  const lines = ['本轮已解析到以下历史附件并回灌到上下文：'];
  for (const record of resolution.selected) {
    lines.push(`- ${record.refId} | ${record.kind} | ${record.filename ?? 'unnamed'}`);
  }
  return lines.join('\n');
}

function createAmbiguousResolutionText(resolution: QqbotResolvedAttachmentSelection): string {
  if (resolution.ambiguous.length < 1) {
    return '';
  }

  const lines = [
    '当前用户提到历史附件，但候选不止一个。不要自行假定目标，请先向用户确认具体附件。',
    '候选附件：',
  ];
  for (const record of resolution.ambiguous) {
    lines.push(`- ${record.refId} | ${record.kind} | ${record.filename ?? 'unnamed'} | ${formatAge(record.createdAt)}`);
  }
  return lines.join('\n');
}

async function withTempFile<T>(buffer: Buffer, suffix: string, fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqbot-attachment-'));
  const filePath = path.join(dir, `input${suffix}`);
  await writeFile(filePath, buffer);
  try {
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function extractPdfText(buffer: Buffer): Promise<string | null> {
  try {
    return await withTempFile(buffer, '.pdf', async (filePath) => {
      const { stdout } = await execFileAsync('pdftotext', ['-layout', '-nopgbrk', filePath, '-'], {
        maxBuffer: 16 * 1024 * 1024,
      });
      const text = normalizeText(stdout);
      return text || null;
    });
  } catch (error) {
    logger.warn('pdf text extraction failed: %s', (error as Error).message);
    return null;
  }
}

async function extractPdfPageCount(buffer: Buffer): Promise<number | null> {
  try {
    return await withTempFile(buffer, '.pdf', async (filePath) => {
      const { stdout } = await execFileAsync('pdfinfo', [filePath], {
        maxBuffer: 2 * 1024 * 1024,
      });
      const match = stdout.match(/^Pages:\s+(\d+)/m);
      if (!match) return null;
      return Number(match[1]);
    });
  } catch {
    return null;
  }
}

async function renderPdfPagePreview(buffer: Buffer, pageNumber: number): Promise<Buffer | null> {
  try {
    return await withTempFile(buffer, '.pdf', async (filePath) => {
      const outputPrefix = path.join(path.dirname(filePath), `preview-${pageNumber}`);
      await execFileAsync(
        'pdftoppm',
        ['-png', '-singlefile', '-f', String(pageNumber), '-l', String(pageNumber), filePath, outputPrefix],
        {
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      const outputPath = `${outputPrefix}.png`;
      return await readFile(outputPath);
    });
  } catch (error) {
    logger.warn('pdf page preview failed: %s', (error as Error).message);
    return null;
  }
}

function createAsrRuntimeFromEnv() {
  const asrBaseUrl = normalizeText(process.env.QQ_VOICE_ASR_BASE_URL);
  if (!asrBaseUrl) {
    return null;
  }

  return {
    asrBaseUrl,
    asrApiKey: normalizeText(process.env.QQ_VOICE_ASR_API_KEY),
    transcribeTimeoutMs: clampNatural(process.env.QQ_VOICE_TRANSCRIBE_TIMEOUT_MS, 45_000),
  };
}

export class AttachmentService implements QqbotAttachmentServiceLike {
  constructor(private readonly ctx: ContextWithAttachment, private readonly runtime: RuntimeConfig) {}

  static ensureTables(ctx: Context): void {
    ctx.model.extend(
      'qqbot_attachment',
      {
        id: 'unsigned',
        refId: 'string',
        conversationId: 'string',
        messageRole: 'string',
        messageId: { type: 'string', nullable: true },
        senderId: { type: 'string', nullable: true },
        senderName: { type: 'string', nullable: true },
        kind: 'string',
        filename: { type: 'string', nullable: true },
        mimeType: { type: 'string', nullable: true },
        storageFileId: 'string',
        storageUrl: 'text',
        byteSize: 'double',
        hash: { type: 'string', nullable: true },
        metadata: { type: 'text', nullable: true },
        createdAt: 'double',
        updatedAt: 'double',
      },
      {
        autoInc: true,
        indexes: [['conversationId', 'createdAt'], ['refId'], ['storageFileId']],
      },
    );

    ctx.model.extend(
      'qqbot_attachment_derivative',
      {
        id: 'unsigned',
        attachmentRefId: 'string',
        kind: 'string',
        orderIndex: 'unsigned',
        mimeType: { type: 'string', nullable: true },
        storageFileId: { type: 'string', nullable: true },
        storageUrl: { type: 'text', nullable: true },
        textContent: { type: 'text', nullable: true },
        metadata: { type: 'text', nullable: true },
        byteSize: { type: 'double', nullable: true },
        createdAt: 'double',
        updatedAt: 'double',
      },
      {
        autoInc: true,
        indexes: [['attachmentRefId', 'kind', 'orderIndex']],
      },
    );

    ctx.model.extend(
      'qqbot_attachment_provider_cache',
      {
        id: 'unsigned',
        attachmentRefId: 'string',
        representationKey: 'string',
        provider: 'string',
        fileId: 'string',
        mimeType: { type: 'string', nullable: true },
        detail: { type: 'string', nullable: true },
        createdAt: 'double',
        updatedAt: 'double',
        lastUsedAt: 'double',
      },
      {
        autoInc: true,
        indexes: [['attachmentRefId', 'provider', 'representationKey']],
      },
    );
  }

  async archiveMessageAttachments(args: { conversationId: string; message: BaseMessage | MessageWithAttachments }): Promise<QqbotAttachmentRef[]> {
    const sources = toAttachmentSources(args.message);
    if (sources.length < 1) {
      return [];
    }

    const refs: QqbotAttachmentRef[] = [];
    for (const source of sources) {
      try {
        const stored = await this.resolveStoredFile(source);
        const record = await this.createAttachmentRecord(args, source, stored);
        refs.push(this.toRef(record));
        await this.ensureDefaultDerivatives(record, stored);
      } catch (error) {
        logger.warn('archive attachment skipped: %s', (error as Error).message);
      }
    }

    return refs;
  }

  async listRecentAttachments(conversationId: string, limit: number): Promise<QqbotAttachmentRecord[]> {
    const rows = (await this.ctx.database.get('qqbot_attachment', {
      conversationId,
    })) as QqbotAttachmentRecord[];

    return rows
      .slice()
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit);
  }

  async resolveReferencedAttachments(args: {
    conversationId: string;
    userText: string;
    limit: number;
    recent?: QqbotAttachmentRecord[];
  }): Promise<QqbotResolvedAttachmentSelection> {
    const recent = args.recent ?? (await this.listRecentAttachments(args.conversationId, this.runtime.recentCatalogSize));
    const requestedCount = Math.max(1, Math.min(args.limit, detectRequestedCount(args.userText)));
    const kindHint = detectKindHint(args.userText);

    const explicitIds = Array.from(new Set((args.userText.match(/\batt_[a-z0-9]+\b/gi) ?? []).map((item) => item.toLowerCase())));
    if (explicitIds.length > 0) {
      const selected = await this.findAttachmentsByRefs(args.conversationId, explicitIds);
      return {
        selected: selected.slice(0, args.limit),
        ambiguous: [],
        requestedCount,
        kindHint,
        reason: selected.length > 0 ? 'explicit_ref' : 'none',
      };
    }

    const filenameMatches = recent.filter((record) => {
      const filename = normalizeForMatch(record.filename);
      return filename.length > 0 && normalizeForMatch(args.userText).includes(filename);
    });
    if (filenameMatches.length > 0) {
      return {
        selected: filenameMatches.slice(0, args.limit),
        ambiguous: [],
        requestedCount,
        kindHint,
        reason: 'filename',
      };
    }

    if (!mentionsAttachmentReference(args.userText)) {
      return {
        selected: [],
        ambiguous: [],
        requestedCount,
        kindHint,
        reason: 'none',
      };
    }

    const candidates = recent.filter((record) => {
      if (kindHint == null || kindHint === 'attachment') {
        return true;
      }
      return record.kind === kindHint;
    });

    if (requestedCount > 1) {
      return {
        selected: candidates.slice(0, Math.min(args.limit, requestedCount)),
        ambiguous: [],
        requestedCount,
        kindHint,
        reason: candidates.length > 0 ? 'relative_batch' : 'none',
      };
    }

    if (candidates.length === 1) {
      return {
        selected: candidates,
        ambiguous: [],
        requestedCount,
        kindHint,
        reason: 'relative_latest',
      };
    }

    if (candidates.length > 1) {
      return {
        selected: [],
        ambiguous: candidates.slice(0, 3),
        requestedCount,
        kindHint,
        reason: 'relative_latest',
      };
    }

    return {
      selected: [],
      ambiguous: [],
      requestedCount,
      kindHint,
      reason: 'none',
    };
  }

  async buildAttachmentContextMessages(args: {
    attachments: QqbotAttachmentRecord[];
    userText: string;
    model?: string | null;
    maxInjectTotalBytes: number;
    maxInjectPerFileBytes: number;
    maxPdfPreviewPagesPerFile: number;
    maxPdfPreviewPagesTotal: number;
    maxTextCharsPerFile: number;
  }): Promise<{
    messages: BaseMessage[];
    injected: QqbotAttachmentRecord[];
    skipped: Array<{ refId: string; reason: string }>;
  }> {
    const capabilities = this.resolveModelCapabilities(args.model);
    const supportsImage = capabilities.includes(ModelCapabilities.ImageInput);
    const supportsFile = capabilities.includes(ModelCapabilities.FileInput);
    const wantsOriginalImage = needsOriginalImageDetail(args.userText);
    const wantsPdfVisual = needsPdfVisualContext(args.userText);

    const content: MessageContentComplex[] = [];
    const injected: QqbotAttachmentRecord[] = [];
    const skipped: Array<{ refId: string; reason: string }> = [];
    let totalBytes = 0;
    let totalPdfPreviewPages = 0;

    for (const record of args.attachments) {
      if (injected.length >= this.runtime.maxInjectCount) {
        skipped.push({ refId: record.refId, reason: 'inject_count_limit' });
        continue;
      }

      if (record.byteSize > args.maxInjectPerFileBytes && !['image', 'pdf'].includes(record.kind)) {
        skipped.push({ refId: record.refId, reason: 'per_file_budget_exceeded' });
        continue;
      }

      if (totalBytes + record.byteSize > args.maxInjectTotalBytes) {
        skipped.push({ refId: record.refId, reason: 'total_budget_exceeded' });
        continue;
      }

      const intro = `历史附件 ${record.refId} (${formatAttachmentKind(record.kind)}${record.filename ? `, ${record.filename}` : ''})`;
      content.push({ type: 'text', text: intro });

      if (record.kind === 'image') {
        if (!supportsImage) {
          skipped.push({ refId: record.refId, reason: 'model_missing_image_input' });
          continue;
        }

        content.push({
          type: 'image_url',
          image_url: {
            url: record.storageUrl,
            detail: wantsOriginalImage ? 'original' : DEFAULT_IMAGE_DETAIL,
          },
        } as MessageContentComplex);
        injected.push(record);
        totalBytes += record.byteSize;
        continue;
      }

      if (record.kind === 'pdf') {
        const pdfText = await this.ensureTextLikeDerivative(record, 'pdf_text', args.maxTextCharsPerFile);
        if (pdfText) {
          content.push({
            type: 'text',
            text: `附件 ${record.refId} 的提取文本摘录：\n${truncateText(pdfText, args.maxTextCharsPerFile)}`,
          });
        }

        if (supportsFile) {
          content.push({
            type: 'file_url',
            file_url: { url: record.storageUrl, mimeType: record.mimeType ?? 'application/pdf' },
          } as MessageContentComplex);
        }

        if (supportsImage && wantsPdfVisual && totalPdfPreviewPages < args.maxPdfPreviewPagesTotal) {
          const previews = await this.ensurePdfPagePreviewDerivatives(
            record,
            Math.min(args.maxPdfPreviewPagesPerFile, args.maxPdfPreviewPagesTotal - totalPdfPreviewPages),
          );
          for (const preview of previews) {
            if (!preview.storageUrl) {
              continue;
            }
            content.push({
              type: 'image_url',
              image_url: {
                url: preview.storageUrl,
                detail: DEFAULT_IMAGE_DETAIL,
              },
            } as MessageContentComplex);
            totalPdfPreviewPages += 1;
          }
        }

        if (supportsFile || pdfText) {
          injected.push(record);
          totalBytes += record.byteSize;
        } else {
          skipped.push({ refId: record.refId, reason: 'no_pdf_representation' });
        }
        continue;
      }

      if (record.kind === 'text') {
        const textContent = await this.ensureTextLikeDerivative(record, 'text_excerpt', args.maxTextCharsPerFile);
        if (textContent) {
          content.push({
            type: 'text',
            text: `附件 ${record.refId} 的文本内容摘录：\n${truncateText(textContent, args.maxTextCharsPerFile)}`,
          });
          injected.push(record);
          totalBytes += record.byteSize;
          continue;
        }
      }

      if (record.kind === 'audio') {
        const transcript = await this.ensureAudioTranscript(record);
        if (transcript) {
          content.push({
            type: 'text',
            text: `附件 ${record.refId} 的音频转写：\n${truncateText(transcript, args.maxTextCharsPerFile)}`,
          });
          injected.push(record);
          totalBytes += record.byteSize;
          continue;
        }
      }

      if (supportsFile && (record.kind === 'file' || record.kind === 'video')) {
        content.push({
          type: 'file_url',
          file_url: { url: record.storageUrl, mimeType: record.mimeType ?? 'application/octet-stream' },
        } as MessageContentComplex);
        injected.push(record);
        totalBytes += record.byteSize;
        continue;
      }

      skipped.push({ refId: record.refId, reason: 'unsupported_attachment_kind' });
    }

    if (content.length < 1) {
      return { messages: [], injected, skipped };
    }

    return {
      messages: [
        new HumanMessage({
          content,
        }),
      ],
      injected,
      skipped,
    };
  }

  private resolveModelCapabilities(model: string | null | undefined): ModelCapabilities[] {
    const capabilities = this.ctx.chatluna.platform?.findModel(model ?? undefined)?.value?.capabilities;
    return Array.isArray(capabilities) ? capabilities : [];
  }

  private async findAttachmentsByRefs(conversationId: string, refIds: string[]): Promise<QqbotAttachmentRecord[]> {
    const result: QqbotAttachmentRecord[] = [];
    for (const refId of refIds) {
      const rows = (await this.ctx.database.get('qqbot_attachment', {
        conversationId,
        refId,
      })) as QqbotAttachmentRecord[];
      if (rows[0]) {
        result.push(rows[0]);
      }
    }
    return result;
  }

  private toRef(record: QqbotAttachmentRecord): QqbotAttachmentRef {
    return {
      refId: record.refId,
      kind: record.kind,
      filename: record.filename,
      mimeType: record.mimeType,
      storageFileId: record.storageFileId,
      storageUrl: record.storageUrl,
      byteSize: record.byteSize,
      hash: record.hash,
      createdAt: record.createdAt,
      senderId: record.senderId,
      senderName: record.senderName,
    };
  }

  private async resolveStoredFile(source: AttachmentSource): Promise<StorageTempFileLike> {
    const storage = this.ctx.chatluna_storage;

    if (source.sourceUrl.startsWith('data:')) {
      const match = source.sourceUrl.match(/^data:([^;,]+);base64,(.+)$/i);
      if (!match) {
        throw new Error('invalid data url attachment');
      }
      const buffer = Buffer.from(match[2], 'base64');
      return storage.createTempFile(buffer, source.filename ?? `attachment-${randomUUID().slice(0, 8)}`, undefined, source.mimeType ?? match[1]);
    }

    const basename = resolveFilenameFromUrl(source.sourceUrl, source.filename ?? 'attachment');
    const existing = await storage.getTempFile(basename);
    if (existing) {
      return existing;
    }

    const response = await fetch(source.sourceUrl);
    if (!response.ok) {
      throw new Error(`fetch attachment failed: http ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return storage.createTempFile(
      buffer,
      source.filename ?? basename,
      undefined,
      source.mimeType ?? response.headers.get('content-type')?.split(';')[0]?.trim() ?? undefined,
    );
  }

  private async createAttachmentRecord(
    args: { conversationId: string; message: BaseMessage | MessageWithAttachments },
    source: AttachmentSource,
    stored: StorageTempFileLike,
  ): Promise<QqbotAttachmentRecord> {
    const messageRole = this.resolveMessageRole(args.message);
    if (args.message.id != null) {
      const existingRows = (await this.ctx.database.get('qqbot_attachment', {
        conversationId: args.conversationId,
        storageFileId: stored.id,
        messageId: args.message.id,
        messageRole,
      })) as QqbotAttachmentRecord[];
      if (existingRows[0]) {
        return existingRows[0];
      }
    }

    const speakerFormat = (args.message.additional_kwargs?.qqbot_speaker_format ?? {}) as Record<string, unknown>;
    const senderName = normalizeText(speakerFormat.speakerName) || normalizeText(args.message.name) || null;
    const senderId = normalizeText(speakerFormat.speakerId) || null;
    const now = Date.now();
    const metadata = JSON.stringify({
      originalUrl: source.sourceUrl,
    });
    const record = {
      refId: `att_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      conversationId: args.conversationId,
      messageRole,
      messageId: args.message.id ?? null,
      senderId,
      senderName,
      kind: source.kind,
      filename: source.filename ?? stored.name,
      mimeType: source.mimeType ?? stored.type ?? getMimeTypeFromSource(stored.name),
      storageFileId: stored.id,
      storageUrl: stored.url,
      byteSize: stored.size,
      hash: stored.hash ?? null,
      metadata,
      createdAt: now,
      updatedAt: now,
    };

    const created = await this.ctx.database.create('qqbot_attachment', record);
    return created as QqbotAttachmentRecord;
  }

  private resolveMessageRole(message: BaseMessage | MessageWithAttachments): string {
    if (message instanceof BaseMessage) {
      return message.getType();
    }

    if (typeof message.getType === 'function') {
      return normalizeText(message.getType()) || 'human';
    }

    return 'human';
  }

  private async ensureDefaultDerivatives(record: QqbotAttachmentRecord, stored: StorageTempFileLike): Promise<void> {
    const buffer = await stored.data;

    if (record.kind === 'text') {
      const text = truncateText(buffer.toString('utf8').replace(/\0/g, '').trim(), this.runtime.maxTextCharsPerFile);
      if (text) {
        await this.upsertDerivative(record.refId, {
          kind: 'text_excerpt',
          orderIndex: 0,
          textContent: text,
          mimeType: record.mimeType,
          storageFileId: null,
          storageUrl: null,
          metadata: null,
          byteSize: null,
        });
      }
      return;
    }

    if (record.kind === 'pdf') {
      const text = await extractPdfText(buffer);
      if (text) {
        await this.upsertDerivative(record.refId, {
          kind: 'pdf_text',
          orderIndex: 0,
          textContent: truncateText(text, this.runtime.maxTextCharsPerFile),
          mimeType: 'text/plain',
          storageFileId: null,
          storageUrl: null,
          metadata: null,
          byteSize: null,
        });
      }

      const pageCount = await extractPdfPageCount(buffer);
      if (pageCount != null) {
        await this.ctx.database.set(
          'qqbot_attachment',
          { refId: record.refId },
          {
            metadata: JSON.stringify({
              ...(record.metadata ? JSON.parse(record.metadata) as Record<string, unknown> : {}),
              pageCount,
            }),
            updatedAt: Date.now(),
          },
        );
      }
      return;
    }

    if (record.kind === 'audio') {
      await this.ensureAudioTranscript(record);
    }
  }

  private async ensureAudioTranscript(record: QqbotAttachmentRecord): Promise<string | null> {
    const existing = await this.getDerivative(record.refId, 'audio_transcript', 0);
    if (existing?.textContent) {
      return existing.textContent;
    }

    const runtime = createAsrRuntimeFromEnv();
    if (!runtime) {
      return null;
    }

    const tempFile = await this.ctx.chatluna_storage.getTempFile(record.storageFileId);
    if (!tempFile) {
      return null;
    }

    try {
      const payload = await transcribeAudio(runtime, {
        bytes: await tempFile.data,
        contentType: record.mimeType ?? 'application/octet-stream',
        source: 'src',
        filename: record.filename ?? tempFile.name,
      });
      const text = normalizeText(payload.text);
      if (!text) {
        return null;
      }

      await this.upsertDerivative(record.refId, {
        kind: 'audio_transcript',
        orderIndex: 0,
        textContent: truncateText(text, this.runtime.maxTextCharsPerFile),
        mimeType: 'text/plain',
        storageFileId: null,
        storageUrl: null,
        metadata: JSON.stringify({
          language: payload.language ?? null,
          durationMs: payload.durationMs ?? null,
        }),
        byteSize: null,
      });
      return truncateText(text, this.runtime.maxTextCharsPerFile);
    } catch (error) {
      logger.warn('audio transcript failed: %s', (error as Error).message);
      return null;
    }
  }

  private async ensureTextLikeDerivative(
    record: QqbotAttachmentRecord,
    kind: Extract<QqbotAttachmentDerivativeKind, 'pdf_text' | 'text_excerpt'>,
    maxChars: number,
  ): Promise<string | null> {
    const existing = await this.getDerivative(record.refId, kind, 0);
    if (existing?.textContent) {
      return truncateText(existing.textContent, maxChars);
    }

    if (kind === 'pdf_text') {
      const tempFile = await this.ctx.chatluna_storage.getTempFile(record.storageFileId);
      if (!tempFile) return null;
      const text = await extractPdfText(await tempFile.data);
      if (!text) return null;
      const truncated = truncateText(text, maxChars);
      await this.upsertDerivative(record.refId, {
        kind,
        orderIndex: 0,
        textContent: truncated,
        mimeType: 'text/plain',
        storageFileId: null,
        storageUrl: null,
        metadata: null,
        byteSize: null,
      });
      return truncated;
    }

    return null;
  }

  private async ensurePdfPagePreviewDerivatives(
    record: QqbotAttachmentRecord,
    maxPages: number,
  ): Promise<QqbotAttachmentDerivativeRecord[]> {
    if (maxPages < 1) {
      return [];
    }

    const existingRows = ((await this.ctx.database.get('qqbot_attachment_derivative', {
      attachmentRefId: record.refId,
      kind: 'pdf_page_preview',
    })) as QqbotAttachmentDerivativeRecord[])
      .slice()
      .sort((left, right) => left.orderIndex - right.orderIndex);

    if (existingRows.length >= maxPages) {
      return existingRows.slice(0, maxPages);
    }

    const tempFile = await this.ctx.chatluna_storage.getTempFile(record.storageFileId);
    if (!tempFile) {
      return existingRows.slice(0, maxPages);
    }

    const buffer = await tempFile.data;
    const startPage = existingRows.length + 1;
    for (let pageNumber = startPage; pageNumber <= maxPages; pageNumber++) {
      const preview = await renderPdfPagePreview(buffer, pageNumber);
      if (!preview) {
        break;
      }
      const stored = await this.ctx.chatluna_storage.createTempFile(
        preview,
        `${record.refId}-page-${pageNumber}.png`,
        undefined,
        'image/png',
      );
      await this.upsertDerivative(record.refId, {
        kind: 'pdf_page_preview',
        orderIndex: pageNumber - 1,
        textContent: null,
        mimeType: 'image/png',
        storageFileId: stored.id,
        storageUrl: stored.url,
        metadata: JSON.stringify({ pageNumber }),
        byteSize: stored.size,
      });
    }

    const nextRows = (await this.ctx.database.get('qqbot_attachment_derivative', {
      attachmentRefId: record.refId,
      kind: 'pdf_page_preview',
    })) as QqbotAttachmentDerivativeRecord[];

    return nextRows
      .slice()
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .slice(0, maxPages);
  }

  private async getDerivative(
    attachmentRefId: string,
    kind: QqbotAttachmentDerivativeKind,
    orderIndex: number,
  ): Promise<QqbotAttachmentDerivativeRecord | null> {
    const rows = (await this.ctx.database.get('qqbot_attachment_derivative', {
      attachmentRefId,
      kind,
      orderIndex,
    })) as QqbotAttachmentDerivativeRecord[];
    return rows[0] ?? null;
  }

  private async upsertDerivative(
    attachmentRefId: string,
    input: Omit<QqbotAttachmentDerivativeRecord, 'id' | 'attachmentRefId' | 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    const now = Date.now();
    const existing = await this.getDerivative(attachmentRefId, input.kind, input.orderIndex);
    if (existing) {
      await this.ctx.database.set(
        'qqbot_attachment_derivative',
        { id: existing.id },
        {
          ...input,
          updatedAt: now,
        },
      );
      return;
    }

    await this.ctx.database.create('qqbot_attachment_derivative', {
      attachmentRefId,
      ...input,
      createdAt: now,
      updatedAt: now,
    });
  }
}

function applyPromptFragments(conversationId: string, recent: QqbotAttachmentRecord[], resolution: QqbotResolvedAttachmentSelection): void {
  if (recent.length > 0) {
    registerPromptFragment(conversationId, {
      source: 'qqbot_recent_attachments',
      title: 'Recent Attachments',
      authority: 'reference',
      trust: 'trusted',
      ttl: 'turn',
      payload: {
        kind: 'text',
        value: createAttachmentCatalogText(recent),
      },
    });
  }

  const ambiguousText = createAmbiguousResolutionText(resolution);
  if (ambiguousText) {
    registerPromptFragment(conversationId, {
      source: 'qqbot_attachment_resolution',
      title: 'Attachment Resolution',
      authority: 'reference',
      trust: 'trusted',
      ttl: 'turn',
      payload: {
        kind: 'text',
        value: ambiguousText,
      },
    });
    return;
  }

  const resolutionText = createResolutionText(resolution);
  if (resolutionText) {
    registerPromptFragment(conversationId, {
      source: 'qqbot_attachment_resolution',
      title: 'Attachment Resolution',
      authority: 'reference',
      trust: 'trusted',
      ttl: 'turn',
      payload: {
        kind: 'text',
        value: resolutionText,
      },
    });
  }
}

export function apply(ctx: Context, config: Config): void {
  const runtime = toRuntimeConfig(config);
  AttachmentService.ensureTables(ctx);

  const service = new AttachmentService(ctx as ContextWithAttachment, runtime);
  const serviceCtx = ctx as ContextWithAttachment;
  if (typeof serviceCtx.provide === 'function' && typeof serviceCtx.set === 'function') {
    serviceCtx.provide('qqbotAttachment');
    serviceCtx.set('qqbotAttachment', service);
  } else {
    serviceCtx.qqbotAttachment = service;
  }

  ctx.on('ready', () => {
    const chain = serviceCtx.chatluna.chatChain;
    const contextManager = serviceCtx.chatluna.contextManager;
    if (!chain || !contextManager) {
      logger.warn('chatluna service unavailable, skip attachment middleware registration.');
      return;
    }

    chain
      .middleware('qqbot_attachment_archive', async (_rawSession, rawContext) => {
        const context = rawContext as {
          options?: {
            room?: {
              conversationId?: string;
            };
            inputMessage?: BaseMessage & {
              additional_kwargs?: Record<string, unknown>;
            };
          };
        };

        const conversationId = normalizeText(context.options?.room?.conversationId);
        const inputMessage = context.options?.inputMessage;
        if (!conversationId || !inputMessage) {
          return CHAT_CHAIN_CONTINUE;
        }

        const refs = await service.archiveMessageAttachments({
          conversationId,
          message: inputMessage,
        });

        if (refs.length > 0) {
          inputMessage.additional_kwargs = {
            ...(inputMessage.additional_kwargs ?? {}),
            qqbot_attachment_refs: refs,
          };
        }

        return CHAT_CHAIN_CONTINUE;
      })
      .after('read_chat_message')
      .before('chatluna_time_context');

    chain
      .middleware('qqbot_attachment_context', async (_rawSession, rawContext) => {
        const context = rawContext as {
          options?: {
            room?: {
              conversationId?: string;
              model?: string;
            };
            inputMessage?: BaseMessage;
          };
        };

        const conversationId = normalizeText(context.options?.room?.conversationId);
        const inputMessage = context.options?.inputMessage;
        if (!conversationId || !inputMessage) {
          return CHAT_CHAIN_CONTINUE;
        }

        const userText = getMessageContent(inputMessage.content).trim();
        const recent = await service.listRecentAttachments(conversationId, runtime.recentCatalogSize);
        const resolution = await service.resolveReferencedAttachments({
          conversationId,
          userText,
          limit: runtime.maxInjectCount,
          recent,
        });

        applyPromptFragments(conversationId, recent, resolution);

        if (resolution.ambiguous.length > 0 || resolution.selected.length < 1) {
          return CHAT_CHAIN_CONTINUE;
        }

        const hydrated = await service.buildAttachmentContextMessages({
          attachments: resolution.selected,
          userText,
          model: context.options?.room?.model ?? null,
          maxInjectTotalBytes: runtime.maxInjectTotalBytes,
          maxInjectPerFileBytes: runtime.maxInjectPerFileBytes,
          maxPdfPreviewPagesPerFile: runtime.maxPdfPreviewPagesPerFile,
          maxPdfPreviewPagesTotal: runtime.maxPdfPreviewPagesTotal,
          maxTextCharsPerFile: runtime.maxTextCharsPerFile,
        });

        if (hydrated.messages.length > 0) {
          contextManager.inject({
            conversationId,
            name: 'read_files_context',
            value: hydrated.messages,
            once: true,
            stage: 'after_scratchpad',
          });
        }

        return CHAT_CHAIN_CONTINUE;
      })
      .after('qqbot_attachment_archive')
      .after('chatluna_time_context')
      .before('qqbot_prompt_envelope');

    logger.info(
      'attachment context loaded: maxInjectCount=%d recentCatalogSize=%d',
      runtime.maxInjectCount,
      runtime.recentCatalogSize,
    );
  });
}
