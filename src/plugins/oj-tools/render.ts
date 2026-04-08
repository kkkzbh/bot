import { createCanvas, GlobalFonts, loadImage, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import path from 'node:path';
import type { CodeforcesRatingHistory, CodeforcesRatingPoint, CodeforcesUserProfile } from './provider.js';

const DISPLAY_FONT = 'QQBotDisplay';
const UI_FONT = 'QQBotSans';
const FALLBACK_FONTS = ['Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', 'sans-serif'];
const CARD_WIDTH = 600;
const CARD_HEIGHT = 800;
const CHART_WIDTH = 1789;
const CHART_HEIGHT = 838;
const DATE_TIMEZONE = 'Asia/Shanghai';

type Theme = {
  background: string;
  panelUpper: string;
  panelLower: string;
  badge: string;
  textPrimary: string;
  textMuted: string;
  bar: string;
  star: string;
  logoBlue: string;
};

type RectSpec = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
};

type ChartPoint = {
  x: number;
  y: number;
  label: string;
  timestamp: number;
  contestName: string;
};

type TextFitOptions = {
  startSize: number;
  minSize: number;
  font: 'ui' | 'display';
  weight?: number;
};

type FittedText = {
  font: string;
  size: number;
  width: number;
  fits: boolean;
};

type LevelTextLine = {
  text: string;
  font: string;
  size: number;
  width: number;
  y: number;
};

type LevelTextLayout = {
  mode: 'single' | 'split';
  lines: LevelTextLine[];
};

type Point = {
  x: number;
  y: number;
};

export interface RenderedArtifact {
  buffer: Buffer;
  alt: string;
}

const PROFILE_CARD_SPEC = {
  width: CARD_WIDTH,
  height: CARD_HEIGHT,
  logo: {
    x: 392,
    y: 16,
    barWidth: 8,
    barGap: 4,
    barHeights: [26, 36, 22] as const,
    codeOffsetX: 39,
    forcesGap: 0,
    textY: 16,
    fontSize: 23,
  },
  panels: {
    upper: { x: 22, y: 181, width: 556, height: 220, radius: 22 },
    lower: { x: 22, y: 428, width: 556, height: 320, radius: 22 },
    shadow: {
      color: 'rgba(63, 72, 90, 0.22)',
      blur: 18,
      offsetY: 6,
    },
  },
  avatar: { x: 190, y: 56, width: 220, height: 220, radius: 42 },
  name: {
    x: 300,
    y: 301,
    maxWidth: 418,
    startSize: 54,
    minSize: 34,
  },
  badges: {
    left: { x: 48, y: 343, width: 238, height: 48, radius: 18 },
    right: { x: 314, y: 343, width: 242, height: 48, radius: 18 },
    iconSquare: { x: 14, y: 12, size: 26, radius: 6 },
    labelOffsetX: 52,
    fontSize: 20,
  },
  leftColumn: {
    labelX: 48,
    ratingLabelY: 486,
    levelLabelY: 624,
    labelSize: 28,
    ratingValueX: 63,
    ratingValueSize: 82,
    ratingValueCorrectionY: 5,
    levelValueX: 48,
    levelValueSingleY: 674,
    levelValueMultiFirstY: 662,
    levelValueLineGap: 36,
    levelValueStartSize: 76,
    levelValueMinSize: 44,
    levelValueMultiStartSize: 40,
    levelValueMultiMinSize: 30,
    levelValueMaxWidth: 228,
  },
  rightColumn: {
    titleX: 423,
    titleY: 472,
    titleSize: 25,
    rowStartY: 533,
    rowGap: 58,
    labelX: 307,
    labelSize: 25,
    barX: 321,
    barYOffset: 15,
    barHeight: 9,
    barRadius: 5,
    percentX: 548,
  },
  timestamp: {
    x: 2,
    y: 795,
    size: 13,
  },
} as const;

