import { randomUUID } from 'node:crypto';
import { StructuredTool } from '@langchain/core/tools';
import { Context, Logger, Schema, type Session } from 'koishi';
import type { ChatLunaTool, ChatLunaToolRunnable } from 'koishi-plugin-chatluna/llm-core/platform/types';
import { z } from 'zod';
import { CodeforcesProvider, type ContestQueryMode } from './provider.js';
import { renderCodeforcesProfileCard, renderCodeforcesRatingChart } from './render.js';

const logger = new Logger('oj-tools');

export const name = 'oj-tools';
export const inject = { required: ['chatluna', 'chatluna_storage'] } as const;

export const CF_USER_PROFILE_TOOL = 'cf_user_profile';
export const CF_USER_RATING_TOOL = 'cf_user_rating';
export const CF_USER_SUBMISSIONS_TOOL = 'cf_user_submissions';
export const CF_CONTESTS_TOOL = 'cf_contests';

const DEFAULT_CACHE_TTL_MS = 300_000;
const DEFAULT_REQUEST_INTERVAL_MS = 2_100;
const DEFAULT_RATING_CHART_WIDTH = 1_789;
const DEFAULT_RATING_CHART_HEIGHT = 838;

export interface Config {
  cacheTtlMs?: number;
  requestIntervalMs?: number;
  ratingChartWidth?: number;
  ratingChartHeight?: number;
}

export const Config: Schema<Config> = Schema.object({
  cacheTtlMs: Schema.natural().default(DEFAULT_CACHE_TTL_MS).description('Codeforces 查询结果进程内缓存时间（毫秒）。'),
  requestIntervalMs: Schema.natural().default(DEFAULT_REQUEST_INTERVAL_MS).description('Codeforces API 最小请求间隔（毫秒）。'),
  ratingChartWidth: Schema.natural().default(DEFAULT_RATING_CHART_WIDTH).description('rating 历史图宽度。'),
  ratingChartHeight: Schema.natural().default(DEFAULT_RATING_CHART_HEIGHT).description('rating 历史图高度。'),
});

type StorageTempFileLike = {
  id: string;
  url: string;
};

type ContextWithOjTools = Context & {
  chatluna: {
    platform?: {
      registerTool?: (name: string, tool: ChatLunaTool) => () => void;
    };
  };
  chatluna_storage: {
    createTempFile: (
      buffer: Buffer,
      filename: string,
      expireHours?: number,
      mimeType?: string,
    ) => Promise<StorageTempFileLike>;
  };
};

interface RuntimeConfig {
  cacheTtlMs: number;
  requestIntervalMs: number;
  ratingChartWidth: number;
  ratingChartHeight: number;
}

interface ToolDeps {
  ctx: ContextWithOjTools;
  runtime: RuntimeConfig;
  provider: CodeforcesProvider;
}

function clampNatural(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  return {
    cacheTtlMs: clampNatural(config.cacheTtlMs ?? process.env.QQBOT_OJ_TOOLS_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS),
    requestIntervalMs: clampNatural(
      config.requestIntervalMs ?? process.env.QQBOT_OJ_TOOLS_REQUEST_INTERVAL_MS,
      DEFAULT_REQUEST_INTERVAL_MS,
    ),
    ratingChartWidth: clampNatural(
      config.ratingChartWidth ?? process.env.QQBOT_OJ_TOOLS_RATING_CHART_WIDTH,
      DEFAULT_RATING_CHART_WIDTH,
    ),
    ratingChartHeight: clampNatural(
      config.ratingChartHeight ?? process.env.QQBOT_OJ_TOOLS_RATING_CHART_HEIGHT,
      DEFAULT_RATING_CHART_HEIGHT,
    ),
  };
}

function createToolEntry(name: string, description: string, createTool: () => StructuredTool): ChatLunaTool {
  return {
    name,
    description,
    selector: () => true,
    authorization: (session) => Boolean(session?.userId),
    createTool,
  };
}

