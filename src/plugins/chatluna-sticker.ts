import { Context, Logger, Schema, type Session } from 'koishi';
import {
  buildStickerCapabilityPolicy,
  loadStickerCatalog,
  type StickerCapabilityState,
} from './chatluna-sticker-core.js';

const ChatLunaChains = require('koishi-plugin-chatluna/chains') as {
  ChainMiddlewareRunStatus: { STOP: number; CONTINUE: number };
};

export const name = 'chatluna-sticker';
export const inject = ['chatluna'];

const logger = new Logger(name);

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
  contextManager?: {
    inject: (options: {
      name: string;
      value: unknown;
      once?: boolean;
      conversationId?: string;
      stage?: string;
    }) => void;
  };
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

export function apply(ctx: Context, config: Config = {}): void {
  const stickerDir = config.stickerDir?.trim() || './data/chathub/stickers';
  const catalog = loadStickerCatalog(stickerDir);
  if (!catalog?.entries.length) {
    logger.warn('sticker catalog is unavailable: %s/%s', stickerDir, 'catalog.generated.json');
  } else {
    logger.info('loaded sticker catalog with %d entry(ies).', catalog.entries.length);
  }

  ctx.on('ready', () => {
    const chatluna = resolveChatLunaService(ctx as ContextWithChatLuna);
    const chain = chatluna?.chatChain;
    const contextManager = chatluna?.contextManager;
    if (!chain || !contextManager) {
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
        const availableCount =
          catalog?.entries.filter(
            (entry) => entry.scopes.includes('global') || (preset ? entry.scopes.includes(`persona:${preset}`) : false),
          ).length ?? 0;
        setStickerCapabilityState(session, {
          catalog: catalog ?? null,
          preset,
          availableCount,
        });

        const conversationId = room?.conversationId;
        const policy = catalog ? buildStickerCapabilityPolicy({ catalog, preset }) : null;
        if (!conversationId || !policy) {
          return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
        }

        contextManager.inject({
          name: 'qqbot_sticker_policy',
          value: policy,
          once: true,
          conversationId,
          stage: 'after_scratchpad',
        });
        return ChatLunaChains.ChainMiddlewareRunStatus.CONTINUE;
      })
      .after('read_chat_message')
      .before('lifecycle-handle_command');
  });
}
