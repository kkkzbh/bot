import { randomUUID } from 'node:crypto';
import { StructuredTool } from '@langchain/core/tools';
import { Context, Logger, Schema } from 'koishi';
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

export interface Config {
  cacheTtlMs?: number;
  requestIntervalMs?: number;
  ratingChartWidth?: number;
  ratingChartHeight?: number;
}

export const Config: Schema<Config> = Schema.object({
  cacheTtlMs: Schema.natural().description('Codeforces 查询结果进程内缓存时间（毫秒）。'),
  requestIntervalMs: Schema.natural().description('Codeforces API 最小请求间隔（毫秒）。'),
  ratingChartWidth: Schema.natural().description('rating 历史图宽度。'),
  ratingChartHeight: Schema.natural().description('rating 历史图高度。'),
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

type ToolSessionLike = {
  userId?: string | null;
};

function requireNaturalConfig(config: Config, key: keyof Config): number {
  const value = config[key];
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`OJ 工具配置缺失或非法：${String(key)}。默认值必须由 koishi.yml 显式传入。`);
  }
  return Math.floor(parsed);
}

function toRuntimeConfig(config: Config): RuntimeConfig {
  return {
    cacheTtlMs: requireNaturalConfig(config, 'cacheTtlMs'),
    requestIntervalMs: requireNaturalConfig(config, 'requestIntervalMs'),
    ratingChartWidth: requireNaturalConfig(config, 'ratingChartWidth'),
    ratingChartHeight: requireNaturalConfig(config, 'ratingChartHeight'),
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
    const session = config.configurable.session as ToolSessionLike | undefined;
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
    const recentPerformance = profile.recentPerformance ?? {
      sampleSize: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      acceptedRate: 0,
      acceptedProblems: [],
      latestSubmittedAt: null,
      latestVerdicts: [],
    };

    return JSON.stringify({
      tool: this.name,
      handle: profile.handle,
      summary: `${profile.handle} 当前 rating ${profile.rating ?? 'Unrated'}，段位 ${profile.rank}，最高 ${profile.maxRating ?? 'Unrated'}。`,
      recommendedReplyOrder: [
        'send image as the first outbound message using image.assetRef and image.alt',
        'then send one short message evaluating the user from current rating/rank and recentPerformance',
      ],
      profile: {
        rating: profile.rating,
        rank: profile.rank,
        maxRating: profile.maxRating,
        maxRank: profile.maxRank,
        stars: profile.stars,
        organization: profile.organization,
        solvedTotal: profile.solvedTotal,
        solvedBuckets: profile.solvedBuckets,
        recentPerformance: {
          ...recentPerformance,
          latestSubmittedAt: formatTimestamp(recentPerformance.latestSubmittedAt),
        },
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
    const session = config.configurable.session as ToolSessionLike | undefined;
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
      recommendedReplyOrder: [
        'send image as the first outbound message using image.assetRef and image.alt',
        'then send one short message evaluating the recent rating trend from history.latest',
      ],
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
    const session = config.configurable.session as ToolSessionLike | undefined;
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
    const session = config.configurable.session as ToolSessionLike | undefined;
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
