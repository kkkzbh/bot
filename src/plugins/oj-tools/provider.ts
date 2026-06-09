import { setTimeout as sleep } from 'node:timers/promises';

const CODEFORCES_API_BASE = 'https://codeforces.com/api';
const DEFAULT_TIMEOUT_MS = 12_000;
const PROFILE_CACHE_TTL_MS = 5 * 60_000;
const STATUS_CACHE_TTL_MS = 60_000;
const RATING_CACHE_TTL_MS = 60_000;
const CONTEST_CACHE_TTL_MS = 5 * 60_000;
const STATUS_FETCH_COUNT = 10_000;

export type ContestQueryMode = 'upcoming' | 'running' | 'recent_finished';

type FetchLike = typeof fetch;

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

type CodeforcesApiEnvelope<T> = {
  status: 'OK' | 'FAILED';
  result?: T;
  comment?: string;
};

type CodeforcesUser = {
  handle: string;
  organization?: string;
  contribution?: number;
  rank?: string;
  rating?: number;
  maxRank?: string;
  maxRating?: number;
  lastOnlineTimeSeconds?: number;
  registrationTimeSeconds?: number;
  avatar?: string;
  titlePhoto?: string;
};

type CodeforcesProblem = {
  contestId?: number;
  problemsetName?: string;
  index?: string;
  name?: string;
  rating?: number;
};

type CodeforcesSubmission = {
  id: number;
  contestId?: number;
  creationTimeSeconds?: number;
  problem?: CodeforcesProblem;
  programmingLanguage?: string;
  verdict?: string;
};

type CodeforcesRatingChange = {
  contestId: number;
  contestName: string;
  rank: number;
  ratingUpdateTimeSeconds: number;
  oldRating: number;
  newRating: number;
};

type CodeforcesContest = {
  id: number;
  name: string;
  phase: string;
  durationSeconds?: number;
  startTimeSeconds?: number;
};

export interface SolvedBucket {
  threshold: number;
  label: string;
  solvedCount: number;
  solvedPercent: number;
}

export interface CodeforcesUserProfile {
  handle: string;
  displayName: string;
  rating: number | null;
  rank: string;
  maxRating: number | null;
  maxRank: string;
  avatarUrl: string | null;
  organization: string | null;
  contribution: number | null;
  lastOnlineAt: number | null;
  registeredAt: number | null;
  stars: number;
  solvedTotal: number;
  solvedBuckets: SolvedBucket[];
  recentPerformance?: CodeforcesRecentPerformanceSummary;
}

export interface CodeforcesRatingPoint {
  contestId: number;
  contestName: string;
  rank: number;
  oldRating: number;
  newRating: number;
  timestamp: number;
}

export interface CodeforcesRatingHistory {
  handle: string;
  displayName: string;
  currentRating: number | null;
  maxRating: number | null;
  points: CodeforcesRatingPoint[];
}

export interface CodeforcesSubmissionSummary {
  id: number;
  contestId: number | null;
  problemIndex: string;
  problemName: string;
  problemRating: number | null;
  verdict: string;
  language: string;
  submittedAt: number | null;
}

export interface CodeforcesRecentPerformanceSummary {
  sampleSize: number;
  acceptedCount: number;
  rejectedCount: number;
  acceptedRate: number;
  acceptedProblems: string[];
  latestSubmittedAt: number | null;
  latestVerdicts: Array<{
    verdict: string;
    count: number;
  }>;
}

export interface CodeforcesContestSummary {
  id: number;
  name: string;
  phase: string;
  startTimeSeconds: number | null;
  durationSeconds: number | null;
}

export interface CodeforcesProviderOptions {
  cacheTtlMs?: number;
  requestIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

function normalizeHandle(handle: string): string {
  return handle.trim();
}

function normalizeCodeforcesAssetUrl(url: string | undefined): string | null {
  const normalized = String(url ?? '').trim();
  if (!normalized) return null;
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) return normalized;
  if (normalized.startsWith('//')) return `https:${normalized}`;
  return normalized;
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    search.set(key, String(value));
  }
  return search.toString();
}

