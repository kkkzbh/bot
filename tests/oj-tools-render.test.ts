import { createCanvas } from '@napi-rs/canvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __testables, renderCodeforcesProfileCard, renderCodeforcesRatingChart } from '../src/plugins/oj-tools/render.js';

async function createAvatarBuffer(): Promise<Buffer> {
  const canvas = createCanvas(64, 64);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#2E5BFF';
  ctx.fillRect(10, 10, 44, 44);
  return canvas.encode('png');
}

function readPngSize(buffer: Buffer): { width: number; height: number } {
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function createRenderContext() {
  __testables.registerFonts();
  return createCanvas(600, 800).getContext('2d');
}

describe('oj-tools renderer', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-07T17:13:07+08:00'));
    const avatarBuffer = await createAvatarBuffer();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => avatarBuffer,
    })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders the YingCir profile card as a 600x800 PNG with the expected alt text', async () => {
    const rendered = await renderCodeforcesProfileCard({
      handle: 'YingCir',
      displayName: 'YingCir',
      rating: 1015,
      rank: 'newbie',
      maxRating: 1015,
      maxRank: 'newbie',
      avatarUrl: 'https://example.com/avatar.png',
      organization: null,
      contribution: null,
      lastOnlineAt: null,
      registeredAt: null,
      stars: 1,
      solvedTotal: 21,
      solvedBuckets: [
        { threshold: 800, label: '800+', solvedCount: 9, solvedPercent: 42.9 },
        { threshold: 1400, label: '1400+', solvedCount: 1, solvedPercent: 4.8 },
        { threshold: 2000, label: '2000+', solvedCount: 0, solvedPercent: 0 },
        { threshold: 2600, label: '2600+', solvedCount: 0, solvedPercent: 0 },
      ],
    });

    expect(rendered.alt).toContain('YingCir');
    expect(rendered.buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(readPngSize(rendered.buffer)).toEqual({ width: 600, height: 800 });
  });

  it('renders the YingCir rating chart as a 1789x838 PNG with the expected alt text', async () => {
    const rendered = await renderCodeforcesRatingChart({
      handle: 'YingCir',
      displayName: 'YingCir',
      currentRating: 1015,
      maxRating: 1015,
      points: [
        { contestId: 1, contestName: 'Round 1', rank: 10, oldRating: 400, newRating: 422, timestamp: 1_769_385_600 },
        { contestId: 2, contestName: 'Round 2', rank: 12, oldRating: 422, newRating: 701, timestamp: 1_771_200_000 },
        { contestId: 3, contestName: 'Round 3', rank: 9, oldRating: 701, newRating: 1015, timestamp: 1_775_347_200 },
      ],
    }, {
      width: 1789,
      height: 838,
    });

    expect(rendered.alt).toContain('rating');
    expect(rendered.buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(readPngSize(rendered.buffer)).toEqual({ width: 1789, height: 838 });
  });

  it('renders a different profile card when identity data changes', async () => {
    const [baseline, variant] = await Promise.all([
      renderCodeforcesProfileCard({
        handle: 'YingCir',
        displayName: 'YingCir',
        rating: 1015,
        rank: 'newbie',
        maxRating: 1015,
        maxRank: 'newbie',
        avatarUrl: 'https://example.com/avatar.png',
        organization: null,
        contribution: null,
        lastOnlineAt: null,
        registeredAt: null,
        stars: 1,
        solvedTotal: 21,
        solvedBuckets: [
          { threshold: 800, label: '800+', solvedCount: 9, solvedPercent: 42.9 },
          { threshold: 1400, label: '1400+', solvedCount: 1, solvedPercent: 4.8 },
          { threshold: 2000, label: '2000+', solvedCount: 0, solvedPercent: 0 },
          { threshold: 2600, label: '2600+', solvedCount: 0, solvedPercent: 0 },
        ],
      }),
      renderCodeforcesProfileCard({
        handle: 'kkkzbh',
        displayName: 'kkkzbh',
        rating: 1411,
        rank: 'specialist',
        maxRating: 1411,
        maxRank: 'specialist',
        avatarUrl: 'https://example.com/avatar.png',
        organization: null,
        contribution: null,
        lastOnlineAt: null,
        registeredAt: null,
        stars: 2,
        solvedTotal: 21,
        solvedBuckets: [
          { threshold: 800, label: '800+', solvedCount: 9, solvedPercent: 42.9 },
          { threshold: 1400, label: '1400+', solvedCount: 1, solvedPercent: 4.8 },
          { threshold: 2000, label: '2000+', solvedCount: 0, solvedPercent: 0 },
          { threshold: 2600, label: '2600+', solvedCount: 0, solvedPercent: 0 },
        ],
      }),
    ]);

    expect(variant.alt).toContain('kkkzbh');
    expect(variant.buffer.equals(baseline.buffer)).toBe(false);
  });

  it('keeps single-word levels on one line and splits long two-word levels into two lines', () => {
    const ctx = createRenderContext();

    const specialist = __testables.layoutLevelText(ctx, 'specialist');
    expect(specialist.mode).toBe('single');
    expect(specialist.lines).toHaveLength(1);
    expect(specialist.lines[0]).toMatchObject({
      text: 'Specialist',
      y: 674,
    });
    expect(specialist.lines[0]!.width).toBeLessThanOrEqual(228);

    const legendary = __testables.layoutLevelText(ctx, 'legendary grandmaster');
    expect(legendary.mode).toBe('split');
    expect(legendary.lines).toHaveLength(2);
    expect(legendary.lines.map((line) => line.text)).toEqual(['Legendary', 'Grandmaster']);
    expect(legendary.lines.map((line) => line.y)).toEqual([662, 698]);
    legendary.lines.forEach((line) => {
      expect(line.width).toBeLessThanOrEqual(228);
    });

    const international = __testables.layoutLevelText(ctx, 'international grandmaster');
    expect(international.mode).toBe('split');
    expect(international.lines).toHaveLength(2);
    expect(international.lines.map((line) => line.text)).toEqual(['International', 'Grandmaster']);
    expect(international.lines.map((line) => line.y)).toEqual([662, 698]);
    international.lines.forEach((line) => {
      expect(line.width).toBeLessThanOrEqual(228);
    });
  });

  it('draws the star badge icon with a polygon path instead of a text glyph', () => {
    const pathOps = {
      fillStyle: '',
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(() => {
        throw new Error('star icon should not use fillText');
      }),
    };
    const fakeCtx = pathOps as unknown as Parameters<typeof __testables.drawStarBadgeIcon>[0];

    expect(() => {
      __testables.drawStarBadgeIcon(fakeCtx, 314, 343, { star: '#FFC65A' } as any);
    }).not.toThrow();
    expect(pathOps.beginPath).toHaveBeenCalledTimes(1);
    expect(pathOps.moveTo).toHaveBeenCalledTimes(1);
    expect(pathOps.lineTo).toHaveBeenCalledTimes(9);
    expect(pathOps.closePath).toHaveBeenCalledTimes(1);
    expect(pathOps.fill).toHaveBeenCalledTimes(1);
  });

  it('renders cards and charts for high-rating and long-name inputs without overflow failures', async () => {
    const card = await renderCodeforcesProfileCard({
      handle: 'tourist',
      displayName: 'very_long_handle_for_snapshot_check',
      rating: 3850,
      rank: 'legendary grandmaster',
      maxRating: 3850,
      maxRank: 'legendary grandmaster',
      avatarUrl: null,
      organization: 'Codeforces',
      contribution: 999,
      lastOnlineAt: null,
      registeredAt: null,
      stars: 10,
      solvedTotal: 3500,
      solvedBuckets: [
        { threshold: 800, label: '800+', solvedCount: 3400, solvedPercent: 97.1 },
        { threshold: 1400, label: '1400+', solvedCount: 3100, solvedPercent: 88.6 },
        { threshold: 2000, label: '2000+', solvedCount: 2200, solvedPercent: 62.9 },
        { threshold: 2600, label: '2600+', solvedCount: 900, solvedPercent: 25.7 },
      ],
    });

    const chart = await renderCodeforcesRatingChart({
      handle: 'tourist',
      displayName: 'tourist',
      currentRating: 3850,
      maxRating: 3850,
      points: [
        { contestId: 1, contestName: 'A', rank: 1, oldRating: 3300, newRating: 3400, timestamp: 1_700_000_000 },
        { contestId: 2, contestName: 'B', rank: 1, oldRating: 3400, newRating: 3600, timestamp: 1_710_000_000 },
        { contestId: 3, contestName: 'C', rank: 1, oldRating: 3600, newRating: 3850, timestamp: 1_720_000_000 },
      ],
    }, {
      width: 1789,
      height: 838,
    });

    expect(card.buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(chart.buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
