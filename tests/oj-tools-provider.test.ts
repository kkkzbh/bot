import { describe, expect, it, vi } from 'vitest';
import {
  CodeforcesProvider,
  filterContestsByMode,
  summarizeSolvedBuckets,
} from '../src/plugins/oj-tools/provider.js';

describe('CodeforcesProvider helpers', () => {
  it('summarizes solved buckets from accepted unique problems', () => {
    const summary = summarizeSolvedBuckets([
      { id: 1, verdict: 'OK', problem: { contestId: 1, index: 'A', name: 'One', rating: 900 } },
      { id: 2, verdict: 'OK', problem: { contestId: 1, index: 'B', name: 'Two', rating: 1500 } },
      { id: 3, verdict: 'WRONG_ANSWER', problem: { contestId: 1, index: 'C', name: 'Three', rating: 2100 } },
      { id: 4, verdict: 'OK', problem: { contestId: 1, index: 'B', name: 'Two', rating: 1500 } },
    ] as never);

    expect(summary).toEqual({
      solvedTotal: 2,
      solvedBuckets: [
        { threshold: 800, label: '800+', solvedCount: 2, solvedPercent: 100 },
        { threshold: 1400, label: '1400+', solvedCount: 1, solvedPercent: 50 },
        { threshold: 2000, label: '2000+', solvedCount: 0, solvedPercent: 0 },
        { threshold: 2600, label: '2600+', solvedCount: 0, solvedPercent: 0 },
      ],
    });
  });

  it('filters contests by query mode', () => {
    const contests = [
      { id: 1, name: 'A', phase: 'BEFORE', startTimeSeconds: 30 },
      { id: 2, name: 'B', phase: 'CODING', startTimeSeconds: 20 },
      { id: 3, name: 'C', phase: 'FINISHED', startTimeSeconds: 10 },
      { id: 4, name: 'D', phase: 'BEFORE', startTimeSeconds: 15 },
    ];

    expect(filterContestsByMode(contests as never, 'upcoming', 10).map((item) => item.id)).toEqual([4, 1]);
    expect(filterContestsByMode(contests as never, 'running', 10).map((item) => item.id)).toEqual([2]);
    expect(filterContestsByMode(contests as never, 'recent_finished', 10).map((item) => item.id)).toEqual([3]);
  });
});

describe('CodeforcesProvider', () => {
  it('parses public profile, rating, status, and contest responses', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/user.info')) {
        return {
          ok: true,
          json: async () => ({
            status: 'OK',
            result: [{
              handle: 'YingCir',
              rank: 'newbie',
              rating: 1015,
              maxRank: 'newbie',
              maxRating: 1015,
              titlePhoto: 'https://example.com/a.png',
            }],
          }),
        };
      }
      if (url.includes('/user.status')) {
        return {
          ok: true,
          json: async () => ({
            status: 'OK',
            result: [
              { id: 1, verdict: 'OK', problem: { contestId: 1, index: 'A', name: 'One', rating: 900 }, creationTimeSeconds: 10, programmingLanguage: 'GNU C++17' },
              { id: 2, verdict: 'OK', problem: { contestId: 1, index: 'B', name: 'Two', rating: 1500 }, creationTimeSeconds: 20, programmingLanguage: 'GNU C++17' },
              { id: 3, verdict: 'WRONG_ANSWER', problem: { contestId: 1, index: 'C', name: 'Three', rating: 1700 }, creationTimeSeconds: 30, programmingLanguage: 'GNU C++17' },
            ],
          }),
        };
      }
      if (url.includes('/user.rating')) {
        return {
          ok: true,
          json: async () => ({
            status: 'OK',
            result: [
              { contestId: 1, contestName: 'Round 1', rank: 10, oldRating: 800, newRating: 900, ratingUpdateTimeSeconds: 100 },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          status: 'OK',
          result: [
            { id: 10, name: 'Codeforces Round', phase: 'BEFORE', startTimeSeconds: 1000, durationSeconds: 7200 },
          ],
        }),
      };
    });

    const provider = new CodeforcesProvider({
      fetchImpl: fetchImpl as never,
      requestIntervalMs: 1,
    });

    await expect(provider.getUserProfile('YingCir')).resolves.toMatchObject({
      handle: 'YingCir',
      rating: 1015,
      solvedTotal: 2,
      recentPerformance: {
        sampleSize: 3,
        acceptedCount: 2,
        rejectedCount: 1,
        acceptedRate: 66.7,
        acceptedProblems: ['1A', '1B'],
        latestSubmittedAt: 30,
        latestVerdicts: [
          { verdict: 'OK', count: 2 },
          { verdict: 'WRONG_ANSWER', count: 1 },
        ],
      },
    });
    await expect(provider.getUserRatingHistory('YingCir')).resolves.toMatchObject({
      handle: 'YingCir',
      points: [
        expect.objectContaining({ newRating: 900 }),
      ],
    });
    await expect(provider.getUserRecentSubmissions('YingCir', 1)).resolves.toEqual([
      expect.objectContaining({ id: 1, problemName: 'One' }),
    ]);
    await expect(provider.listContests('upcoming', 5)).resolves.toEqual([
      expect.objectContaining({ id: 10, phase: 'BEFORE' }),
    ]);
  });

  it('normalizes failed api responses into readable errors', async () => {
    const provider = new CodeforcesProvider({
      fetchImpl: vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: 'FAILED',
          comment: 'handles: User with handle nobody not found',
        }),
      })) as never,
      requestIntervalMs: 1,
    });

    await expect(provider.getUserProfile('nobody')).rejects.toThrow('未找到 Codeforces 用户 nobody。');
  });
});