function formatCodeforcesComment(comment: string, handle?: string): string {
  const normalized = comment.trim();
  if (/not found/i.test(normalized) && handle) {
    return `未找到 Codeforces 用户 ${handle}。`;
  }
  return `Codeforces API 返回失败：${normalized}`;
}

function inferStars(rating: number | null, rank: string): number {
  const normalizedRank = rank.toLowerCase();
  if (normalizedRank.includes('legendary')) return 10;
  if (normalizedRank.includes('international grandmaster')) return 9;
  if (normalizedRank.includes('grandmaster')) return 8;
  if (normalizedRank.includes('international master')) return 7;
  if (normalizedRank.includes('master')) return 6;
  if (normalizedRank.includes('candidate master')) return 5;

  const value = rating ?? 0;
  if (value < 1200) return 1;
  if (value < 1400) return 2;
  if (value < 1600) return 3;
  if (value < 1800) return 4;
  if (value < 2000) return 5;
  if (value < 2200) return 6;
  if (value < 2400) return 7;
  if (value < 2600) return 8;
  if (value < 3000) return 9;
  return 10;
}

function buildProblemKey(problem: CodeforcesProblem | undefined): string | null {
  if (!problem) return null;
  const contestId = problem.contestId != null ? String(problem.contestId) : '';
  const problemsetName = String(problem.problemsetName ?? '').trim();
  const index = String(problem.index ?? '').trim();
  const name = String(problem.name ?? '').trim();
  if (!index && !name) return null;
  return `${contestId}:${problemsetName}:${index}:${name}`;
}

export function summarizeSolvedBuckets(submissions: CodeforcesSubmission[]): {
  solvedTotal: number;
  solvedBuckets: SolvedBucket[];
} {
  const solved = new Map<string, number | null>();

  for (const submission of submissions) {
    if (submission.verdict !== 'OK') continue;
    const key = buildProblemKey(submission.problem);
    if (!key || solved.has(key)) continue;
    solved.set(key, submission.problem?.rating ?? null);
  }

  const solvedRatings = [...solved.values()].filter((value): value is number => typeof value === 'number');
  const solvedTotal = solved.size;
  const thresholds = [800, 1400, 2000, 2600] as const;

  return {
    solvedTotal,
    solvedBuckets: thresholds.map((threshold) => {
      const solvedCount = solvedRatings.filter((rating) => rating >= threshold).length;
      return {
        threshold,
        label: `${threshold}+`,
        solvedCount,
        solvedPercent: solvedTotal > 0 ? Number(((solvedCount / solvedTotal) * 100).toFixed(1)) : 0,
      };
    }),
  };
}

function summarizeRecentPerformance(submissions: CodeforcesSubmission[], limit = 20): CodeforcesRecentPerformanceSummary {
  const recent = submissions.slice(0, Math.max(1, Math.floor(limit)));
  const verdictCounts = new Map<string, number>();
  const acceptedProblems = new Set<string>();
  let acceptedCount = 0;
  let latestSubmittedAt: number | null = null;

  for (const submission of recent) {
    const verdict = String(submission.verdict ?? 'UNKNOWN').trim() || 'UNKNOWN';
    verdictCounts.set(verdict, (verdictCounts.get(verdict) ?? 0) + 1);
    if (submission.verdict === 'OK') {
      acceptedCount += 1;
      const problem = submission.problem;
      const label = [problem?.contestId, problem?.index].filter((item) => item != null && String(item).trim()).join('');
      if (label) acceptedProblems.add(label);
    }
    if (typeof submission.creationTimeSeconds === 'number') {
      latestSubmittedAt = latestSubmittedAt == null
        ? submission.creationTimeSeconds
        : Math.max(latestSubmittedAt, submission.creationTimeSeconds);
    }
  }

  return {
    sampleSize: recent.length,
    acceptedCount,
    rejectedCount: Math.max(0, recent.length - acceptedCount),
    acceptedRate: recent.length > 0 ? Number(((acceptedCount / recent.length) * 100).toFixed(1)) : 0,
    acceptedProblems: [...acceptedProblems].slice(0, 8),
    latestSubmittedAt,
    latestVerdicts: [...verdictCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 5)
      .map(([verdict, count]) => ({ verdict, count })),
  };
}