const RATING_CHART_SPEC = {
  width: CHART_WIDTH,
  height: CHART_HEIGHT,
  title: {
    x: CHART_WIDTH / 2,
    y: 34,
    size: 56,
  },
  subtitle: {
    x: CHART_WIDTH / 2,
    y: 92,
    size: 33,
  },
  summary: {
    x: CHART_WIDTH / 2,
    y: 132,
    size: 27,
  },
  plot: {
    outer: { x: 64, y: 132, width: 1663, height: 592, radius: 0 },
    innerLeft: 140,
    innerRight: 1645,
    topTickY: 159,
    midTickY: 444,
    bottomTickY: 697,
    baselineY: 725,
  },
  yLabels: {
    x: 58,
    size: 22,
  },
  xLabels: {
    y: 735,
    size: 18,
  },
  point: {
    radius: 6,
    labelSize: 22,
    labelOffsetX: -36,
    labelOffsetY: -6,
  },
  colors: {
    background: '#FFFFFF',
    plotBackground: '#E9EEF5',
    grid: '#D0D8E6',
    axis: '#95A3BA',
    line: '#4D73F0',
    title: '#1F2937',
    secondaryText: '#8E99AC',
    pointLabel: '#5F697A',
  },
} as const;

const THEMES: Array<{ upperExclusive: number; palette: Theme }> = [
  {
    upperExclusive: 1200,
    palette: {
      background: '#ACB4C3',
      panelUpper: '#7F889A',
      panelLower: '#7A8394',
      badge: '#5D6778',
      textPrimary: '#FFFFFF',
      textMuted: '#EEF2F7',
      bar: '#FAFBFB',
      star: '#FFC65A',
      logoBlue: '#2E5BFF',
    },
  },
  {
    upperExclusive: 1400,
    palette: {
      background: '#A9B99D',
      panelUpper: '#7D8F72',
      panelLower: '#78886E',
      badge: '#616F58',
      textPrimary: '#FFFFFF',
      textMuted: '#EEF4EA',
      bar: '#FCFDF9',
      star: '#FFC65A',
      logoBlue: '#56A8FF',
    },
  },
  {
    upperExclusive: 1600,
    palette: {
      background: '#A0B8BB',
      panelUpper: '#7B9499',
      panelLower: '#748E93',
      badge: '#5B757B',
      textPrimary: '#FFFFFF',
      textMuted: '#EDF5F6',
      bar: '#FAFDFC',
      star: '#FFC65A',
      logoBlue: '#4B99FF',
    },
  },
  {
    upperExclusive: 1800,
    palette: {
      background: '#A0AECB',
      panelUpper: '#7F90B0',
      panelLower: '#7889AA',
      badge: '#607291',
      textPrimary: '#FFFFFF',
      textMuted: '#F0F3FB',
      bar: '#FBFCFE',
      star: '#FFC65A',
      logoBlue: '#3C76FF',
    },
  },
  {
    upperExclusive: 2000,
    palette: {
      background: '#AAA3C8',
      panelUpper: '#867EAC',
      panelLower: '#8078A3',
      badge: '#675F86',
      textPrimary: '#FFFFFF',
      textMuted: '#F4F0FB',
      bar: '#FDFCFF',
      star: '#FFC65A',
      logoBlue: '#4B67FF',
    },
  },
];

const HIGH_RATING_THEME = {
  background: '#C7B0A8',
  panelUpper: '#A08278',
  panelLower: '#987970',
  badge: '#7F655D',
  textPrimary: '#FFFFFF',
  textMuted: '#F9F1EE',
  bar: '#FFFCFB',
  star: '#FFC65A',
  logoBlue: '#C44536',
} as const satisfies Theme;

let fontsRegistered = false;

function registerFonts(): void {
  if (fontsRegistered) return;
  const candidates = [
    { path: '/usr/share/fonts/windows/msyh.ttc', family: UI_FONT },
    { path: '/usr/share/fonts/windows/ARLRDBD.TTF', family: DISPLAY_FONT },
    { path: path.resolve(process.cwd(), 'zpix.ttf'), family: 'Zpix' },
  ];

  for (const candidate of candidates) {
    try {
      GlobalFonts.registerFromPath(candidate.path, candidate.family);
    } catch {}
  }
  fontsRegistered = true;
}

