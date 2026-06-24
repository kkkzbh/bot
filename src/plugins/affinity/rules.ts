import type {
  AffinityEffectTier,
  AffinityEventType,
  AffinityMood,
  AffinityRandomDirection,
  AffinityStage,
  AffinityUserStateRecord,
} from '../../types/affinity.js';

export const CHARACTER_ID = 'sakiko' as const;
export const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_RANDOM_COUNT_WEIGHTS = [0.25, 0.6, 0.1, 0.05] as const satisfies readonly [number, number, number, number];
export const DEFAULT_RANDOM_DIRECTIONS = [
  'local_thread',
  'daily_greeting',
  'music_rehearsal',
  'contest_discussion',
  'computer_knowledge',
  'relationship_scene',
] as const satisfies readonly AffinityRandomDirection[];

export interface AffinityAxes {
  trust: number;
  familiarity: number;
  comfort: number;
  tension: number;
}

export interface DailyAffinityState {
  dayKey: string;
  meaningfulActionCount: number;
  categoryCounts: Record<string, number>;
  lastActionAt: number | null;
}

export interface WeeklyAffinityState {
  weekKey: string;
  categoryCounts: Record<string, number>;
}

export interface AffinityEventAnalysis {
  route: string;
  eventType: AffinityEventType;
  effectTier: AffinityEffectTier;
  category: string;
  confidence: number;
  evidence: string | null;
  replyHint: string | null;
  risk: 'none' | 'low' | 'medium' | 'high';
  reasonCode: string;
}

export interface AffinityStateInput {
  trust: number;
  familiarity: number;
  comfort: number;
  tension: number;
  mood: AffinityMood;
  attentionHeat: number;
  energy: number;
  stage: AffinityStage;
  dailyState: DailyAffinityState;
  weeklyState: WeeklyAffinityState;
  lastUpdatedAt: number;
}

export interface AffinityStatePatch {
  trust: number;
  familiarity: number;
  comfort: number;
  tension: number;
  mood: AffinityMood;
  attentionHeat: number;
  energy: number;
  stage: AffinityStage;
  dailyState: DailyAffinityState;
  weeklyState: WeeklyAffinityState;
  lastUpdatedAt: number;
}

export interface AffinityResolution {
  accepted: boolean;
  effectTier: AffinityEffectTier;
  reasonCode: string;
  delta: Partial<AffinityAxes> & { attentionHeat?: number; energy?: number };
  before: AffinityStateInput;
  after: AffinityStatePatch;
  visibleFeedback: 'none' | 'subtle_positive' | 'positive' | 'guarded' | 'negative';
}

export const STAGE_LABELS: Record<AffinityStage, string> = {
  stranger: '初识',
  polite: '礼貌往来',
  remembered: '被记住的人',
  trusted: '可以托付',
  special: '特别信赖',
};

const STAGE_SOFT_CAPS: Record<AffinityStage, AffinityAxes> = {
  stranger: { trust: 20, familiarity: 24, comfort: 18, tension: 30 },
  polite: { trust: 45, familiarity: 48, comfort: 42, tension: 34 },
  remembered: { trust: 70, familiarity: 72, comfort: 68, tension: 38 },
  trusted: { trust: 90, familiarity: 88, comfort: 88, tension: 42 },
  special: { trust: 100, familiarity: 100, comfort: 100, tension: 45 },
};

const STAGE_LOSS_FACTOR: Record<AffinityStage, number> = {
  stranger: 0.7,
  polite: 0.9,
  remembered: 1.1,
  trusted: 1.35,
  special: 1.6,
};

const STAGE_ORDER: AffinityStage[] = ['stranger', 'polite', 'remembered', 'trusted', 'special'];