async function createImageAsset(
  storage: ContextWithOjTools['chatluna_storage'],
  buffer: Buffer,
  filename: string,
): Promise<{ assetRef: string; storageId: string }> {
  const stored = await storage.createTempFile(buffer, filename, undefined, 'image/png');
  return {
    assetRef: stored.url,
    storageId: stored.id,
  };
}

function formatTimestamp(timestamp: number | null): string | null {
  if (!timestamp) return null;
  return new Date(timestamp * 1000).toISOString();
}

class CfUserProfileTool extends StructuredTool {
  name = CF_USER_PROFILE_TOOL;

  description =
    'Look up a Codeforces user profile and return their rating/rank summary plus a score-card image. Use this for handle/profile/score-card requests.';

  schema = z.object({
    handle: z.string().trim().min(1).describe('Codeforces handle, for example tourist or YingCir.'),
  });

  constructor(private readonly deps: ToolDeps) {
    super({});
  }

  async _call(input: z.infer<CfUserProfileTool['schema']>, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const session = config.configurable.session as Session | undefined;
    if (!session?.userId) {
      throw new Error('cf_user_profile requires the current session.');
    }

    const profile = await this.deps.provider.getUserProfile(input.handle);
    const rendered = await renderCodeforcesProfileCard(profile);
    const image = await createImageAsset(
      this.deps.ctx.chatluna_storage,
      rendered.buffer,
      `cf-profile-${profile.handle}-${randomUUID().slice(0, 8)}.png`,
    );

    return JSON.stringify({
      tool: this.name,
      handle: profile.handle,
      summary: `${profile.handle} 当前 rating ${profile.rating ?? 'Unrated'}，段位 ${profile.rank}，最高 ${profile.maxRating ?? 'Unrated'}。`,
      profile: {
        rating: profile.rating,
        rank: profile.rank,
        maxRating: profile.maxRating,
        maxRank: profile.maxRank,
        stars: profile.stars,
        organization: profile.organization,
        solvedTotal: profile.solvedTotal,
        solvedBuckets: profile.solvedBuckets,
        lastOnlineAt: formatTimestamp(profile.lastOnlineAt),
        registeredAt: formatTimestamp(profile.registeredAt),
      },
      image: {
        assetRef: image.assetRef,
        alt: rendered.alt,
      },
    });
  }
}

class CfUserRatingTool extends StructuredTool {
  name = CF_USER_RATING_TOOL;

  description =
    'Look up Codeforces rating history and return a rating chart image. Use this for rating trend/history/curve requests.';

  schema = z.object({
    handle: z.string().trim().min(1).describe('Codeforces handle, for example tourist or YingCir.'),
  });

  constructor(private readonly deps: ToolDeps) {
    super({});
  }

  async _call(input: z.infer<CfUserRatingTool['schema']>, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const session = config.configurable.session as Session | undefined;
    if (!session?.userId) {
      throw new Error('cf_user_rating requires the current session.');
    }

    const history = await this.deps.provider.getUserRatingHistory(input.handle);
    const rendered = await renderCodeforcesRatingChart(history, {
      width: this.deps.runtime.ratingChartWidth,
      height: this.deps.runtime.ratingChartHeight,
    });
    const image = await createImageAsset(
      this.deps.ctx.chatluna_storage,
      rendered.buffer,
      `cf-rating-${history.handle}-${randomUUID().slice(0, 8)}.png`,
    );

    return JSON.stringify({
      tool: this.name,
      handle: history.handle,
      summary: `${history.handle} 当前 rating ${history.currentRating ?? 'Unrated'}，最高 ${history.maxRating ?? 'Unrated'}，共 ${history.points.length} 场评分比赛。`,
      history: {
        currentRating: history.currentRating,
        maxRating: history.maxRating,
        contestCount: history.points.length,
        latest: history.points.at(-1) ?? null,
      },
      image: {
        assetRef: image.assetRef,
        alt: rendered.alt,
      },
    });
  }
}

class CfUserSubmissionsTool extends StructuredTool {
  name = CF_USER_SUBMISSIONS_TOOL;

  description =
    'Look up recent Codeforces submissions for a user. Use this for recent submissions, verdicts, or lately solved problems.';