function fontFamily(primary: string): string {
  return [primary, ...FALLBACK_FONTS].join(', ');
}

function uiFont(size: number, weight = 600): string {
  return `${weight} ${size}px ${fontFamily(UI_FONT)}`;
}

function displayFont(size: number, weight = 700): string {
  return `${weight} ${size}px ${fontFamily(DISPLAY_FONT)}`;
}

function fillRoundRect(ctx: SKRSContext2D, rect: RectSpec, fillStyle: string): void {
  const { x, y, width, height, radius } = rect;
  const r = Math.min(radius, width / 2, height / 2);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.restore();
}

function applyShadow(ctx: SKRSContext2D, color: string, blur: number, offsetY: number): void {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = offsetY;
}

function pickTheme(rating: number | null): Theme {
  const value = rating ?? 0;
  return THEMES.find((item) => value < item.upperExclusive)?.palette ?? HIGH_RATING_THEME;
}

function fitText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  options: TextFitOptions,
): string {
  return fitTextWithin(ctx, text, maxWidth, options).font;
}

function fitTextWithin(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  options: TextFitOptions,
): FittedText {
  let size = options.startSize;
  let lastFont = options.font === 'display'
    ? displayFont(options.minSize, options.weight ?? 700)
    : uiFont(options.minSize, options.weight ?? 700);
  let lastWidth = Number.POSITIVE_INFINITY;

  while (size >= options.minSize) {
    const font = options.font === 'display'
      ? displayFont(size, options.weight ?? 700)
      : uiFont(size, options.weight ?? 700);
    ctx.font = font;
    const width = ctx.measureText(text).width;
    if (width <= maxWidth) return { font, size, width, fits: true };
    lastFont = font;
    lastWidth = width;
    size -= 2;
  }

  ctx.font = lastFont;
  return {
    font: lastFont,
    size: options.minSize,
    width: lastWidth,
    fits: lastWidth <= maxWidth,
  };
}