const EVENT_DEFS: Record<AffinityEventType, {
  category: string;
  base: Partial<AffinityAxes>;
  attentionHeat: number;
  mood: AffinityMood;
  primaryStages: AffinityStage[];
  validStages: AffinityStage[];
  negative?: boolean;
}> = {
  none: {
    category: 'none',
    base: {},
    attentionHeat: 0,
    mood: 'neutral',
    primaryStages: STAGE_ORDER,
    validStages: STAGE_ORDER,
  },
  greeting_contextual: {
    category: 'greeting',
    base: { familiarity: 1, comfort: 0.5 },
    attentionHeat: 8,
    mood: 'calm',
    primaryStages: ['stranger', 'polite'],
    validStages: STAGE_ORDER,
  },
  offer_tea: {
    category: 'tea',
    base: { familiarity: 1, comfort: 2 },
    attentionHeat: 15,
    mood: 'pleased',
    primaryStages: ['polite'],
    validStages: ['stranger', 'polite', 'remembered'],
  },
  music_help: {
    category: 'music',
    base: { trust: 3, familiarity: 1, comfort: 1 },
    attentionHeat: 10,
    mood: 'focused',
    primaryStages: ['polite', 'remembered'],
    validStages: ['stranger', 'polite', 'remembered', 'trusted'],
  },
  care_subtle: {
    category: 'care',
    base: { comfort: 2, trust: 1 },
    attentionHeat: 10,
    mood: 'calm',
    primaryStages: ['polite', 'remembered', 'trusted'],
    validStages: STAGE_ORDER,
  },
  keep_promise: {
    category: 'promise',
    base: { trust: 7, comfort: 2 },
    attentionHeat: 6,
    mood: 'pleased',
    primaryStages: ['remembered', 'trusted'],
    validStages: ['polite', 'remembered', 'trusted', 'special'],
  },
  boundary_respect: {
    category: 'boundary',
    base: { trust: 3, comfort: 4, tension: -2 },
    attentionHeat: -8,
    mood: 'calm',
    primaryStages: ['remembered', 'trusted', 'special'],
    validStages: STAGE_ORDER,
  },
  light_tease: {
    category: 'tease',
    base: { familiarity: 2, tension: 0.5 },
    attentionHeat: 15,
    mood: 'embarrassed',
    primaryStages: ['remembered'],
    validStages: ['polite', 'remembered', 'trusted'],
  },
  contest_discussion: {
    category: 'contest',
    base: { familiarity: 1.5, trust: 1.5 },
    attentionHeat: 8,
    mood: 'focused',
    primaryStages: ['polite', 'remembered'],
    validStages: STAGE_ORDER,
  },
  computer_knowledge: {
    category: 'computer',
    base: { familiarity: 1, trust: 1 },
    attentionHeat: 8,
    mood: 'focused',
    primaryStages: ['stranger', 'polite'],
    validStages: STAGE_ORDER,
  },
  answer_random_prompt: {
    category: 'random_reply',
    base: { trust: 5, familiarity: 3, comfort: 2 },
    attentionHeat: 8,
    mood: 'pleased',
    primaryStages: STAGE_ORDER,
    validStages: STAGE_ORDER,
  },
  over_interaction: {
    category: 'pressure',
    base: { comfort: -1, tension: 2 },
    attentionHeat: 35,
    mood: 'guarded',
    primaryStages: STAGE_ORDER,
    validStages: STAGE_ORDER,
    negative: true,
  },
  pressure_or_spam: {
    category: 'pressure',
    base: { trust: -1, comfort: -2, tension: 4 },
    attentionHeat: 40,
    mood: 'guarded',
    primaryStages: STAGE_ORDER,
    validStages: STAGE_ORDER,
    negative: true,
  },
  promise_broken: {
    category: 'promise',
    base: { trust: -7, comfort: -2, tension: 4 },
    attentionHeat: 8,
    mood: 'guarded',
    primaryStages: STAGE_ORDER,
    validStages: STAGE_ORDER,
    negative: true,
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function getShanghaiDayKey(now: number): string {
  return new Date(now + SHANGHAI_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

export function getShanghaiWeekKey(now: number): string {
  const dayStart = getShanghaiDayStartMs(now);
  const day = new Date(dayStart + SHANGHAI_UTC_OFFSET_MS).getUTCDay();
  const mondayDelta = (day + 6) % 7;
  const monday = dayStart - mondayDelta * 24 * 60 * 60 * 1000;
  return new Date(monday + SHANGHAI_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

export function getShanghaiDayStartMs(now: number): number {
  const shifted = now + SHANGHAI_UTC_OFFSET_MS;
  const start = Math.floor(shifted / 86_400_000) * 86_400_000;
  return start - SHANGHAI_UTC_OFFSET_MS;
}

export function createEmptyDailyState(now: number): DailyAffinityState {
  return {
    dayKey: getShanghaiDayKey(now),
    meaningfulActionCount: 0,
    categoryCounts: {},
    lastActionAt: null,
  };
}

export function createEmptyWeeklyState(now: number): WeeklyAffinityState {
  return {
    weekKey: getShanghaiWeekKey(now),
    categoryCounts: {},
  };
}

export function parseDailyState(raw: string | null | undefined, now: number): DailyAffinityState {
  try {
    const parsed = raw ? JSON.parse(raw) as Partial<DailyAffinityState> : null;
    if (parsed?.dayKey === getShanghaiDayKey(now)) {
      return {
        dayKey: parsed.dayKey,
        meaningfulActionCount: Number(parsed.meaningfulActionCount ?? 0),
        categoryCounts: typeof parsed.categoryCounts === 'object' && parsed.categoryCounts ? parsed.categoryCounts as Record<string, number> : {},
        lastActionAt: typeof parsed.lastActionAt === 'number' ? parsed.lastActionAt : null,
      };
    }
  } catch {
    // Fall through to a fresh day.
  }
  return createEmptyDailyState(now);
}

export function parseWeeklyState(raw: string | null | undefined, now: number): WeeklyAffinityState {
  try {
    const parsed = raw ? JSON.parse(raw) as Partial<WeeklyAffinityState> : null;
    if (parsed?.weekKey === getShanghaiWeekKey(now)) {
      return {
        weekKey: parsed.weekKey,
        categoryCounts: typeof parsed.categoryCounts === 'object' && parsed.categoryCounts ? parsed.categoryCounts as Record<string, number> : {},
      };
    }
  } catch {
    // Fall through to a fresh week.
  }
  return createEmptyWeeklyState(now);
}

export function createInitialState(now: number): AffinityStateInput {
  return {
    trust: 0,
    familiarity: 0,
    comfort: 0,
    tension: 0,
    mood: 'neutral',
    attentionHeat: 0,
    energy: 80,
    stage: 'stranger',
    dailyState: createEmptyDailyState(now),
    weeklyState: createEmptyWeeklyState(now),
    lastUpdatedAt: now,
  };
}

export function stateFromRecord(row: AffinityUserStateRecord | null | undefined, now: number): AffinityStateInput {
  if (!row) return createInitialState(now);
  return {
    trust: Number(row.trust ?? 0),
    familiarity: Number(row.familiarity ?? 0),
    comfort: Number(row.comfort ?? 0),
    tension: Number(row.tension ?? 0),
    mood: row.mood ?? 'neutral',
    attentionHeat: Number(row.attentionHeat ?? 0),
    energy: Number(row.energy ?? 80),
    stage: row.stage ?? 'stranger',
    dailyState: parseDailyState(row.dailyState, now),
    weeklyState: parseWeeklyState(row.weeklyState, now),
    lastUpdatedAt: Number(row.lastUpdatedAt ?? row.updatedAt ?? now),
  };
}

export function applyTemporalDecay(state: AffinityStateInput, now: number): AffinityStateInput {
  const elapsedHours = Math.max(0, (now - state.lastUpdatedAt) / 3_600_000);
  const attentionHeat = clamp(state.attentionHeat - elapsedHours * 10, 0, 160);
  const tension = clamp(state.tension - elapsedHours * 0.035, 0, 100);
  const energy = clamp(state.energy + elapsedHours * 1.2, 0, 100);
  let mood = state.mood;
  if (elapsedHours >= 8 && mood !== 'guarded') mood = 'neutral';
  if (attentionHeat >= 70) mood = 'guarded';

  return {
    ...state,
    tension: roundScore(tension),
    attentionHeat: roundScore(attentionHeat),
    energy: roundScore(energy),
    mood,
    dailyState: state.dailyState.dayKey === getShanghaiDayKey(now) ? state.dailyState : createEmptyDailyState(now),
    weeklyState: state.weeklyState.weekKey === getShanghaiWeekKey(now) ? state.weeklyState : createEmptyWeeklyState(now),
    lastUpdatedAt: now,
  };
}

function relationScore(state: Pick<AffinityAxes, 'trust' | 'familiarity' | 'comfort' | 'tension'>): number {
  return clamp((state.trust * 0.4 + state.familiarity * 0.25 + state.comfort * 0.35) - state.tension * 0.25, 0, 100);
}

function positiveAxisDelta(axis: keyof AffinityAxes, value: number, state: AffinityStateInput, def: typeof EVENT_DEFS[AffinityEventType], confidence: number): number {
  if (value <= 0) return value;
  const softCap = STAGE_SOFT_CAPS[state.stage][axis];
  const current = state[axis];
  const saturation = clamp((softCap - current) / Math.max(softCap, 1), 0.08, 1);
  const stageFit = def.primaryStages.includes(state.stage) ? 1.25 : def.validStages.includes(state.stage) ? 0.55 : 0.18;
  return value * confidence * saturation * stageFit;
}

function negativeAxisDelta(axis: keyof AffinityAxes, value: number, state: AffinityStateInput, confidence: number): number {
  if (value >= 0) return value;
  const currentFactor = 0.6 + Math.pow(relationScore(state) / 100, 1.4);
  const loss = Math.abs(value) * confidence * STAGE_LOSS_FACTOR[state.stage] * currentFactor;
  return -loss;
}

function negativeTensionDelta(value: number, state: AffinityStateInput, confidence: number): number {
  const currentFactor = 0.6 + Math.pow(relationScore(state) / 100, 1.4);
  return Math.abs(value) * confidence * STAGE_LOSS_FACTOR[state.stage] * currentFactor;
}

function repeatFactor(category: string, state: AffinityStateInput, negative: boolean): number {
  const daily = Number(state.dailyState.categoryCounts[category] ?? 0);
  const weekly = Number(state.weeklyState.categoryCounts[category] ?? 0);
  if (negative) return 1 + Math.min(1.5, daily * 0.35 + weekly * 0.08);
  return 1 / (1 + daily * 0.65 + weekly * 0.16);
}

function resolveStage(after: AffinityStatePatch): AffinityStage {
  const score = relationScore(after);
  if (score >= 88 && after.trust >= 82 && after.comfort >= 80 && after.tension < 32) return 'special';
  if (score >= 72 && after.trust >= 65 && after.comfort >= 62 && after.tension < 36) return 'trusted';
  if (score >= 50 && after.trust >= 38 && after.comfort >= 34 && after.tension < 42) return 'remembered';
  if (score >= 22 && after.trust >= 12 && after.familiarity >= 12 && after.tension < 48) return 'polite';
  return 'stranger';
}

export function resolveAffinityEvent(stateInput: AffinityStateInput, analysis: AffinityEventAnalysis, now: number): AffinityResolution {
  const before = applyTemporalDecay(stateInput, now);
  const def = EVENT_DEFS[analysis.eventType] ?? EVENT_DEFS.none;
  const confidence = clamp(Number(analysis.confidence || 0), 0, 1);

  if (analysis.eventType === 'none' || analysis.effectTier === 'ignore' || confidence < 0.45) {
    return {
      accepted: false,
      effectTier: analysis.effectTier === 'ignore' ? 'ignore' : 'flavor',
      reasonCode: confidence < 0.45 ? 'low_confidence' : 'ignored',
      delta: {},
      before,
      after: { ...before },
      visibleFeedback: 'none',
    };
  }

  const negative = Boolean(def.negative) || analysis.route === 'boundary_risk';
  const factor = repeatFactor(def.category, before, negative);
  const heatLocked = before.attentionHeat >= 95 && !negative && analysis.effectTier === 'progress';
  const effectTier: AffinityEffectTier = heatLocked ? 'mood' : analysis.effectTier;
  const delta: Partial<AffinityAxes> & { attentionHeat?: number; energy?: number } = {};
  const axisPatch: AffinityAxes = {
    trust: before.trust,
    familiarity: before.familiarity,
    comfort: before.comfort,
    tension: before.tension,
  };

  for (const axis of ['trust', 'familiarity', 'comfort', 'tension'] as const) {
    const raw = Number(def.base[axis] ?? 0);
    if (raw === 0) continue;
    const scaled = raw > 0
      ? (negative && axis === 'tension'
          ? negativeTensionDelta(raw, before, confidence)
          : positiveAxisDelta(axis, raw, before, def, confidence)) * factor
      : negativeAxisDelta(axis, raw, before, confidence) * factor;
    const shouldApplyLongTerm = effectTier === 'progress' || (raw < 0 && effectTier !== 'flavor');
    if (!shouldApplyLongTerm) continue;
    delta[axis] = roundScore(scaled);
    axisPatch[axis] = clamp(axisPatch[axis] + scaled, 0, 100);
  }

  const heatDelta = Number(def.attentionHeat ?? 0);
  delta.attentionHeat = roundScore(heatDelta);
  const afterDaily = {
    ...before.dailyState,
    meaningfulActionCount: before.dailyState.meaningfulActionCount + (effectTier === 'progress' ? 1 : 0),
    categoryCounts: {
      ...before.dailyState.categoryCounts,
      [def.category]: Number(before.dailyState.categoryCounts[def.category] ?? 0) + 1,
    },
    lastActionAt: now,
  };
  const afterWeekly = {
    ...before.weeklyState,
    categoryCounts: {
      ...before.weeklyState.categoryCounts,
      [def.category]: Number(before.weeklyState.categoryCounts[def.category] ?? 0) + 1,
    },
  };

  const after: AffinityStatePatch = {
    ...axisPatch,
    trust: roundScore(axisPatch.trust),
    familiarity: roundScore(axisPatch.familiarity),
    comfort: roundScore(axisPatch.comfort),
    tension: roundScore(axisPatch.tension),
    attentionHeat: roundScore(clamp(before.attentionHeat + heatDelta, 0, 160)),
    energy: roundScore(clamp(before.energy - Math.max(0, heatDelta) * 0.08, 0, 100)),
    mood: negative ? 'guarded' : def.mood,
    stage: before.stage,
    dailyState: afterDaily,
    weeklyState: afterWeekly,
    lastUpdatedAt: now,
  };
  after.stage = resolveStage(after);

  return {
    accepted: true,
    effectTier,
    reasonCode: heatLocked ? 'attention_heat_locked_progress' : analysis.reasonCode || analysis.eventType,
    delta,
    before,
    after,
    visibleFeedback: negative ? 'negative' : effectTier === 'progress' ? 'subtle_positive' : effectTier === 'mood' ? 'positive' : 'none',
  };
}

export function selectRandomCount(weights: readonly [number, number, number, number], random = Math.random): number {
  const total = weights.reduce((sum, item) => sum + Math.max(0, item), 0);
  if (total <= 0) return 0;
  let cursor = random() * total;
  for (let index = 0; index < weights.length; index += 1) {
    cursor -= Math.max(0, weights[index] ?? 0);
    if (cursor <= 0) return index;
  }
  return 0;
}

export function createRandomScheduleTimes(args: {
  now: number;
  count: number;
  startHour: number;
  endHour: number;
  random?: () => number;
}): number[] {
  const random = args.random ?? Math.random;
  const dayStart = getShanghaiDayStartMs(args.now);
  const startHour = clamp(Math.floor(args.startHour), 0, 23);
  const endHour = clamp(Math.floor(args.endHour), startHour + 1, 24);
  const windowStart = dayStart + startHour * 3_600_000;
  const windowEnd = dayStart + endHour * 3_600_000;
  const times: number[] = [];
  for (let index = 0; index < args.count; index += 1) {
    times.push(Math.floor(windowStart + random() * (windowEnd - windowStart)));
  }
  return times.sort((left, right) => left - right);
}

export function pickRandomDirection(
  enabledDirections: readonly AffinityRandomDirection[],
  random = Math.random,
): AffinityRandomDirection {
  const directions = enabledDirections.length > 0 ? enabledDirections : DEFAULT_RANDOM_DIRECTIONS;
  return directions[Math.floor(random() * directions.length)] ?? 'daily_greeting';
}

export function formatStateForPrompt(state: AffinityStateInput): Record<string, unknown> {
  return {
    character: CHARACTER_ID,
    stage: state.stage,
    stageLabel: STAGE_LABELS[state.stage],
    mood: state.mood,
    attentionHeat: state.attentionHeat >= 95 ? 'high' : state.attentionHeat >= 60 ? 'warm' : 'normal',
    tension: state.tension >= 55 ? 'high' : state.tension >= 30 ? 'noticeable' : 'low',
    relationshipAxes: {
      trust: Math.round(state.trust),
      familiarity: Math.round(state.familiarity),
      comfort: Math.round(state.comfort),
      tension: Math.round(state.tension),
    },
    rules: [
      'Do not reveal numeric affinity values unless the user explicitly asks in a management context.',
      'Do not claim relationship state changed unless eventResult.effectTier indicates a meaningful change.',
      'Prefer subtle Sakiko-style feedback over game-like score announcements.',
      'When attentionHeat is high, keep replies shorter and more guarded.',
    ],
  };
}
