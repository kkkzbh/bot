import { describe, expect, it, vi } from 'vitest';
import {
  buildAffinityPanelView,
  formatPanelRelativeTime,
  renderAffinityPanelHtml,
  resolveAffinityPanelLineKind,
  resolvePanelAssetUrls,
  selectAffinityPanelLine,
} from '../src/plugins/affinity/panel.js';
import { CHARACTER_ID, createInitialState, getShanghaiDayKey } from '../src/plugins/affinity/rules.js';
import type { AffinityEventRecord } from '../src/types/affinity.js';

vi.mock('koishi', () => ({
  h: {
    image: (buffer: Buffer, mime: string) => ({
      type: 'image',
      attrs: { buffer, mime },
      toString: () => `<image mime="${mime}"/>`,
    }),
  },
}));

const NOW = Date.UTC(2026, 5, 17, 1, 0, 0);
const USER_KEY = 'onebot:alice';

function event(overrides: Partial<AffinityEventRecord>): AffinityEventRecord {
  return {
    id: 1,
    characterId: CHARACTER_ID,
    userKey: USER_KEY,
    scopeKind: 'group',
    scopeId: '829573670',
    platform: 'onebot',
    botSelfId: 'bot-1',
    channelId: '829573670',
    guildId: '829573670',
    conversationId: 'conv-affinity',
    messageId: 'msg-1',
    eventType: 'answer_random_prompt',
    effectTier: 'progress',
    route: 'random_event_reply',
    confidence: 0.9,
    reasonCode: 'accepted',
    deltaJson: JSON.stringify({ trust: 1.2, familiarity: 0.8 }),
    beforeJson: null,
    afterJson: null,
    evidence: 'private raw evidence must not render',
    createdAt: NOW - 12 * 60_000,
    ...overrides,
  };
}

describe('affinity panel view', () => {
  it('builds panel data from state and effective events without hardcoded sample content', () => {
    const state = {
      ...createInitialState(NOW),
      trust: 43,
      familiarity: 58,
      comfort: 36,
      tension: 18,
      mood: 'focused' as const,
      attentionHeat: 72,
      energy: 72,
      stage: 'remembered' as const,
    };
    const view = buildAffinityPanelView({
      userKey: USER_KEY,
      state,
      now: NOW,
      recentEvents: [
        event({
          id: 3,
          eventType: 'answer_random_prompt',
          deltaJson: JSON.stringify({ trust: 1, familiarity: 1 }),
          createdAt: NOW - 12 * 60_000,
        }),
        event({
          id: 2,
          eventType: 'boundary_respect',
          deltaJson: JSON.stringify({ comfort: 1.5, tension: -0.7 }),
          createdAt: NOW - 24 * 60 * 60_000,
        }),
        event({
          id: 1,
          eventType: 'over_interaction',
          deltaJson: JSON.stringify({ attentionHeat: 6, tension: 2 }),
          createdAt: NOW - 3 * 24 * 60 * 60_000,
        }),
        event({
          id: 4,
          userKey: 'onebot:bob',
          eventType: 'contest_discussion',
          deltaJson: JSON.stringify({ trust: 2 }),
          createdAt: NOW - 6 * 60_000,
        }),
        event({
          id: 5,
          eventType: 'none',
          effectTier: 'ignore',
          deltaJson: JSON.stringify({}),
          createdAt: NOW - 5 * 60_000,
        }),
      ],
    });

    expect(view.stageName).toBe('被记住的人');
    expect(view.lineKind).toBe('overheated');
    expect(view.lastRelationChange).toBe('12分钟前');
    expect(view.axes.map((axis) => [axis.name, axis.value])).toEqual([
      ['信赖', 43],
      ['熟悉', 58],
      ['安心', 36],
      ['紧张', 18],
    ]);
    expect(view.recentEvents.map((item) => item.title)).toEqual([
      '连续互动让距离变得太密',
      '尊重了她没有继续说的部分',
      '承接了她主动打开的话题',
    ]);
    expect(view.recentEvents[1]?.effects).toEqual([
      { name: '安心', sign: '+' },
      { name: '紧张', sign: '-' },
    ]);
  });

  it('keeps line selection deterministic per user, day, and line kind', () => {
    const state = {
      ...createInitialState(NOW),
      stage: 'special' as const,
      attentionHeat: 71,
      tension: 20,
    };
    const lineKind = resolveAffinityPanelLineKind(state);
    expect(lineKind).toBe('overheated');
    expect(getShanghaiDayKey(NOW)).toBe('2026-06-17');
    expect(selectAffinityPanelLine(USER_KEY, lineKind, NOW)).toBe(selectAffinityPanelLine(USER_KEY, lineKind, NOW));
  });

  it('renders markdown-free HTML without external prototype paths or raw millisecond timestamps', () => {
    const view = buildAffinityPanelView({
      userKey: USER_KEY,
      state: {
        ...createInitialState(NOW),
        trust: 43,
        familiarity: 58,
        comfort: 36,
        tension: 18,
        stage: 'remembered',
      },
      now: NOW,
      recentEvents: [
        event({
          eventType: 'boundary_respect',
          deltaJson: JSON.stringify({ comfort: 1, tension: -1 }),
          createdAt: NOW - 12 * 60_000,
        }),
      ],
    });
    const html = renderAffinityPanelHtml(view, {
      background: 'file:///runtime/panel-bg.png',
      banner: 'file:///runtime/panel-banner.png',
      logo: 'file:///runtime/panel-logo.png',
    });

    expect(html).not.toContain('/mnt/d');
    expect(html).not.toContain('docs/affinity-panel-prototype');
    expect(html).not.toContain(String(NOW));
    expect(html).not.toContain('private raw evidence');
    expect(html).toContain('class="effect-token is-positive"');
    expect(html).toContain('class="effect-token is-negative"');
    expect(html).toContain('低频、认真地回应她已经打开的话题。');
  });

  it('uses runtime file assets that can be loaded from a file-backed page', () => {
    const assets = resolvePanelAssetUrls();
    expect(assets.background).toMatch(/^file:\/\//);
    expect(assets.banner).toMatch(/^file:\/\//);
    expect(assets.logo).toMatch(/^file:\/\//);
    const html = renderAffinityPanelHtml(buildAffinityPanelView({
      userKey: USER_KEY,
      state: createInitialState(NOW),
      now: NOW,
      recentEvents: [],
    }));
    expect(html).toContain('panel-bg.png');
    expect(html).toContain('panel-banner.png');
    expect(html).toContain('panel-logo.png');
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('/mnt/d');
  });

  it('formats relation timestamps as human-readable labels', () => {
    expect(formatPanelRelativeTime(NOW - 12 * 60_000, NOW)).toBe('12分钟前');
    expect(formatPanelRelativeTime(null, NOW)).toBe('尚无');
  });
});