function measureTextCenterOffset(ctx: SKRSContext2D, text: string): number {
  const metrics = ctx.measureText(text);
  return (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
}

function formatRating(value: number | null): string {
  return value == null ? 'Unrated' : String(value);
}

function formatRank(rank: string): string {
  const normalized = rank.trim();
  if (!normalized) return 'Unrated';
  return normalized
    .split(/\s+/)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function timestampText(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function formatChartDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: DATE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

function bucketBarWidth(percent: number): number {
  if (percent <= 0) return 14;
  if (percent < 10) return 28;
  return 96;
}

async function loadAvatar(avatarUrl: string | null): Promise<Awaited<ReturnType<typeof loadImage>> | null> {
  if (!avatarUrl) return null;
  try {
    const response = await fetch(avatarUrl);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return await loadImage(buffer);
  } catch {
    return null;
  }
}

function drawCodeforcesLogo(ctx: SKRSContext2D, theme: Theme): void {
  const spec = PROFILE_CARD_SPEC.logo;
  const bars = [
    { color: '#F5C43A', height: spec.barHeights[0], dx: 0 },
    { color: '#3C8DFF', height: spec.barHeights[1], dx: spec.barWidth + spec.barGap },
    { color: '#FF6E6E', height: spec.barHeights[2], dx: (spec.barWidth + spec.barGap) * 2 },
  ] as const;

  bars.forEach((bar) => {
    fillRoundRect(ctx, {
      x: spec.x + bar.dx,
      y: spec.y + (spec.barHeights[1] - bar.height),
      width: spec.barWidth,
      height: bar.height,
      radius: 4,
    }, bar.color);
  });

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = uiFont(spec.fontSize + 1, 700);
  ctx.fillStyle = '#FFFFFF';
  const textX = spec.x + spec.codeOffsetX;
  const textY = spec.y + spec.textY;
  ctx.fillText('Code', textX, textY);
  const codeWidth = ctx.measureText('Code').width;
  ctx.fillStyle = theme.logoBlue;
  ctx.fillText('Forces', textX + codeWidth + spec.forcesGap, textY);
}

function drawAvatar(ctx: SKRSContext2D, avatar: Awaited<ReturnType<typeof loadImage>> | null): void {
  const spec = PROFILE_CARD_SPEC.avatar;
  fillRoundRect(ctx, spec, '#FFFFFF');
  if (!avatar) {
    ctx.fillStyle = 'rgba(48, 61, 82, 0.18)';
    ctx.font = displayFont(64, 700);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CF', spec.x + spec.width / 2, spec.y + spec.height / 2 + 4);
    return;
  }

  ctx.save();
  ctx.beginPath();
  const radius = spec.radius;
  ctx.moveTo(spec.x + radius, spec.y);
  ctx.arcTo(spec.x + spec.width, spec.y, spec.x + spec.width, spec.y + spec.height, radius);
  ctx.arcTo(spec.x + spec.width, spec.y + spec.height, spec.x, spec.y + spec.height, radius);
  ctx.arcTo(spec.x, spec.y + spec.height, spec.x, spec.y, radius);
  ctx.arcTo(spec.x, spec.y, spec.x + spec.width, spec.y, radius);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(avatar, spec.x, spec.y, spec.width, spec.height);
  ctx.restore();
}

function drawRatingBadgeIcon(ctx: SKRSContext2D, x: number, y: number): void {
  const square = PROFILE_CARD_SPEC.badges.iconSquare;
  fillRoundRect(ctx, {
    x: x + square.x,
    y: y + square.y,
    width: square.size,
    height: square.size,
    radius: square.radius,
  }, '#2457DA');

  ctx.beginPath();
  ctx.moveTo(x + square.x + 6, y + square.y + 18);
  ctx.lineTo(x + square.x + 10, y + square.y + 13);
  ctx.lineTo(x + square.x + 15, y + square.y + 16);
  ctx.lineTo(x + square.x + 21, y + square.y + 9);
  ctx.lineTo(x + square.x + 21, y + square.y + 21);
  ctx.lineTo(x + square.x + 6, y + square.y + 21);
  ctx.closePath();
  ctx.fillStyle = '#48D2FF';
  ctx.fill();
}

function drawStarBadgeIcon(ctx: SKRSContext2D, x: number, y: number, theme: Theme): void {
  const square = PROFILE_CARD_SPEC.badges.iconSquare;
  const centerX = x + square.x + square.size / 2;
  const centerY = y + square.y + square.size / 2;
  const points = createStarPolygonPoints(centerX, centerY, 10.5, 4.6);

  ctx.fillStyle = theme.star;
  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  points.slice(1).forEach((point) => {
    ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
  ctx.fill();
}

function createStarPolygonPoints(
  centerX: number,
  centerY: number,
  outerRadius: number,
  innerRadius: number,
  spikes = 5,
): Point[] {
  const points: Point[] = [];
  const step = Math.PI / spikes;
  let angle = -Math.PI / 2;

  for (let index = 0; index < spikes * 2; index += 1) {
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    points.push({
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    });
    angle += step;
  }

  return points;
}

function layoutLevelText(ctx: SKRSContext2D, rank: string): LevelTextLayout {
  const level = formatRank(rank);
  const words = level.split(/\s+/).filter(Boolean);
  const singleLine = fitTextWithin(ctx, level, PROFILE_CARD_SPEC.leftColumn.levelValueMaxWidth, {
    startSize: PROFILE_CARD_SPEC.leftColumn.levelValueStartSize,
    minSize: PROFILE_CARD_SPEC.leftColumn.levelValueMinSize,
    font: 'display',
    weight: 700,
  });

  if (words.length !== 2 || singleLine.fits) {
    return {
      mode: 'single',
      lines: [{
        text: level,
        font: singleLine.font,
        size: singleLine.size,
        width: singleLine.width,
        y: PROFILE_CARD_SPEC.leftColumn.levelValueSingleY,
      }],
    };
  }

  return {
    mode: 'split',
    lines: words.map((word, index) => {
      const fitted = fitTextWithin(ctx, word, PROFILE_CARD_SPEC.leftColumn.levelValueMaxWidth, {
        startSize: PROFILE_CARD_SPEC.leftColumn.levelValueMultiStartSize,
        minSize: PROFILE_CARD_SPEC.leftColumn.levelValueMultiMinSize,
        font: 'display',
        weight: 700,
      });
      return {
        text: word,
        font: fitted.font,
        size: fitted.size,
        width: fitted.width,
        y: PROFILE_CARD_SPEC.leftColumn.levelValueMultiFirstY + PROFILE_CARD_SPEC.leftColumn.levelValueLineGap * index,
      };
    }),
  };
}

function drawBadge(ctx: SKRSContext2D, rect: RectSpec, label: string, kind: 'rating' | 'star', theme: Theme): void {
  fillRoundRect(ctx, rect, theme.badge);
  if (kind === 'rating') {
    drawRatingBadgeIcon(ctx, rect.x, rect.y);
  } else {
    drawStarBadgeIcon(ctx, rect.x, rect.y, theme);
  }

  ctx.fillStyle = theme.textPrimary;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = uiFont(PROFILE_CARD_SPEC.badges.fontSize, 700);
  ctx.fillText(label, rect.x + PROFILE_CARD_SPEC.badges.labelOffsetX, rect.y + rect.height / 2);
}

function renderPanels(ctx: SKRSContext2D, theme: Theme): void {
  ctx.save();
  applyShadow(
    ctx,
    PROFILE_CARD_SPEC.panels.shadow.color,
    PROFILE_CARD_SPEC.panels.shadow.blur,
    PROFILE_CARD_SPEC.panels.shadow.offsetY,
  );
  fillRoundRect(ctx, PROFILE_CARD_SPEC.panels.upper, theme.panelUpper);
  fillRoundRect(ctx, PROFILE_CARD_SPEC.panels.lower, theme.panelLower);
  ctx.restore();
}

function renderProfileCardText(ctx: SKRSContext2D, profile: CodeforcesUserProfile, theme: Theme): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.textPrimary;
  ctx.font = fitText(ctx, profile.displayName, PROFILE_CARD_SPEC.name.maxWidth, {
    startSize: PROFILE_CARD_SPEC.name.startSize,
    minSize: PROFILE_CARD_SPEC.name.minSize,
    font: 'display',
    weight: 700,
  });
  ctx.fillText(profile.displayName, PROFILE_CARD_SPEC.name.x, PROFILE_CARD_SPEC.name.y);

  drawBadge(ctx, PROFILE_CARD_SPEC.badges.left, `MaxRating ${formatRating(profile.maxRating)}`, 'rating', theme);
  drawBadge(ctx, PROFILE_CARD_SPEC.badges.right, `${profile.stars} stars`, 'star', theme);

  ctx.textAlign = 'left';
  ctx.fillStyle = theme.textPrimary;
  ctx.font = uiFont(PROFILE_CARD_SPEC.leftColumn.labelSize, 700);
  ctx.fillText('Rating', PROFILE_CARD_SPEC.leftColumn.labelX, PROFILE_CARD_SPEC.leftColumn.ratingLabelY);
  ctx.fillText('Level', PROFILE_CARD_SPEC.leftColumn.labelX, PROFILE_CARD_SPEC.leftColumn.levelLabelY);

  const ratingText = formatRating(profile.rating);
  ctx.font = displayFont(PROFILE_CARD_SPEC.leftColumn.ratingValueSize, 700);
  const ratingCenter = PROFILE_CARD_SPEC.leftColumn.ratingLabelY + measureTextCenterOffset(ctx, 'Rating');
  const levelCenter = PROFILE_CARD_SPEC.leftColumn.levelLabelY + measureTextCenterOffset(ctx, 'Level');
  const targetCenter = (ratingCenter + levelCenter) / 2;
  const valueOffset = measureTextCenterOffset(ctx, ratingText);
  ctx.fillText(
    ratingText,
    PROFILE_CARD_SPEC.leftColumn.ratingValueX,
    targetCenter - valueOffset + PROFILE_CARD_SPEC.leftColumn.ratingValueCorrectionY,
  );

  const levelLayout = layoutLevelText(ctx, profile.rank);
  levelLayout.lines.forEach((line) => {
    ctx.font = line.font;
    ctx.fillText(line.text, PROFILE_CARD_SPEC.leftColumn.levelValueX, line.y);
  });

  ctx.textAlign = 'center';
  ctx.font = uiFont(PROFILE_CARD_SPEC.rightColumn.titleSize, 700);
  ctx.fillText(`solved ${profile.solvedTotal} problems`, PROFILE_CARD_SPEC.rightColumn.titleX, PROFILE_CARD_SPEC.rightColumn.titleY);

  profile.solvedBuckets.forEach((bucket, index) => {
    const rowY = PROFILE_CARD_SPEC.rightColumn.rowStartY + PROFILE_CARD_SPEC.rightColumn.rowGap * index;
    ctx.textAlign = 'left';
    ctx.font = uiFont(PROFILE_CARD_SPEC.rightColumn.labelSize, 700);
    ctx.fillText(bucket.label, PROFILE_CARD_SPEC.rightColumn.labelX, rowY);

    fillRoundRect(ctx, {
      x: PROFILE_CARD_SPEC.rightColumn.barX,
      y: rowY + PROFILE_CARD_SPEC.rightColumn.barYOffset,
      width: bucketBarWidth(bucket.solvedPercent),
      height: PROFILE_CARD_SPEC.rightColumn.barHeight,
      radius: PROFILE_CARD_SPEC.rightColumn.barRadius,
    }, theme.bar);

    ctx.textAlign = 'right';
    ctx.fillText(formatPercent(bucket.solvedPercent), PROFILE_CARD_SPEC.rightColumn.percentX, rowY);
  });

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = theme.textMuted;
  ctx.font = uiFont(PROFILE_CARD_SPEC.timestamp.size, 600);
  ctx.fillText(timestampText(), PROFILE_CARD_SPEC.timestamp.x, PROFILE_CARD_SPEC.timestamp.y);
}

function scaleX(width: number, x: number): number {
  return (x / RATING_CHART_SPEC.width) * width;
}

function scaleY(height: number, y: number): number {
  return (y / RATING_CHART_SPEC.height) * height;
}

function scaleSize(width: number, height: number, size: number): number {
  const ratio = Math.min(width / RATING_CHART_SPEC.width, height / RATING_CHART_SPEC.height);
  return Math.max(12, Math.round(size * ratio));
}

function drawChartBackground(ctx: SKRSContext2D, width: number, height: number): void {
  ctx.fillStyle = RATING_CHART_SPEC.colors.background;
  ctx.fillRect(0, 0, width, height);

  const outer = RATING_CHART_SPEC.plot.outer;
  fillRoundRect(ctx, {
    x: scaleX(width, outer.x),
    y: scaleY(height, outer.y),
    width: scaleX(width, outer.width),
    height: scaleY(height, outer.height),
    radius: 0,
  }, RATING_CHART_SPEC.colors.plotBackground);
}

function getChartScaleAnchors(points: CodeforcesRatingPoint[]): {
  min: number;
  mid: number;
  max: number;
} {
  if (!points.length) {
    return { min: 0, mid: 1, max: 2 };
  }
  const values = points.map((point) => point.newRating).sort((a, b) => a - b);
  const min = values[0]!;
  const max = values.at(-1)!;
  const mid = values[Math.floor(values.length / 2)] ?? min;
  if (min === max) {
    return { min: min - 100, mid: min, max: min + 100 };
  }
  if (mid === min) {
    return { min, mid: Math.round((min + max) / 2), max };
  }
  if (mid === max) {
    return { min, mid: Math.round((min + max) / 2), max };
  }
  return { min, mid, max };
}

function mapRatingToY(height: number, value: number, anchors: { min: number; mid: number; max: number }): number {
  const top = scaleY(height, RATING_CHART_SPEC.plot.topTickY);
  const mid = scaleY(height, RATING_CHART_SPEC.plot.midTickY);
  const bottom = scaleY(height, RATING_CHART_SPEC.plot.bottomTickY);

  if (value <= anchors.mid) {
    const span = Math.max(1, anchors.mid - anchors.min);
    const ratio = (value - anchors.min) / span;
    return bottom - ratio * (bottom - mid);
  }

  const span = Math.max(1, anchors.max - anchors.mid);
  const ratio = (value - anchors.mid) / span;
  return mid - ratio * (mid - top);
}

function mapPoints(width: number, height: number, points: CodeforcesRatingPoint[]): ChartPoint[] {
  if (!points.length) return [];
  const left = scaleX(width, RATING_CHART_SPEC.plot.innerLeft);
  const right = scaleX(width, RATING_CHART_SPEC.plot.innerRight);
  const anchors = getChartScaleAnchors(points);
  return points.map((point, index) => {
    const x = points.length === 1
      ? (left + right) / 2
      : left + ((right - left) * index) / (points.length - 1);
    return {
      x,
      y: mapRatingToY(height, point.newRating, anchors),
      label: String(point.newRating),
      timestamp: point.timestamp,
      contestName: point.contestName,
    };
  });
}

function drawChartHeader(ctx: SKRSContext2D, width: number, height: number, history: CodeforcesRatingHistory): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = RATING_CHART_SPEC.colors.title;
  ctx.font = displayFont(scaleSize(width, height, RATING_CHART_SPEC.title.size), 700);
  ctx.fillText(history.displayName, scaleX(width, RATING_CHART_SPEC.title.x), scaleY(height, RATING_CHART_SPEC.title.y));

  ctx.fillStyle = RATING_CHART_SPEC.colors.secondaryText;
  ctx.font = uiFont(scaleSize(width, height, RATING_CHART_SPEC.subtitle.size), 500);
  ctx.fillText('Codeforces Rating History', scaleX(width, RATING_CHART_SPEC.subtitle.x), scaleY(height, RATING_CHART_SPEC.subtitle.y));

  ctx.font = uiFont(scaleSize(width, height, RATING_CHART_SPEC.summary.size), 500);
  ctx.fillText(
    `Current ${formatRating(history.currentRating)}    Peak ${formatRating(history.maxRating)}    Contests ${history.points.length}`,
    scaleX(width, RATING_CHART_SPEC.summary.x),
    scaleY(height, RATING_CHART_SPEC.summary.y),
  );
}

function drawChartAxes(ctx: SKRSContext2D, width: number, height: number, anchors: { min: number; mid: number; max: number }): void {
  const ticks = [
    { y: RATING_CHART_SPEC.plot.topTickY, label: String(anchors.max) },
    { y: RATING_CHART_SPEC.plot.midTickY, label: String(anchors.mid) },
    { y: RATING_CHART_SPEC.plot.bottomTickY, label: String(anchors.min) },
  ];
  const left = scaleX(width, RATING_CHART_SPEC.plot.outer.x);
  const right = scaleX(width, RATING_CHART_SPEC.plot.outer.x + RATING_CHART_SPEC.plot.outer.width);

  ctx.strokeStyle = RATING_CHART_SPEC.colors.grid;
  ctx.lineWidth = 2;
  ticks.forEach((tick, index) => {
    const y = scaleY(height, tick.y);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();

    ctx.textAlign = 'right';
    ctx.textBaseline = index === ticks.length - 1 ? 'middle' : 'middle';
    ctx.fillStyle = RATING_CHART_SPEC.colors.secondaryText;
    ctx.font = uiFont(scaleSize(width, height, RATING_CHART_SPEC.yLabels.size), 500);
    ctx.fillText(tick.label, scaleX(width, RATING_CHART_SPEC.yLabels.x), y);
  });

  ctx.strokeStyle = RATING_CHART_SPEC.colors.axis;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(left, scaleY(height, RATING_CHART_SPEC.plot.baselineY));
  ctx.lineTo(right, scaleY(height, RATING_CHART_SPEC.plot.baselineY));
  ctx.stroke();
}

function drawChartSeries(ctx: SKRSContext2D, width: number, height: number, points: ChartPoint[]): void {
  if (!points.length) return;

  ctx.strokeStyle = RATING_CHART_SPEC.colors.line;
  ctx.lineWidth = 5;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();

  points.forEach((point, index) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, RATING_CHART_SPEC.point.radius, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.strokeStyle = RATING_CHART_SPEC.colors.line;
    ctx.lineWidth = 5;
    ctx.stroke();

    ctx.fillStyle = RATING_CHART_SPEC.colors.pointLabel;
    ctx.font = uiFont(scaleSize(width, height, RATING_CHART_SPEC.point.labelSize), 500);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const offsetX = scaleX(width, RATING_CHART_SPEC.point.labelOffsetX);
    const offsetY = scaleY(height, RATING_CHART_SPEC.point.labelOffsetY);
    ctx.fillText(point.label, point.x + offsetX, point.y + offsetY);

    ctx.fillStyle = RATING_CHART_SPEC.colors.secondaryText;
    ctx.font = uiFont(scaleSize(width, height, RATING_CHART_SPEC.xLabels.size), 500);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    if (points.length <= 8 || index % Math.ceil(points.length / 6) === 0 || index === points.length - 1) {
      ctx.fillText(formatChartDate(point.timestamp), point.x, scaleY(height, RATING_CHART_SPEC.xLabels.y));
    }
  });
}

export async function renderCodeforcesProfileCard(profile: CodeforcesUserProfile): Promise<RenderedArtifact> {
  registerFonts();
  const canvas = createCanvas(PROFILE_CARD_SPEC.width, PROFILE_CARD_SPEC.height);
  const ctx = canvas.getContext('2d');
  const theme = pickTheme(profile.rating);
  const avatar = await loadAvatar(profile.avatarUrl);

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, PROFILE_CARD_SPEC.width, PROFILE_CARD_SPEC.height);

  drawCodeforcesLogo(ctx, theme);
  renderPanels(ctx, theme);
  drawAvatar(ctx, avatar);
  renderProfileCardText(ctx, profile, theme);

  return {
    buffer: await canvas.encode('png'),
    alt: `${profile.handle} 的 Codeforces 分数卡`,
  };
}

export async function renderCodeforcesRatingChart(
  history: CodeforcesRatingHistory,
  options: { width: number; height: number },
): Promise<RenderedArtifact> {
  registerFonts();
  const width = Math.max(900, Math.floor(options.width));
  const height = Math.max(420, Math.floor(options.height));
  const canvas: Canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  drawChartBackground(ctx, width, height);
  drawChartHeader(ctx, width, height, history);

  const sourcePoints = history.points.length > 0
    ? history.points
    : [{
        contestId: 0,
        contestName: 'No Contests',
        rank: 0,
        oldRating: history.currentRating ?? 0,
        newRating: history.currentRating ?? 0,
        timestamp: Math.floor(Date.now() / 1000),
      }];
  const anchors = getChartScaleAnchors(sourcePoints);
  drawChartAxes(ctx, width, height, anchors);
  drawChartSeries(ctx, width, height, mapPoints(width, height, sourcePoints));

  return {
    buffer: await canvas.encode('png'),
    alt: `${history.handle} 的 Codeforces rating 历史图`,
  };
}

export const __testables = {
  createStarPolygonPoints,
  drawStarBadgeIcon,
  layoutLevelText,
  registerFonts,
};