  schema = z.object({
    handle: z.string().trim().min(1).describe('Codeforces handle, for example tourist or YingCir.'),
    limit: z.number().int().min(1).max(20).default(10).describe('How many recent submissions to return.'),
  });

  constructor(private readonly deps: ToolDeps) {
    super({});
  }

  async _call(input: z.infer<CfUserSubmissionsTool['schema']>, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const session = config.configurable.session as Session | undefined;
    if (!session?.userId) {
      throw new Error('cf_user_submissions requires the current session.');
    }

    const submissions = await this.deps.provider.getUserRecentSubmissions(input.handle, input.limit);
    return JSON.stringify({
      tool: this.name,
      handle: input.handle.trim(),
      returned: submissions.length,
      items: submissions.map((submission) => ({
        ...submission,
        submittedAt: formatTimestamp(submission.submittedAt),
      })),
    });
  }
}

class CfContestsTool extends StructuredTool {
  name = CF_CONTESTS_TOOL;

  description =
    'List upcoming, running, or recently finished Codeforces contests. Use this for contest schedule queries.';

  schema = z.object({
    mode: z.enum(['upcoming', 'running', 'recent_finished']).default('upcoming').describe('Contest list mode.'),
    limit: z.number().int().min(1).max(20).default(10).describe('How many contests to return.'),
  });

  constructor(private readonly deps: ToolDeps) {
    super({});
  }

  async _call(
    input: { mode: ContestQueryMode; limit: number },
    _runManager: unknown,
    config: ChatLunaToolRunnable,
  ): Promise<string> {
    const session = config.configurable.session as Session | undefined;
    if (!session?.userId) {
      throw new Error('cf_contests requires the current session.');
    }

    const contests = await this.deps.provider.listContests(input.mode, input.limit);
    return JSON.stringify({
      tool: this.name,
      mode: input.mode,
      returned: contests.length,
      items: contests.map((contest) => ({
        ...contest,
        startAt: formatTimestamp(contest.startTimeSeconds),
      })),
    });
  }
}

function registerOjTools(ctx: ContextWithOjTools, runtime: RuntimeConfig): Array<() => void> {
  const platform = ctx.chatluna.platform;
  const registerTool = platform?.registerTool?.bind(platform);
  if (!registerTool) {
    logger.warn('chatluna runtime tool registry is unavailable, skip oj-tools registration.');
    return [];
  }

  const provider = new CodeforcesProvider({
    cacheTtlMs: runtime.cacheTtlMs,
    requestIntervalMs: runtime.requestIntervalMs,
  });
  const deps: ToolDeps = { ctx, runtime, provider };

  return [
    registerTool(
      CF_USER_PROFILE_TOOL,
      createToolEntry(
        CF_USER_PROFILE_TOOL,
        'Read a Codeforces profile and return a score-card image plus structured rating details.',
        () => new CfUserProfileTool(deps),
      ),
    ),
    registerTool(
      CF_USER_RATING_TOOL,
      createToolEntry(
        CF_USER_RATING_TOOL,
        'Read Codeforces rating history and return a labeled rating chart image.',
        () => new CfUserRatingTool(deps),
      ),
    ),
    registerTool(
      CF_USER_SUBMISSIONS_TOOL,
      createToolEntry(
        CF_USER_SUBMISSIONS_TOOL,
        'Read recent Codeforces submissions and verdicts for a user.',
        () => new CfUserSubmissionsTool(deps),
      ),
    ),
    registerTool(
      CF_CONTESTS_TOOL,
      createToolEntry(
        CF_CONTESTS_TOOL,
        'Read upcoming, running, or recently finished Codeforces contests.',
        () => new CfContestsTool(deps),
      ),
    ),
  ];
}

export function apply(ctx: Context, config: Config = {}): void {
  const runtime = toRuntimeConfig(config);
  const serviceCtx = ctx as ContextWithOjTools;
  let disposers = registerOjTools(serviceCtx, runtime);

  ctx.on('ready', () => {
    if (disposers.length > 0) return;
    disposers = registerOjTools(serviceCtx, runtime);
  });

  ctx.on('dispose', () => {
    for (const dispose of disposers) {
      dispose();
    }
    disposers = [];
  });
}
