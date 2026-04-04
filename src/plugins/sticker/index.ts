import { Context, Logger, Schema, type Session } from 'koishi';
import {
  buildStickerCapabilityDescriptor,
  buildStickerCapabilityPolicy,
  loadStickerCatalog,
  type LoadedStickerCatalog,
  type StickerCapabilityState,
} from './selection.js';
import { registerPromptFragment, type PromptFragment } from '../shared/prompt-context/index.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
};

export const name = 'chatluna-sticker';
export const inject = ['chatluna'];
export {
  createStickerHistoryLine,
  resolveStickerSelection,
  type LoadedStickerEntry,
  type StickerCapabilityDescriptor,
  type StickerCapabilityState,
  type StickerCatalogDocument,
  type StickerCatalogEntry,
  type StickerMatch,
} from './selection.js';

const logger = new Logger(name);
const DEFAULT_STICKER_DIR = './data/chathub/stickers';
let runtimeStickerDir = DEFAULT_STICKER_DIR;
let runtimeStickerCatalog: LoadedStickerCatalog | null | undefined;

export interface Config {
  stickerDir?: string;
}

export const Config: Schema<Config> = Schema.object({
  stickerDir: Schema.string()
    .default('./data/chathub/stickers')
    .description('表情包目录路径（包含 catalog.generated.json 与 images/ 子目录）。'),
});

type SessionWithStickerState = Session & {
  state?: Record<string, unknown> & {
    qqSticker?: StickerCapabilityState;
  };
};

type RoomLike = {
  conversationId?: string;
  preset?: string;
  [key: string]: unknown;
};

type MiddlewareContextLike = {
  options?: {
    room?: RoomLike;
  };
};

type ChatLunaLike = {
  chatChain?: {
    middleware: (name: string, middleware: (session: unknown, context: unknown) => Promise<number>) => {
      after: (name: string) => { before: (name: string) => unknown };
      before: (name: string) => unknown;
    };
  };
};

type ContextWithChatLuna = Context & {
  chatluna?: ChatLunaLike;
  get?: (name: string) => unknown;
};

function isReplyPlanSessionAvailable(session: Session): boolean {
  return session.platform === 'onebot' && Boolean(session.channelId);
}

function setStickerCapabilityState(session: SessionWithStickerState, capability: StickerCapabilityState): void {
  const current = session.state ?? {};
  current.qqSticker = capability;
  session.state = current;
}

function resolveChatLunaService(ctx: ContextWithChatLuna): ChatLunaLike | undefined {
  const byGetter = typeof ctx.get === 'function' ? (ctx.get('chatluna') as ChatLunaLike | undefined) : undefined;
  return byGetter ?? ctx.chatluna;
}

function loadRuntimeStickerCatalog(): LoadedStickerCatalog | null {
  if (runtimeStickerCatalog !== undefined) {
    return runtimeStickerCatalog ?? null;
  }
  runtimeStickerCatalog = loadStickerCatalog(runtimeStickerDir);
  return runtimeStickerCatalog ?? null;
}

function setRuntimeStickerCatalog(stickerDir: string, catalog: LoadedStickerCatalog | null): void {
  runtimeStickerDir = stickerDir;
  runtimeStickerCatalog = catalog;
}

export function resolveStickerCapabilityArtifacts(preset?: string | null): {
  state: StickerCapabilityState;
  fragments: PromptFragment[];
} {
  const normalizedPreset = preset?.trim() || null;
  const catalog = loadRuntimeStickerCatalog();
  const availableCount =
    catalog?.entries.filter(
      (entry) => entry.scopes.includes('global') || (normalizedPreset ? entry.scopes.includes(`persona:${normalizedPreset}`) : false),
    ).length ?? 0;
  const state: StickerCapabilityState = {
    catalog: catalog ?? null,
    preset: normalizedPreset,
    availableCount,
  };
  const fragments: PromptFragment[] = [];
  const capability = catalog ? buildStickerCapabilityDescriptor({ catalog, preset: normalizedPreset }) : null;
  if (!capability || !catalog) {
    return { state, fragments };
  }

  fragments.push({
    source: 'qqbot_sticker_capability',
    title: 'Sticker Capability State',
    authority: 'runtime_contract',
    trust: 'trusted',
    ttl: 'turn',
    payload: {
      kind: 'json',
      value: capability,
    },
  });

  const policy = buildStickerCapabilityPolicy({ catalog, preset: normalizedPreset });
  if (policy) {
    fragments.push({
      source: 'qqbot_sticker_execution_rules',
      title: 'Sticker Execution Rules',
      authority: 'runtime_contract',
      trust: 'trusted',
      ttl: 'turn',
      payload: {
        kind: 'text',
        value: policy,
      },
    });
  }

  return { state, fragments };
}

export function apply(ctx: Context, config: Config = {}): void {
  const stickerDir = config.stickerDir?.trim() || DEFAULT_STICKER_DIR;
  const catalog = loadStickerCatalog(stickerDir);
  setRuntimeStickerCatalog(stickerDir, catalog);
  if (!catalog?.entries.length) {
    logger.warn('sticker catalog is unavailable: %s/%s', stickerDir, 'catalog.generated.json');
  } else {
    logger.info('loaded sticker catalog with %d entry(ies).', catalog.entries.length);
  }

  ctx.on('ready', () => {
    const chatluna = resolveChatLunaService(ctx as ContextWithChatLuna);
    const chain = chatluna?.chatChain;
    if (!chain) {
      logger.warn('chatluna service is not available, skip sticker reply policy middleware.');
      return;
    }

    chain
      .middleware('qqbot_sticker_policy', async (rawSession, rawContext) => {
        const session = rawSession as SessionWithStickerState;
        const context = rawContext as MiddlewareContextLike;
        if (!isReplyPlanSessionAvailable(session)) return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        if (!session.userId || session.userId === session.bot?.selfId) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        const room = context.options?.room;
        const preset = room?.preset?.trim() || null;
        const { state, fragments } = resolveStickerCapabilityArtifacts(preset);
        setStickerCapabilityState(session, state);
        const conversationId = room?.conversationId;
        if (!conversationId || !fragments.length) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        for (const fragment of fragments) {
          registerPromptFragment(conversationId, fragment);
        }
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('read_chat_message')
      .before('lifecycle-handle_command');
  });
}
