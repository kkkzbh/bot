import type { QqbotAttachmentKind, QqbotAttachmentRecord, QqbotResolvedAttachmentSelection } from '../../types/attachment.js';

const ATTACHMENT_REFERENCE_KEYWORDS = ['附件', '文件', '图片', '图', 'pdf', '文档', '语音', '音频', '录音'];

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
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

export function detectRequestedCount(userText: string): number {
  const match = userText.match(/(?:这|这几|最近的?)(\d+|一|二|两|三|四|五)(?:个附件|个文件|张图|张图片|份文档|个pdf)/i);
  if (match) {
    return parseChineseCount(match[1]);
  }

  return 1;
}

export function detectKindHint(userText: string): QqbotAttachmentKind | 'attachment' | null {
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

export function mentionsAttachmentReference(userText: string): boolean {
  const lower = userText.toLowerCase();
  if (/\batt_[a-z0-9]+\b/i.test(lower)) return true;
  return ATTACHMENT_REFERENCE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export function createAttachmentCatalogText(records: QqbotAttachmentRecord[]): string {
  const lines = ['最近附件目录：'];
  for (const record of records) {
    lines.push(
      `- ${record.refId} | ${record.kind} | ${record.filename ?? 'unnamed'} | ${record.senderName ?? '未知发送者'} | ${formatAge(record.createdAt)}`,
    );
  }
  lines.push('当用户提到某个旧附件时，只能依据引用 ID、文件名或明确指代来解析；若存在多个候选，请先澄清。');
  return lines.join('\n');
}

export function createResolutionText(resolution: QqbotResolvedAttachmentSelection): string {
  if (resolution.selected.length < 1) {
    return '';
  }

  const lines = ['本轮已解析到以下历史附件引用，可根据需要调用附件回放工具：'];
  for (const record of resolution.selected) {
    lines.push(`- ${record.refId} | ${record.kind} | ${record.filename ?? 'unnamed'}`);
  }
  return lines.join('\n');
}

export function createAmbiguousResolutionText(resolution: QqbotResolvedAttachmentSelection): string {
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

export async function resolveReferencedAttachmentsFromCatalog(args: {
  userText: string;
  recent: QqbotAttachmentRecord[];
  limit: number;
  resolveByRefs?: (refIds: string[]) => Promise<QqbotAttachmentRecord[]>;
}): Promise<QqbotResolvedAttachmentSelection> {
  const requestedCount = Math.max(1, Math.min(args.limit, detectRequestedCount(args.userText)));
  const kindHint = detectKindHint(args.userText);
  const explicitIds = Array.from(new Set((args.userText.match(/\batt_[a-z0-9]+\b/gi) ?? []).map((item) => item.toLowerCase())));

  if (explicitIds.length > 0) {
    const selected = args.resolveByRefs ? await args.resolveByRefs(explicitIds) : args.recent.filter((item) => explicitIds.includes(item.refId));
    return {
      selected: selected.slice(0, args.limit),
      ambiguous: [],
      requestedCount,
      kindHint,
      reason: selected.length > 0 ? 'explicit_ref' : 'none',
    };
  }

  const filenameMatches = args.recent.filter((record) => {
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

  const candidates = args.recent.filter((record) => {
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
