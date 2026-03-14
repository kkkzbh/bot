import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager';
import { StructuredTool, type ToolRunnableConfig } from '@langchain/core/tools';
import { Context, h, Logger, Schema, type Session } from 'koishi';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const name = 'chatluna-sticker';
export const inject = ['chatluna'];

const logger = new Logger(name);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface Config {
  stickerDir?: string;
}

export const Config: Schema<Config> = Schema.object({
  stickerDir: Schema.string()
    .default('./data/chathub/stickers')
    .description('表情包目录路径（包含 index.yml 和 images/ 子目录）。'),
});

// ---------------------------------------------------------------------------
// Sticker index types & loader
// ---------------------------------------------------------------------------

export type StickerEntry = {
  tag: string;
  file: string;
  description: string;
  buffer: Buffer;
  mime: string;
};

type StickerIndexYaml = {
  stickers?: Record<string, { file?: string; description?: string }>;
};

function mimeFromExtension(filePath: string): string {
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

export function loadStickerIndex(stickerDir: string): Map<string, StickerEntry> {
  const indexPath = resolve(stickerDir, 'index.yml');
  let raw: string;
  try {
    raw = readFileSync(indexPath, 'utf-8');
  } catch {
    logger.warn('sticker index not found: %s', indexPath);
    return new Map();
  }

  const parsed = parseYaml(raw) as StickerIndexYaml;
  if (!parsed?.stickers || typeof parsed.stickers !== 'object') {
    logger.warn('sticker index has no "stickers" mapping: %s', indexPath);
    return new Map();
  }

  const result = new Map<string, StickerEntry>();
  for (const [tag, entry] of Object.entries(parsed.stickers)) {
    if (!entry?.file) {
      logger.warn('sticker "%s" missing "file" field, skipped.', tag);
      continue;
    }
    const filePath = resolve(stickerDir, entry.file);
    try {
      const buffer = readFileSync(filePath);
      result.set(tag, {
        tag,
        file: entry.file,
        description: entry.description ?? '',
        buffer,
        mime: mimeFromExtension(filePath),
      });
    } catch {
      logger.warn('sticker "%s" file not readable: %s, skipped.', tag, filePath);
    }
  }

  logger.info('loaded %d sticker(s) from %s', result.size, indexPath);
  return result;
}

// ---------------------------------------------------------------------------
// Tool input extraction (handles string / object / nested JSON like search)
// ---------------------------------------------------------------------------

export function extractStickerTag(input: unknown, depth = 0): string {
  if (depth > 3 || input == null) return '';

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return '';

    // Try JSON parse for stringified objects
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const extracted = extractStickerTag(parsed, depth + 1);
        if (extracted) return extracted;
      } catch {}
    }

    return trimmed;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const extracted = extractStickerTag(item, depth + 1);
      if (extracted) return extracted;
    }
    return '';
  }

  if (typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['tag', 'name', 'sticker', 'input', 'args']) {
      const extracted = extractStickerTag(record[key], depth + 1);
      if (extracted) return extracted;
    }
    const entries = Object.entries(record).filter(([, v]) => v != null);
    if (entries.length === 1) {
      return extractStickerTag(entries[0][1], depth + 1);
    }
  }

  return '';
}

// ---------------------------------------------------------------------------
// LangChain tool
// ---------------------------------------------------------------------------

const SEND_STICKER_SCHEMA = z.object({
  tag: z.string().describe('表情包标签名，如 smug、bored、piano、cold、embarrassed'),
});

type SendStickerInput = z.infer<typeof SEND_STICKER_SCHEMA>;

type StickerToolRunnable = ToolRunnableConfig & {
  configurable?: {
    session?: { send: (content: unknown) => Promise<unknown> };
  };
};

class SendStickerTool extends StructuredTool<
  typeof SEND_STICKER_SCHEMA,
  SendStickerInput,
  SendStickerInput,
  string
> {
  name = 'send_sticker';
  description =
    '发送一张表情包贴图来表达情绪。可用标签见下方，只在情绪强烈时使用。';
  schema = SEND_STICKER_SCHEMA;

  constructor(private stickerMap: Map<string, StickerEntry>) {
    super();
  }

  protected async _call(
    input: SendStickerInput,
    _runManager?: CallbackManagerForToolRun,
    parentConfig?: ToolRunnableConfig,
  ): Promise<string> {
    const tag = extractStickerTag(input);
    if (!tag) {
      logger.warn('send_sticker: empty tag from input %s', JSON.stringify(input));
      return '表情包标签为空';
    }

    const sticker = this.stickerMap.get(tag);
    if (!sticker) {
      const available = [...this.stickerMap.keys()].join(', ');
      logger.warn('send_sticker: unknown tag "%s" (available: %s)', tag, available);
      return `未找到标签为 "${tag}" 的表情包。可用标签: ${available}`;
    }

    const session = (parentConfig as StickerToolRunnable)?.configurable?.session;
    if (!session) {
      logger.warn('send_sticker: no session in parentConfig, cannot send image.');
      return '无法发送表情包（会话不可用）';
    }

    try {
      await session.send(h.image(sticker.buffer, sticker.mime));
      return `已发送表情包: ${tag}`;
    } catch (error) {
      logger.warn('send_sticker: failed to send image: %s', (error as Error).message);
      return `表情包发送失败: ${(error as Error).message}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Platform registration types (same pattern as local web-search tool registration)
// ---------------------------------------------------------------------------

type HotfixToolDescriptor = {
  createTool: (params: unknown) => unknown;
  selector: () => boolean;
  authorization?: (session: Session) => boolean;
};

type PlatformLike = {
  registerTool?: (name: string, tool: HotfixToolDescriptor) => unknown;
};

type ChatLunaLike = {
  platform?: PlatformLike;
};

type ContextWithChatLuna = Context & { chatluna?: ChatLunaLike };

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx: Context, config: Config): void {
  const stickerDir = resolve(process.cwd(), config.stickerDir ?? './data/chathub/stickers');
  const stickerMap = loadStickerIndex(stickerDir);

  if (!stickerMap.size) {
    logger.warn('no stickers loaded — send_sticker tool will not be registered.');
    return;
  }

  // Build dynamic description with available tags
  const tagDescriptions = [...stickerMap.values()]
    .map((s) => `${s.tag}（${s.description}）`)
    .join('、');

  let registered = false;

  const ensureRegistered = (trigger: string) => {
    if (registered) return;
    const platform = (ctx as ContextWithChatLuna).chatluna?.platform;
    if (!platform?.registerTool) {
      if (trigger === 'ready') {
        logger.warn('chatluna platform not available yet for sticker tool registration.');
      }
      return;
    }

    platform.registerTool('send_sticker', {
      createTool: () => {
        const tool = new SendStickerTool(stickerMap);
        tool.description = `发送一张表情包贴图来表达情绪。可用标签: ${tagDescriptions}`;
        return tool;
      },
      selector: () => true,
      authorization: (session: Session) => session.isDirect === true,
    });

    registered = true;
    logger.info('registered send_sticker tool with %d sticker(s).', stickerMap.size);
  };

  ctx.on('ready', () => ensureRegistered('ready'));
  ctx.setInterval(() => ensureRegistered('interval'), 15_000);
}
