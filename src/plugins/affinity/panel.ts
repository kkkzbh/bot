import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { h } from 'koishi';
import type {
  AffinityEventRecord,
  AffinityEventType,
  AffinityPanelAxis,
  AffinityPanelEffectToken,
  AffinityPanelLineKind,
  AffinityPanelRecentEvent,
  AffinityPanelRhythmItem,
  AffinityPanelView,
} from '../../types/affinity.js';
import {
  CHARACTER_ID,
  STAGE_LABELS,
  getShanghaiDayKey,
  type AffinityStateInput,
} from './rules.js';

const PANEL_WIDTH = 900;
const PANEL_HEIGHT = 1160;
const OVERHEATED_HEAT_THRESHOLD = 70;
const OVERHEATED_TENSION_THRESHOLD = 60;

const STAGE_ICONS: Record<AffinityPanelLineKind, string> = {
  stranger: '◆',
  polite: '◇',
  remembered: '◆',
  trusted: '✦',
  special: '✶',
  overheated: '!',
};

const MOOD_LABELS: Record<AffinityStateInput['mood'], string> = {
  neutral: '平稳',
  calm: '安静',
  focused: '专注',
  pleased: '柔和',
  guarded: '戒备',
  tired: '疲惫',
  embarrassed: '动摇',
};

const ADVICE_BY_LINE_KIND: Record<AffinityPanelLineKind, string> = {
  stranger: '轻轻回应她打开的话题，不必急着靠近。',
  polite: '保持分寸地接话，比刻意刷存在感更合适。',
  remembered: '低频、认真地回应她已经打开的话题。',
  trusted: '能分担时再靠近，别把承诺说得太轻。',
  special: '稳定回来，把重要的话题好好接住。',
  overheated: '先停一停，给话题留下安静的余地。',
};

const FIXED_LINES: Record<AffinityPanelLineKind, readonly string[]> = {
  stranger: [
    '记录已经看过了。现在这样，保持礼貌的距离就好。',
    '还只是刚开始而已……不用急着靠近。',
    '我会记住必要的部分，其余的就慢慢来。',
    '今天到这里就可以了。太刻意反而会让人困扰。',
    '如果只是普通地说话，我并不讨厌。',
  ],
  polite: [
    '能这样稳定地打招呼，已经比一时兴起要好。',
    '我看到了。不是每一次回应都需要很用力。',
    '保持分寸的话，我会比较容易接受。',
    '偶尔能接上话题……也不算坏事。',
    '现在这样就好，别把日常也弄成任务。',
  ],
  remembered: [
    '你之前说过的事，我多少还记得一点。',
    '能被稳定地回应，确实会让人安心一些。',
    '不是因为次数多，而是因为你没有把话题随便丢下。',
    '前面留下的事，如果愿意，也可以慢慢接回去。',
    '这样被记住的感觉……并不让人讨厌。',
  ],
  trusted: [
    '有些事交给你处理，我大概不用一直盯着。',
    '如果只是短暂地依靠一下……应该也可以。',
    '你能明白什么时候该继续，什么时候该停下。',
    '我不太擅长说这种话，但你的回应帮上忙了。',
    '这份记录不是奖励，只是我确实看见了。',
  ],
  special: [
    '能走到这里，不是靠催促或偶然。',
    '如果是你的话，有些话我可以不必绕得太远。',
    '我会把这份信赖放在心上，所以也请你认真对待。',
    '不用每天证明什么，能好好回来就足够了。',
    '这不是可以轻易重来的关系。请别随便弄丢。',
  ],
  overheated: [
    '现在有点太密了。先让话题安静一会儿。',
    '继续追问只会让距离变远。今天到这里比较好。',
    '我不是在拒绝你，只是需要一点空隙。',
    '别把回应变成催促。那样我会更难开口。',
    '如果真的在意，就先停一下。',
  ],
};

const EVENT_TITLES: Record<AffinityEventType, string> = {
  none: '普通交谈没有形成关系变化',
  greeting_contextual: '自然地接上了日常问候',
  offer_tea: '用合适的方式递来了茶',
  music_help: '帮上了排练或音乐相关的忙',
  care_subtle: '没有越界地表达了关心',
  keep_promise: '记得并兑现了之前说好的事',
  boundary_respect: '尊重了她没有继续说的部分',
  light_tease: '轻轻接住了玩笑',
  contest_discussion: '一起推进了题目讨论',
  computer_knowledge: '一起处理了技术问题',
  answer_random_prompt: '承接了她主动打开的话题',
  over_interaction: '连续互动让距离变得太密',
  pressure_or_spam: '催促让紧张感上升',
  promise_broken: '没有接上之前约好的事',
};

