import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MainChatRuntimeProfile } from '../src/plugins/shared/llm/main-chat-tabs.js';
import {
  createInitialState,
  createRandomScheduleTimes,
  resolveAffinityEvent,
  selectRandomCount,
  type AffinityEventAnalysis,
  type AffinityStateInput,
} from '../src/plugins/affinity/rules.js';
import { analyzeAffinityEvent, resolveAnalysisModelConfig } from '../src/plugins/affinity/analysis.js';

function analysis(eventType: AffinityEventAnalysis['eventType'], overrides: Partial<AffinityEventAnalysis> = {}): AffinityEventAnalysis {
  return {
    route: 'affinity_candidate',
    eventType,
    effectTier: 'progress',
    category: eventType,
    confidence: 0.9,
    evidence: 'test',
    replyHint: null,
    risk: 'none',
    reasonCode: `test_${eventType}`,
    ...overrides,
  };
}

function mainProfile(): MainChatRuntimeProfile {
  return {
    tabId: 'deepseek',
    id: 'deepseek',
    title: 'DeepSeek',
    provider: 'deepseek',
    strategyId: 'deepseek-official-main-chat',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'chat_reply_v1',
    authKind: 'manual',
    authStatus: 'ready',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'main-key',
    defaultModel: 'deepseek-v4-flash',
    canonicalModel: 'deepseek-v4-flash',
    transportModel: 'deepseek-v4-flash',
    description: '',
    modelHint: '',
  } as MainChatRuntimeProfile;
}

describe('affinity rules', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reduces positive gains when the current stage is near its soft cap', () => {
    const now = Date.now();
    const low = createInitialState(now);
    const high: AffinityStateInput = {
      ...low,
      trust: 18,
      familiarity: 20,
      comfort: 17,
    };

    const lowResult = resolveAffinityEvent(low, analysis('offer_tea'), now + 1000);
    const highResult = resolveAffinityEvent(high, analysis('offer_tea'), now + 1000);

    expect(highResult.delta.comfort ?? 0).toBeLessThan(lowResult.delta.comfort ?? 0);
    expect(highResult.delta.familiarity ?? 0).toBeLessThan(lowResult.delta.familiarity ?? 0);
  });

  it('amplifies negative changes at higher relationship stages', () => {
    const now = Date.now();
    const base = createInitialState(now);
    const special: AffinityStateInput = {
      ...base,
      trust: 92,
      familiarity: 90,
      comfort: 90,
      stage: 'special',
    };

    const lowResult = resolveAffinityEvent(base, analysis('pressure_or_spam', { route: 'boundary_risk' }), now + 1000);
    const highResult = resolveAffinityEvent(special, analysis('pressure_or_spam', { route: 'boundary_risk' }), now + 1000);

    expect(Math.abs(highResult.delta.comfort ?? 0)).toBeGreaterThan(Math.abs(lowResult.delta.comfort ?? 0));
    expect(highResult.delta.tension ?? 0).toBeGreaterThan(lowResult.delta.tension ?? 0);
  });

  it('selects random count from configured daily weights', () => {
    expect(selectRandomCount([0.25, 0.6, 0.1, 0.05], () => 0.0)).toBe(0);
    expect(selectRandomCount([0.25, 0.6, 0.1, 0.05], () => 0.3)).toBe(1);
    expect(selectRandomCount([0.25, 0.6, 0.1, 0.05], () => 0.9)).toBe(2);
    expect(selectRandomCount([0.25, 0.6, 0.1, 0.05], () => 0.98)).toBe(3);
  });

  it('creates proactive event times inside the configured Shanghai day window', () => {
    const now = Date.UTC(2026, 5, 17, 1, 0, 0); // 2026-06-17 09:00 Asia/Shanghai
    const times = createRandomScheduleTimes({
      now,
      count: 3,
      startHour: 8,
      endHour: 22,
      random: () => 0.5,
    });

    expect(times).toHaveLength(3);
    for (const time of times) {
      const hour = new Date(time + 8 * 60 * 60 * 1000).getUTCHours();
      expect(hour).toBeGreaterThanOrEqual(8);
      expect(hour).toBeLessThan(22);
    }
  });

  it('uses the main chat model when analysis model core fields are empty', () => {
    const resolved = resolveAnalysisModelConfig({
      baseUrl: '',
      apiKey: '',
      model: '',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'chat_reply_v1',
      timeoutMs: 7000,
    }, mainProfile());

    expect(resolved.baseUrl).toBe('https://api.deepseek.com');
    expect(resolved.apiKey).toBe('main-key');
    expect(resolved.model).toBe('deepseek-v4-flash');
    expect(resolved.timeoutMs).toBe(7000);
  });

  it('rejects partial analysis model configuration', () => {
    expect(() => resolveAnalysisModelConfig({
      baseUrl: 'https://example.com/v1',
      apiKey: '',
      model: 'x',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'chat_reply_v1',
    }, mainProfile())).toThrow(/完整配置/);
  });

  it('routes natural replies to an active proactive random thread before greeting triggers', async () => {
    const result = await analyzeAffinityEvent({
      text: 'saki 我接一下你前面说的缩点：如果缩完还能成环，那这些点互相可达，确实应该在同一个 SCC 里。',
      openThreads: ['random:local_thread: SCC 缩点遗留讨论'],
      randomPending: true,
      relationSummary: {},
    }, null);

    expect(result).toEqual(expect.objectContaining({
      route: 'random_event_reply',
      eventType: 'answer_random_prompt',
      reasonCode: 'heuristic_random_followup',
    }));
  });

  it('ignores non-thread relationship keywords when the analysis model is unavailable', async () => {
    const result = await analyzeAffinityEvent({
      text: 'saki 我给你泡一杯红茶，不急，等你想说再说。',
      openThreads: [],
      randomPending: false,
      relationSummary: {},
    }, null);

    expect(result).toEqual(expect.objectContaining({
      route: 'ignore',
      eventType: 'none',
      effectTier: 'ignore',
      reasonCode: 'analysis_model_unavailable',
    }));
  });

  it('ignores invalid model output instead of applying relationship heuristics', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: 'not json' }),
    })));

    const result = await analyzeAffinityEvent({
      text: 'saki 我给你泡一杯红茶。',
      openThreads: [],
      randomPending: false,
      relationSummary: {},
    }, {
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      requestMode: 'responses',
      structuredOutputProtocol: 'native_responses_json_schema',
      timeoutMs: 1000,
    });

    expect(result).toEqual(expect.objectContaining({
      route: 'ignore',
      eventType: 'none',
      effectTier: 'ignore',
      reasonCode: 'analysis_model_invalid_response',
    }));
  });
});