export function filterContestsByMode(
  contests: CodeforcesContest[],
  mode: ContestQueryMode,
  limit = 10,
): CodeforcesContestSummary[] {
  const normalizedLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  let filtered: CodeforcesContest[];

  if (mode === 'running') {
    filtered = contests.filter((contest) => contest.phase === 'CODING');
  } else if (mode === 'recent_finished') {
    filtered = contests
      .filter((contest) => contest.phase === 'FINISHED')
      .sort((left, right) => (right.startTimeSeconds ?? 0) - (left.startTimeSeconds ?? 0));
  } else {
    filtered = contests
      .filter((contest) => contest.phase === 'BEFORE')
      .sort((left, right) => (left.startTimeSeconds ?? Number.MAX_SAFE_INTEGER) - (right.startTimeSeconds ?? Number.MAX_SAFE_INTEGER));
  }

  return filtered.slice(0, normalizedLimit).map((contest) => ({
    id: contest.id,
    name: contest.name,
    phase: contest.phase,
    startTimeSeconds: contest.startTimeSeconds ?? null,
    durationSeconds: contest.durationSeconds ?? null,
  }));
}

export class CodeforcesProvider {
  private readonly fetchImpl: FetchLike;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly defaultCacheTtlMs: number;
  private readonly requestIntervalMs: number;
  private readonly timeoutMs: number;
  private pending = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: CodeforcesProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultCacheTtlMs = options.cacheTtlMs ?? PROFILE_CACHE_TTL_MS;
    this.requestIntervalMs = options.requestIntervalMs ?? 2_100;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getUserProfile(handle: string): Promise<CodeforcesUserProfile> {
    const normalizedHandle = normalizeHandle(handle);
    const [user] = await this.fetchApi<CodeforcesUser[]>('user.info', { handles: normalizedHandle }, {
      cacheTtlMs: PROFILE_CACHE_TTL_MS,
      handle: normalizedHandle,
    });
    const submissions = await this.fetchApi<CodeforcesSubmission[]>('user.status', {
      handle: normalizedHandle,
      from: 1,
      count: STATUS_FETCH_COUNT,
    }, {
      cacheTtlMs: STATUS_CACHE_TTL_MS,
      handle: normalizedHandle,
    });
    const solvedSummary = summarizeSolvedBuckets(submissions);
    const recentPerformance = summarizeRecentPerformance(submissions);

    return {
      handle: user.handle,
      displayName: user.handle,
      rating: typeof user.rating === 'number' ? user.rating : null,
      rank: String(user.rank ?? 'Unrated').trim() || 'Unrated',
      maxRating: typeof user.maxRating === 'number' ? user.maxRating : null,
      maxRank: String(user.maxRank ?? user.rank ?? 'Unrated').trim() || 'Unrated',
      avatarUrl: normalizeCodeforcesAssetUrl(user.titlePhoto ?? user.avatar),
      organization: String(user.organization ?? '').trim() || null,
      contribution: typeof user.contribution === 'number' ? user.contribution : null,
      lastOnlineAt: typeof user.lastOnlineTimeSeconds === 'number' ? user.lastOnlineTimeSeconds : null,
      registeredAt: typeof user.registrationTimeSeconds === 'number' ? user.registrationTimeSeconds : null,
      stars: inferStars(
        typeof user.maxRating === 'number' ? user.maxRating : typeof user.rating === 'number' ? user.rating : null,
        String(user.maxRank ?? user.rank ?? ''),
      ),
      solvedTotal: solvedSummary.solvedTotal,
      solvedBuckets: solvedSummary.solvedBuckets,
      recentPerformance,
    };
  }