const EVENT_ICONS: Record<AffinityEventType, string> = {
  none: '◇',
  greeting_contextual: '◇',
  offer_tea: '◆',
  music_help: '♪',
  care_subtle: '☾',
  keep_promise: '✦',
  boundary_respect: '☾',
  light_tease: '◇',
  contest_discussion: '✦',
  computer_knowledge: '∿',
  answer_random_prompt: '✦',
  over_interaction: '!',
  pressure_or_spam: '!',
  promise_broken: '!',
};

const EFFECT_LABELS = {
  trust: '信赖',
  familiarity: '熟悉',
  comfort: '安心',
  tension: '紧张',
  attentionHeat: '热度',
  energy: '体力',
} as const;

const EFFECT_ORDER = ['trust', 'familiarity', 'comfort', 'tension', 'attentionHeat', 'energy'] as const;

export interface AffinityPanelAssetUrls {
  background: string;
  banner: string;
  logo: string;
}

export interface AffinityPanelElementLike {
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

export interface AffinityPanelPageLike {
  setViewport?(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<void>;
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForSelector?(selector: string, options?: unknown): Promise<unknown>;
  $(selector: string): Promise<AffinityPanelElementLike | null>;
  screenshot(options: { type: 'png'; clip: { x: number; y: number; width: number; height: number } }): Promise<Buffer | Uint8Array>;
  close(): Promise<void>;
}

export interface AffinityPanelPuppeteerLike {
  page(): Promise<AffinityPanelPageLike>;
}

export function resolvePanelAssetUrls(): AffinityPanelAssetUrls {
  return {
    background: pathToFileURL(join(__dirname, 'assets/panel-bg.png')).href,
    banner: pathToFileURL(join(__dirname, 'assets/panel-banner.png')).href,
    logo: pathToFileURL(join(__dirname, 'assets/panel-logo.png')).href,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseDelta(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function createEffectTokens(delta: Record<string, unknown>): AffinityPanelEffectToken[] {
  return EFFECT_ORDER.flatMap((key) => {
    const value = Number(delta[key]);
    if (!Number.isFinite(value) || Math.abs(value) < 0.05) return [];
    return [{
      name: EFFECT_LABELS[key],
      sign: value >= 0 ? '+' : '-',
    } satisfies AffinityPanelEffectToken];
  }).slice(0, 2);
}

function isEffectiveEvent(row: AffinityEventRecord): boolean {
  if (row.eventType === 'none' || row.effectTier === 'ignore') return false;
  return createEffectTokens(parseDelta(row.deltaJson)).length > 0;
}

function shanghaiDateParts(timestamp: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.get('year') ?? 1970),
    month: Number(byType.get('month') ?? 1),
    day: Number(byType.get('day') ?? 1),
  };
}

function formatDateLabel(timestamp: number): string {
  const { month, day } = shanghaiDateParts(timestamp);
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function formatPanelRelativeTime(timestamp: number | null | undefined, now: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '尚无';
  const elapsedMs = Math.max(0, now - timestamp);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return '刚刚';
  if (elapsedMinutes < 60) return `${elapsedMinutes}分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24 && getShanghaiDayKey(timestamp) === getShanghaiDayKey(now)) return `${elapsedHours}小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays <= 1 || getShanghaiDayKey(timestamp) !== getShanghaiDayKey(now - 24 * 60 * 60 * 1000)) {
    const today = shanghaiDateParts(now);
    const event = shanghaiDateParts(timestamp);
    const todayDate = Date.UTC(today.year, today.month - 1, today.day);
    const eventDate = Date.UTC(event.year, event.month - 1, event.day);
    const dayDiff = Math.round((todayDate - eventDate) / 86_400_000);
    if (dayDiff === 1) return '昨天';
    if (dayDiff > 1 && dayDiff < 7) return `${dayDiff}天前`;
  }
  return formatDateLabel(timestamp);
}

function heatLabel(value: number): string {
  if (value >= 95) return '过热';
  if (value >= 70) return '偏高';
  if (value >= 35) return '升温';
  return '平稳';
}

export function resolveAffinityPanelLineKind(state: AffinityStateInput): AffinityPanelLineKind {
  if (state.attentionHeat >= OVERHEATED_HEAT_THRESHOLD || state.tension >= OVERHEATED_TENSION_THRESHOLD) {
    return 'overheated';
  }
  return state.stage;
}

export function selectAffinityPanelLine(userKey: string, lineKind: AffinityPanelLineKind, now: number): string {
  const lines = FIXED_LINES[lineKind];
  const digest = createHash('sha256')
    .update(`${userKey}:${getShanghaiDayKey(now)}:${lineKind}`)
    .digest();
  const index = digest.readUInt32BE(0) % lines.length;
  return lines[index]!;
}

function toRecentEvent(row: AffinityEventRecord, now: number): AffinityPanelRecentEvent {
  const eventType = row.eventType;
  return {
    time: formatPanelRelativeTime(Number(row.createdAt), now),
    title: EVENT_TITLES[eventType],
    icon: EVENT_ICONS[eventType],
    effects: createEffectTokens(parseDelta(row.deltaJson)),
  };
}

export function buildAffinityPanelView(args: {
  userKey: string;
  state: AffinityStateInput;
  recentEvents: AffinityEventRecord[];
  now: number;
}): AffinityPanelView {
  const effectiveEvents = args.recentEvents
    .filter((row) => row.userKey === args.userKey && isEffectiveEvent(row))
    .sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
  const latestEventAt = Number(effectiveEvents[0]?.createdAt ?? 0) || null;
  const lineKind = resolveAffinityPanelLineKind(args.state);
  const recentEvents = effectiveEvents.slice(0, 3).reverse().map((row) => toRecentEvent(row, args.now));
  if (!recentEvents.length) {
    recentEvents.push({
      time: '现在',
      title: '尚未留下有效变化',
      icon: '◇',
      effects: [],
    });
  }

  return {
    characterId: CHARACTER_ID,
    userKey: args.userKey,
    stage: args.state.stage,
    stageName: STAGE_LABELS[args.state.stage],
    stageIcon: STAGE_ICONS[lineKind],
    lastRelationChange: formatPanelRelativeTime(latestEventAt, args.now),
    axes: [
      { name: '信赖', value: clampPercent(args.state.trust), tone: 'wine', icon: '◆' },
      { name: '熟悉', value: clampPercent(args.state.familiarity), tone: 'teal', icon: '✦' },
      { name: '安心', value: clampPercent(args.state.comfort), tone: 'blue', icon: '☾' },
      { name: '紧张', value: clampPercent(args.state.tension), tone: 'gold', icon: '!' },
    ],
    rhythm: [
      { label: '心情', value: MOOD_LABELS[args.state.mood], icon: '◇' },
      { label: '热度', value: heatLabel(args.state.attentionHeat), icon: '▲' },
      { label: '体力', value: String(clampPercent(args.state.energy)), icon: '∿' },
    ],
    recentEvents,
    adviceIcon: lineKind === 'overheated' ? '!' : '◆',
    advice: ADVICE_BY_LINE_KIND[lineKind],
    lineKind,
    fixedLine: selectAffinityPanelLine(args.userKey, lineKind, args.now),
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeStyleUrl(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n|\r/g, '');
}

function renderAxes(axes: AffinityPanelAxis[]): string {
  const colors: Record<AffinityPanelAxis['tone'], string> = {
    wine: '#bd3656',
    teal: '#58b7aa',
    blue: '#8aa9d8',
    gold: '#c9a24b',
  };
  return axes.map((axis) => {
    const value = clampPercent(axis.value);
    const color = colors[axis.tone];
    return `
      <article class="axis-line" style="--axis-level: ${value}%; --axis-color: ${color}">
        <div class="axis-head">
          <span class="axis-icon">${escapeHtml(axis.icon)}</span>
          <span class="axis-label">${escapeHtml(axis.name)}</span>
        </div>
        <div class="axis-track"><span></span></div>
        <div class="axis-value">${value}</div>
      </article>
    `;
  }).join('');
}

function renderRhythm(rhythm: AffinityPanelRhythmItem[]): string {
  return rhythm.map((item) => `
    <article class="rhythm-item">
      <div class="rhythm-label">
        <span class="rhythm-icon">${escapeHtml(item.icon)}</span>
        <span class="rhythm-name">${escapeHtml(item.label)}</span>
      </div>
      <div class="rhythm-value">${escapeHtml(item.value)}</div>
    </article>
  `).join('');
}

function renderEffects(effects: AffinityPanelEffectToken[]): string {
  return effects.map((effect, index) => {
    const token = `
      <span class="effect-token ${effect.sign === '-' ? 'is-negative' : 'is-positive'}">
        <span class="effect-name">${escapeHtml(effect.name)}</span><span class="effect-sign">${escapeHtml(effect.sign)}</span>
      </span>
    `;
    if (index === 0) return token;
    return `<span class="effect-separator">、</span>${token}`;
  }).join('');
}

function renderTimeline(events: AffinityPanelRecentEvent[]): string {
  return events.map((item) => `
    <article class="event">
      <div class="event-time">${escapeHtml(item.time)}</div>
      <div class="event-icon">${escapeHtml(item.icon)}</div>
      <div class="event-title">${escapeHtml(item.title)}</div>
      <div class="event-effect">${renderEffects(item.effects)}</div>
    </article>
  `).join('');
}

export function renderAffinityPanelHtml(
  view: AffinityPanelView,
  assets: AffinityPanelAssetUrls = resolvePanelAssetUrls(),
): string {
  const background = escapeStyleUrl(assets.background);
  const banner = escapeStyleUrl(assets.banner);
  const logo = escapeStyleUrl(assets.logo);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      --asset-bg: url("${background}");
      --asset-banner: url("${banner}");
      --asset-logo: url("${logo}");
      --ink: #fff7ec;
      --muted: #cbbfb8;
      --panel: rgba(18, 10, 14, 0.78);
      --wine: #bd3656;
      --gold: #c9a24b;
      --soft-line: rgba(255, 247, 236, 0.12);
      --gold-line: rgba(201, 162, 75, 0.34);
      --shadow: rgba(4, 2, 5, 0.64);
    }
    * { box-sizing: border-box; }
    body {
      width: ${PANEL_WIDTH}px;
      height: ${PANEL_HEIGHT}px;
      margin: 0;
      overflow: hidden;
      background: #10090d;
      color: var(--ink);
      font-family: "Noto Sans CJK SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
      letter-spacing: 0;
    }
    .panel {
      position: relative;
      width: ${PANEL_WIDTH}px;
      height: ${PANEL_HEIGHT}px;
      overflow: hidden;
      background: #12090f;
      border: 1px solid rgba(201, 162, 75, 0.44);
      box-shadow: 0 28px 72px var(--shadow);
      isolation: isolate;
    }
    .panel-bg, .banner-art, .banner-shade, .content-shade {
      position: absolute;
      pointer-events: none;
    }
    .panel-bg {
      inset: 0;
      background-image: var(--asset-bg);
      background-size: cover;
      background-position: center;
      filter: saturate(0.92) contrast(1.1);
      opacity: 0.96;
      z-index: 0;
    }
    .banner-art {
      left: 0;
      right: 0;
      top: 0;
      height: 420px;
      background-image: var(--asset-banner);
      background-size: cover;
      background-position: 57% 43%;
      filter: saturate(0.9) contrast(1.05);
      z-index: 1;
    }
    .banner-shade {
      left: 0;
      right: 0;
      top: 0;
      height: 510px;
      background:
        linear-gradient(90deg, rgba(6, 4, 7, 0.82), rgba(13, 7, 12, 0.22) 54%, rgba(9, 5, 9, 0.52)),
        linear-gradient(180deg, rgba(6, 4, 7, 0.24), rgba(9, 5, 8, 0.4) 58%, #12090f 100%);
      z-index: 2;
    }
    .content-shade {
      inset: 360px 0 0;
      background:
        radial-gradient(circle at 78% 22%, rgba(136, 170, 219, 0.16), transparent 250px),
        linear-gradient(180deg, rgba(18, 8, 14, 0), rgba(6, 4, 7, 0.82) 58%, rgba(6, 4, 7, 0.96));
      z-index: 2;
    }
    .panel::after {
      content: "";
      position: absolute;
      inset: 18px;
      border: 1px solid rgba(201, 162, 75, 0.3);
      z-index: 4;
      pointer-events: none;
    }
    .content {
      position: relative;
      z-index: 5;
      height: 100%;
      padding: 44px 68px 70px;
    }
    .topbar {
      position: relative;
      min-height: 314px;
    }
    .brand-logo {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 320px;
      height: 132px;
      background-image: var(--asset-logo);
      background-repeat: no-repeat;
      background-position: right center;
      background-size: contain;
      opacity: 0.94;
      filter:
        brightness(1.22)
        saturate(1.12)
        drop-shadow(0 8px 14px rgba(0, 0, 0, 0.36))
        drop-shadow(0 0 12px rgba(230, 32, 117, 0.42));
    }
    .stage-card {
      position: absolute;
      left: 0;
      bottom: 0;
      width: 276px;
      padding: 16px 18px 18px;
      background: rgba(10, 6, 10, 0.58);
      border: 1px solid rgba(201, 162, 75, 0.48);
      box-shadow: inset 0 0 0 1px rgba(189, 54, 86, 0.2), 0 18px 32px rgba(0, 0, 0, 0.24);
    }
    .stage-name {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--ink);
      font-size: 34px;
      font-weight: 860;
      line-height: 1.05;
    }
    .stage-icon, .axis-icon, .rhythm-icon, .event-icon, .advice-icon {
      display: inline-grid;
      place-items: center;
      flex: 0 0 auto;
      color: var(--gold);
      line-height: 1;
      text-shadow: 0 0 14px rgba(201, 162, 75, 0.32);
    }
    .stage-icon {
      width: 24px;
      height: 24px;
      font-size: 20px;
    }
    .last-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-top: 16px;
      padding-top: 14px;
      border-top: 1px solid rgba(255, 247, 236, 0.16);
      color: var(--muted);
      font-size: 17px;
    }
    .last-line strong {
      color: #fff7ec;
      font-size: 24px;
      font-weight: 820;
      white-space: nowrap;
    }
    .main-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 22px;
      margin-top: 18px;
    }
    .compact-section {
      background:
        linear-gradient(180deg, rgba(255, 247, 236, 0.07), rgba(255, 247, 236, 0.025)),
        var(--panel);
      border: 1px solid var(--soft-line);
      border-radius: 8px;
      box-shadow: 0 18px 38px rgba(0, 0, 0, 0.22);
      backdrop-filter: blur(2px);
    }
    .axis-board {
      padding: 20px 24px;
    }
    .section-title {
      margin: 0 0 18px;
      color: #fff7ec;
      font-size: 25px;
      font-weight: 820;
      line-height: 1.1;
    }
    .axis-grid {
      display: grid;
      gap: 12px;
    }
    .axis-line {
      position: relative;
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr) 48px;
      gap: 18px;
      align-items: center;
      min-height: 34px;
    }
    .axis-head, .axis-value, .axis-track {
      position: relative;
      z-index: 1;
    }
    .axis-head {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
    }
    .axis-icon {
      width: 18px;
      height: 18px;
      color: var(--axis-color);
      font-size: 15px;
    }
    .axis-label {
      color: inherit;
      font-size: 18px;
      font-weight: 680;
    }
    .axis-value {
      color: var(--ink);
      font-size: 23px;
      font-weight: 860;
      line-height: 1;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .axis-track {
      height: 10px;
      overflow: hidden;
      background: rgba(255, 247, 236, 0.16);
      border: 1px solid rgba(255, 247, 236, 0.08);
      border-radius: 999px;
    }
    .axis-track span {
      display: block;
      width: var(--axis-level, 0%);
      height: 100%;
      background: var(--axis-color);
      border-radius: inherit;
      box-shadow: 0 0 14px rgba(255, 247, 236, 0.12);
    }
    .rhythm-strip {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0;
      overflow: hidden;
    }
    .rhythm-item {
      min-height: 84px;
      padding: 16px 22px;
      border-left: 1px solid var(--soft-line);
      text-align: center;
    }
    .rhythm-item:first-child {
      border-left: 0;
    }
    .rhythm-label {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      color: var(--muted);
      font-size: 16px;
    }
    .rhythm-icon {
      width: 17px;
      height: 17px;
      font-size: 14px;
    }
    .rhythm-value {
      margin-top: 10px;
      color: var(--gold);
      font-size: 32px;
      font-weight: 850;
      line-height: 1;
    }
    .timeline-board {
      padding: 22px 24px 16px;
      background: rgba(9, 5, 8, 0.64);
      border-left: 1px solid var(--gold-line);
      border-right: 1px solid rgba(201, 162, 75, 0.16);
    }
    .timeline {
      display: grid;
      gap: 0;
    }
    .event {
      display: grid;
      grid-template-columns: 92px 22px 1fr auto;
      gap: 16px;
      align-items: baseline;
      padding: 14px 0;
      border-top: 1px solid rgba(255, 247, 236, 0.1);
    }
    .event:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .event-time {
      color: var(--gold);
      font-size: 18px;
      font-weight: 760;
    }
    .event-icon {
      align-self: center;
      width: 16px;
      height: 16px;
      color: var(--gold);
      font-size: 13px;
      opacity: 0.9;
    }
    .event-title {
      color: var(--ink);
      font-size: 23px;
      font-weight: 760;
      line-height: 1.28;
    }
    .event-effect {
      width: 168px;
      color: var(--muted);
      font-size: 17px;
      line-height: 1.32;
      display: flex;
      justify-content: flex-end;
      align-items: baseline;
      white-space: nowrap;
    }
    .effect-token {
      display: inline-grid;
      grid-template-columns: minmax(2.2em, auto) 0.8em;
      justify-items: end;
      align-items: baseline;
    }
    .effect-sign {
      width: 0.8em;
      font-family: "Noto Sans Mono CJK SC", "Cascadia Mono", "Menlo", monospace;
      font-variant-numeric: tabular-nums;
      text-align: center;
    }
    .effect-token.is-positive .effect-name, .effect-token.is-positive .effect-sign {
      color: #a9dec9;
    }
    .effect-token.is-negative .effect-name, .effect-token.is-negative .effect-sign {
      color: #e7a5ad;
    }
    .effect-separator {
      width: 1em;
      color: rgba(255, 247, 236, 0.4);
      text-align: center;
    }
    .advice {
      display: grid;
      grid-template-columns: 86px 1fr;
      gap: 18px;
      align-items: center;
      padding: 20px 24px;
      background:
        linear-gradient(90deg, rgba(189, 54, 86, 0.28), rgba(88, 183, 170, 0.08)),
        rgba(9, 5, 8, 0.72);
      border-left: 5px solid var(--wine);
      border-radius: 8px;
      box-shadow: 0 18px 38px rgba(0, 0, 0, 0.24);
    }
    .advice-label {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--gold);
      font-size: 20px;
      font-weight: 800;
    }
    .advice-icon {
      width: 17px;
      height: 17px;
      font-size: 14px;
    }
    .advice-text {
      color: var(--ink);
      font-size: 25px;
      font-weight: 780;
      line-height: 1.38;
    }
  </style>
</head>
<body>
  <main class="panel" id="affinity-panel" aria-label="关系面板">
    <div class="panel-bg"></div>
    <div class="banner-art"></div>
    <div class="banner-shade"></div>
    <div class="content-shade"></div>
    <section class="content">
      <header class="topbar">
        <div class="brand-logo" aria-hidden="true"></div>
        <div class="stage-card">
          <div class="stage-name">
            <span class="stage-icon">${escapeHtml(view.stageIcon)}</span>
            <span>${escapeHtml(view.stageName)}</span>
          </div>
          <div class="last-line">
            <span>上次变化</span>
            <strong>${escapeHtml(view.lastRelationChange)}</strong>
          </div>
        </div>
      </header>
      <div class="main-grid">
        <section class="compact-section axis-board">
          <div class="axis-grid">${renderAxes(view.axes)}</div>
        </section>
        <section class="compact-section rhythm-strip">${renderRhythm(view.rhythm)}</section>
        <section class="timeline-board">
          <h2 class="section-title">最近变化</h2>
          <div class="timeline">${renderTimeline(view.recentEvents)}</div>
        </section>
        <section class="advice">
          <div class="advice-label">
            <span class="advice-icon">${escapeHtml(view.adviceIcon)}</span>
            <span>当前</span>
          </div>
          <div class="advice-text">${escapeHtml(view.advice)}</div>
        </section>
      </div>
    </section>
  </main>
</body>
</html>`;
}

export async function renderAffinityPanelImage(
  puppeteer: AffinityPanelPuppeteerLike,
  view: AffinityPanelView,
): Promise<ReturnType<typeof h.image>> {
  const page = await puppeteer.page();
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'qqbot-affinity-panel-'));
    const htmlPath = join(tempDir, 'panel.html');
    await writeFile(htmlPath, renderAffinityPanelHtml(view), 'utf8');
    await page.setViewport?.({ width: PANEL_WIDTH, height: PANEL_HEIGHT, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    await page.waitForSelector?.('#affinity-panel', { timeout: 5000 });
    const panel = await page.$('#affinity-panel');
    if (!panel) throw new Error('affinity panel root not found');
    const box = await panel.boundingBox();
    if (!box) throw new Error('affinity panel root has no bounding box');
    const screenshot = await page.screenshot({
      type: 'png',
      clip: {
        x: Math.floor(box.x),
        y: Math.floor(box.y),
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
      },
    });
    return h.image(Buffer.from(screenshot), 'image/png');
  } finally {
    await page.close();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
