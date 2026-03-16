import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const STICKER_CATALOG_FILENAME = 'catalog.generated.json';
const PERSONA_SCOPE_PREFIX = 'persona:';

export interface StickerCatalogEntry {
  id: string;
  file: string;
  hash: string;
  mime: string;
  scopes: string[];
  caption: string;
  keywords: string[];
  moods: string[];
  scenes: string[];
  historyLabel: string;
  confidence: number;
}

export interface StickerCatalogDocument {
  version: 1;
  generatedAt: string;
  model: string;
  entries: StickerCatalogEntry[];
}

export interface LoadedStickerEntry extends StickerCatalogEntry {
  buffer: Buffer;
}

export interface LoadedStickerCatalog {
  version: 1;
  generatedAt: string;
  model: string;
  entries: LoadedStickerEntry[];
  byId: Map<string, LoadedStickerEntry>;
}

export interface StickerMatch {
  entry: LoadedStickerEntry;
  score: number;
}

export interface StickerCapabilityState {
  catalog: LoadedStickerCatalog | null;
  preset: string | null;
  availableCount: number;
}

export function mimeFromExtension(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function tokenizeIntent(intent: string): string[] {
  const normalized = intent
    .toLowerCase()
    .replace(/[，。！？、,.;:!?/\\()[\]{}"'`]+/g, ' ')
    .trim();
  if (!normalized) return [];

  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (normalized && !tokens.includes(normalized)) {
    tokens.unshift(normalized);
  }
  return [...new Set(tokens)];
}

function matchesScope(scopes: string[], preset?: string | null): boolean {
  if (scopes.includes('global')) return true;
  const normalizedPreset = normalizeText(preset ?? '');
  if (!normalizedPreset) return false;
  return scopes.some((scope) => normalizeText(scope) === `${PERSONA_SCOPE_PREFIX}${normalizedPreset}`);
}

function collectEntryTerms(entry: LoadedStickerEntry): string[] {
  return [
    entry.id,
    entry.caption,
    entry.historyLabel,
    ...entry.keywords,
    ...entry.moods,
    ...entry.scenes,
  ]
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function scoreEntry(entry: LoadedStickerEntry, intent: string, tokens: string[]): number {
  if (!intent) return -1;

  const normalizedIntent = normalizeText(intent);
  const terms = collectEntryTerms(entry);
  let score = Math.max(0, Math.round(entry.confidence * 100));

  if (normalizeText(entry.id) === normalizedIntent) score += 200;
  if (normalizeText(entry.historyLabel) === normalizedIntent) score += 120;

  for (const term of terms) {
    if (!term) continue;
    if (term === normalizedIntent) {
      score += 80;
      continue;
    }
    if (term.includes(normalizedIntent) || normalizedIntent.includes(term)) {
      score += 24;
    }
  }

  for (const token of tokens) {
    if (!token) continue;
    if (normalizeText(entry.id) === token) {
      score += 80;
      continue;
    }
    if (entry.moods.some((item) => normalizeText(item) === token)) score += 32;
    if (entry.keywords.some((item) => normalizeText(item) === token)) score += 18;
    if (entry.scenes.some((item) => normalizeText(item) === token)) score += 12;
    if (normalizeText(entry.caption).includes(token)) score += 10;
    if (normalizeText(entry.historyLabel).includes(token)) score += 10;
  }

  return score;
}

export function loadStickerCatalog(stickerDir: string): LoadedStickerCatalog | null {
  const catalogPath = resolve(stickerDir, STICKER_CATALOG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(catalogPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: StickerCatalogDocument;
  try {
    parsed = JSON.parse(raw) as StickerCatalogDocument;
  } catch {
    return null;
  }

  if (!Array.isArray(parsed?.entries)) return null;

  const entries: LoadedStickerEntry[] = [];
  const byId = new Map<string, LoadedStickerEntry>();
  for (const candidate of parsed.entries) {
    if (!candidate?.id || !candidate?.file) continue;
    const filePath = resolve(stickerDir, candidate.file);
    try {
      const buffer = readFileSync(filePath);
      const entry: LoadedStickerEntry = {
        ...candidate,
        mime: candidate.mime || mimeFromExtension(filePath),
        scopes: Array.isArray(candidate.scopes) && candidate.scopes.length > 0 ? candidate.scopes : ['global'],
        keywords: Array.isArray(candidate.keywords) ? candidate.keywords : [],
        moods: Array.isArray(candidate.moods) ? candidate.moods : [],
        scenes: Array.isArray(candidate.scenes) ? candidate.scenes : [],
        caption: candidate.caption ?? '',
        historyLabel: candidate.historyLabel ?? candidate.id,
        confidence: Number.isFinite(candidate.confidence) ? candidate.confidence : 0.5,
        buffer,
      };
      entries.push(entry);
      byId.set(normalizeText(entry.id), entry);
    } catch {}
  }

  return {
    version: 1,
    generatedAt: parsed.generatedAt ?? '',
    model: parsed.model ?? '',
    entries,
    byId,
  };
}

export function resolveStickerMatches(
  catalog: LoadedStickerCatalog | null,
  intent: string,
  preset?: string | null,
): StickerMatch[] {
  if (!catalog || !intent.trim()) return [];
  const tokens = tokenizeIntent(intent);
  const matches = catalog.entries
    .filter((entry) => matchesScope(entry.scopes, preset))
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, intent, tokens),
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score);

  return matches;
}

export function resolveStickerSelection(
  catalog: LoadedStickerCatalog | null,
  intent: string,
  preset?: string | null,
): LoadedStickerEntry | null {
  return resolveStickerMatches(catalog, intent, preset)[0]?.entry ?? null;
}

export function createStickerHistoryLine(entry: LoadedStickerEntry): string {
  return `（发送表情包：${entry.historyLabel || entry.id}）`;
}

export function buildStickerCapabilityPolicy(args: {
  catalog: LoadedStickerCatalog;
  preset?: string | null;
}): string | null {
  const { catalog, preset } = args;
  const available = catalog.entries.filter((entry) => matchesScope(entry.scopes, preset));
  if (!available.length) return null;

  const scopeLabel = preset ? `当前 persona（${preset}）及共享库` : '共享库';
  return [
    `当前还可以发送表情包，来源于${scopeLabel}。`,
    '如果你决定发表情包，就直接输出一个包含一个或多个 sticker 段的 ReplyPlan JSON 对象。',
    'sticker 段的 content 不是标签名，而是一句自然语言意图，例如“冷淡拒绝，被追问私事”或“聊到音乐时的得意感”。',
    '表情包可以和 text / multiline / voice 段混排；多个 sticker 段会按顺序一张张发送到 QQ。',
    '如果用户要求连续发多张表情包，必须拆成多个 sticker 段，并严格保持用户要求的先后顺序。',
    '每个 sticker.content 只描述当前这一张图的单一情绪或场景，不要把“连续发两张”“先……再……”这类整句要求原样抄进每个 sticker.content。',
    '相邻 sticker 段默认不要重复同一句 content；只有用户明确要求重复同一张图时，才允许重复。',
    '单张 sticker 示例：{"segments":[{"kind":"sticker","content":"无语地看对方一眼"}]}',
    '混排示例：{"segments":[{"kind":"text","content":"……随你"},{"kind":"sticker","content":"冷淡拒绝，被追问私事"}]}',
    '多张示例：{"segments":[{"kind":"sticker","content":"无语地看对方一眼"},{"kind":"sticker","content":"生气地噘嘴表达不满"}]}',
  ].join('\n');
}