  async getUserRatingHistory(handle: string): Promise<CodeforcesRatingHistory> {
    const normalizedHandle = normalizeHandle(handle);
    const [[user], changes] = await Promise.all([
      this.fetchApi<CodeforcesUser[]>('user.info', { handles: normalizedHandle }, {
        cacheTtlMs: PROFILE_CACHE_TTL_MS,
        handle: normalizedHandle,
      }),
      this.fetchApi<CodeforcesRatingChange[]>('user.rating', { handle: normalizedHandle }, {
        cacheTtlMs: RATING_CACHE_TTL_MS,
        handle: normalizedHandle,
      }),
    ]);

    return {
      handle: user.handle,
      displayName: user.handle,
      currentRating: typeof user.rating === 'number' ? user.rating : null,
      maxRating: typeof user.maxRating === 'number' ? user.maxRating : null,
      points: changes.map((change) => ({
        contestId: change.contestId,
        contestName: change.contestName,
        rank: change.rank,
        oldRating: change.oldRating,
        newRating: change.newRating,
        timestamp: change.ratingUpdateTimeSeconds,
      })),
    };
  }

  async getUserRecentSubmissions(handle: string, limit = 10): Promise<CodeforcesSubmissionSummary[]> {
    const normalizedHandle = normalizeHandle(handle);
    const count = Math.max(1, Math.min(50, Math.floor(limit || 10)));
    const submissions = await this.fetchApi<CodeforcesSubmission[]>('user.status', {
      handle: normalizedHandle,
      from: 1,
      count,
    }, {
      cacheTtlMs: STATUS_CACHE_TTL_MS,
      handle: normalizedHandle,
    });

    return submissions.slice(0, count).map((submission) => ({
      id: submission.id,
      contestId: submission.contestId ?? null,
      problemIndex: String(submission.problem?.index ?? '').trim() || '?',
      problemName: String(submission.problem?.name ?? '').trim() || 'Unknown Problem',
      problemRating: typeof submission.problem?.rating === 'number' ? submission.problem.rating : null,
      verdict: String(submission.verdict ?? 'UNKNOWN').trim() || 'UNKNOWN',
      language: String(submission.programmingLanguage ?? '').trim() || 'Unknown',
      submittedAt: typeof submission.creationTimeSeconds === 'number' ? submission.creationTimeSeconds : null,
    }));
  }

  async listContests(mode: ContestQueryMode, limit = 10): Promise<CodeforcesContestSummary[]> {
    const contests = await this.fetchApi<CodeforcesContest[]>('contest.list', {
      gym: false,
    }, {
      cacheTtlMs: CONTEST_CACHE_TTL_MS,
    });
    return filterContestsByMode(contests, mode, limit);
  }

  private async fetchApi<T>(
    method: string,
    params: Record<string, string | number | boolean | undefined>,
    options: {
      cacheTtlMs?: number;
      handle?: string;
    } = {},
  ): Promise<T> {
    const query = buildQuery(params);
    const cacheKey = `${method}?${query}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value as T;
    }

    const result = await this.runWithRateLimit(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${CODEFORCES_API_BASE}/${method}?${query}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Codeforces 请求失败（HTTP ${response.status}）。`);
        }

        const payload = await response.json() as CodeforcesApiEnvelope<T>;
        if (payload.status !== 'OK') {
          throw new Error(formatCodeforcesComment(String(payload.comment ?? 'unknown error'), options.handle));
        }
        if (payload.result == null) {
          throw new Error('Codeforces API 返回了空结果。');
        }
        return payload.result;
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          throw new Error('Codeforces 请求超时。');
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    });

    this.cache.set(cacheKey, {
      expiresAt: now + (options.cacheTtlMs ?? this.defaultCacheTtlMs),
      value: result,
    });
    return result;
  }

  private async runWithRateLimit<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.pending.catch(() => undefined);
    let release: () => void = () => {};
    this.pending = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    await previous;
    const waitMs = Math.max(0, this.lastRequestAt + this.requestIntervalMs - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this.lastRequestAt = Date.now();

    try {
      return await task();
    } finally {
      release();
    }
  }
}
