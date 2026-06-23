import type { MainChatRuntimeProfile } from '../shared/llm/main-chat-tabs.js';
import type {
  AffinityAnalysisModelConfig,
  AffinityAnalysisRequestMode,
  AffinityAnalysisRoute,
  AffinityAnalysisStructuredOutputProtocol,
  AffinityEffectTier,
  AffinityEventType,
} from '../../types/affinity.js';
import type { AffinityEventAnalysis } from './rules.js';

export interface PartialAnalysisModelConfig {
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  requestMode?: string | null;
  structuredOutputProtocol?: string | null;
  timeoutMs?: number | string | null;
}

export interface AnalyzeAffinityInput {
  text: string;
  recentContext?: string[];
  openThreads?: string[];
  relationSummary?: Record<string, unknown> | null;
  randomPending?: boolean;
}

const ROUTES = new Set<AffinityAnalysisRoute>([
  'ignore',
  'normal_chat',
  'affinity_flavor',
  'affinity_candidate',
  'random_event_reply',
  'group_event_progress',
  'boundary_risk',
]);

const EVENT_TYPES = new Set<AffinityEventType>([
  'none',
  'greeting_contextual',
  'offer_tea',
  'music_help',
  'care_subtle',
  'keep_promise',
  'boundary_respect',
  'light_tease',
  'contest_discussion',
  'computer_knowledge',
  'answer_random_prompt',
  'over_interaction',
  'pressure_or_spam',
  'promise_broken',
]);

const EFFECT_TIERS = new Set<AffinityEffectTier>(['ignore', 'flavor', 'mood', 'progress']);

function trim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRequestMode(value: unknown): AffinityAnalysisRequestMode | null {
  const normalized = trim(value);
  if (normalized === 'chat_completions' || normalized === 'responses') return normalized;
  return null;
}

function normalizeProtocol(value: unknown): AffinityAnalysisStructuredOutputProtocol | null {
  const normalized = trim(value);
  if (
    normalized === 'native_chat_json_schema' ||
    normalized === 'native_responses_json_schema' ||
    normalized === 'chat_reply_v1' ||
    normalized === 'json_mode'
  ) {
    return normalized;
  }
  return null;
}

export function resolveAnalysisModelConfig(
  config: PartialAnalysisModelConfig,
  mainProfile: MainChatRuntimeProfile,
): AffinityAnalysisModelConfig {
  const baseUrl = trim(config.baseUrl);
  const apiKey = trim(config.apiKey);
  const model = trim(config.model);
  const requestMode = normalizeRequestMode(config.requestMode);
  const structuredOutputProtocol = normalizeProtocol(config.structuredOutputProtocol);
  const timeout = Number(config.timeoutMs);
  const hasAnyCore = Boolean(baseUrl || apiKey || model);

  if (!hasAnyCore) {
    return {
      baseUrl: mainProfile.baseUrl,
      apiKey: mainProfile.apiKey,
      model: mainProfile.transportModel || mainProfile.canonicalModel || mainProfile.defaultModel,
      requestMode: mainProfile.requestMode,
      structuredOutputProtocol: mainProfile.structuredOutputProtocol as AffinityAnalysisStructuredOutputProtocol,
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 5000,
    };
  }

  if (!baseUrl || !apiKey || !model || !requestMode || !structuredOutputProtocol) {
    throw new Error('关系事件分析模型必须完整配置 baseUrl/apiKey/model/requestMode/structuredOutputProtocol，或全部留空以跟随主聊天模型。');
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
    requestMode,
    structuredOutputProtocol,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 5000,
  };
}

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) ?? raw.match(/```\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return null;
}

function normalizeAnalysis(value: unknown): AffinityEventAnalysis | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const route = ROUTES.has(record.route as AffinityAnalysisRoute) ? record.route as AffinityAnalysisRoute : 'ignore';
  const eventType = EVENT_TYPES.has(record.eventType as AffinityEventType) ? record.eventType as AffinityEventType : 'none';
  const effectTier = EFFECT_TIERS.has(record.effectTier as AffinityEffectTier) ? record.effectTier as AffinityEffectTier : 'ignore';
  const confidence = Number(record.confidence);
  const riskValue = trim(record.risk);
  return {
    route,
    eventType,
    effectTier,
    category: trim(record.category) || eventType,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    evidence: trim(record.evidence) || null,
    replyHint: trim(record.replyHint) || null,
    risk: riskValue === 'low' || riskValue === 'medium' || riskValue === 'high' ? riskValue : 'none',
    reasonCode: trim(record.reasonCode) || eventType,
  };
}

function ignoredAnalysis(input: AnalyzeAffinityInput, reasonCode: string): AffinityEventAnalysis {
  const text = input.text.trim();
  return {
    route: 'ignore',
    eventType: 'none',
    effectTier: 'ignore',
    category: 'none',
    confidence: 0,
    evidence: text ? text.slice(0, 80) : null,
    replyHint: null,
    risk: 'none',
    reasonCode: text ? reasonCode : 'empty',
  };
}

function resolveActiveRandomThreadAnalysis(input: AnalyzeAffinityInput): AffinityEventAnalysis | null {
  const text = input.text.trim();
  const hasOpenThread = Boolean(input.randomPending || input.openThreads?.length);
  if (
    hasOpenThread &&
    /(前面|刚才|你说|你前面|你刚才|接一下|继续|补充|这个|这道|那道|我想了|我觉得|确实|应该|可以|不太对|懂了|明白了|回应一下)/u.test(text)
  ) {
    return {
      route: 'random_event_reply',
      eventType: 'answer_random_prompt',
      effectTier: 'progress',
      category: 'random_followup',
      confidence: 0.72,
      evidence: text.slice(0, 80),
      replyHint: 'continue_thread',
      risk: 'none',
      reasonCode: 'heuristic_random_followup',
    };
  }
  return null;
}

function resolveAnalysisUnavailable(input: AnalyzeAffinityInput, reasonCode: string): AffinityEventAnalysis {
  return resolveActiveRandomThreadAnalysis(input) ?? ignoredAnalysis(input, reasonCode);
}

async function fetchChatCompletions(config: AffinityAnalysisModelConfig, prompt: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: '你是 QQ 群关系玩法的事件分析器。只输出一个 JSON 对象，不要解释。',
        },
        { role: 'user', content: prompt },
      ],
    }),
    signal,
  });
  if (!response.ok) return null;
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => item.text ?? '').join('').trim();
  return null;
}

async function fetchResponses(config: AffinityAnalysisModelConfig, prompt: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_output_tokens: 400,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: '你是 QQ 群关系玩法的事件分析器。只输出一个 JSON 对象，不要解释。' }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      ],
      store: false,
    }),
    signal,
  });
  if (!response.ok) return null;
  const payload = await response.json() as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };
  if (typeof payload.output_text === 'string') return payload.output_text;
  return payload.output
    ?.flatMap((item) => item.content ?? [])
    .map((item) => item.text ?? '')
    .join('')
    .trim() || null;
}

function buildPrompt(input: AnalyzeAffinityInput): string {
  return [
    '请把用户消息路由到关系玩法事件。只输出 JSON，字段如下：',
    '{',
    '  "route": "ignore|normal_chat|affinity_flavor|affinity_candidate|random_event_reply|group_event_progress|boundary_risk",',
    '  "eventType": "none|greeting_contextual|offer_tea|music_help|care_subtle|keep_promise|boundary_respect|light_tease|contest_discussion|computer_knowledge|answer_random_prompt|over_interaction|pressure_or_spam|promise_broken",',
    '  "effectTier": "ignore|flavor|mood|progress",',
    '  "category": "短分类",',
    '  "confidence": 0到1,',
    '  "risk": "none|low|medium|high",',
    '  "evidence": "原文证据",',
    '  "replyHint": "给角色回复的短提示",',
    '  "reasonCode": "机器可读原因"',
    '}',
    '规则：模型不能决定分数，不能升阶。低确定性用 affinity_flavor 或 normal_chat。',
    `关系摘要: ${JSON.stringify(input.relationSummary ?? {})}`,
    `开放线索: ${JSON.stringify(input.openThreads ?? [])}`,
    `最近上下文: ${JSON.stringify(input.recentContext ?? [])}`,
    `是否回应随机事件: ${input.randomPending ? 'true' : 'false'}`,
    `用户消息: ${input.text}`,
  ].join('\n');
}

export async function analyzeAffinityEvent(
  input: AnalyzeAffinityInput,
  config: AffinityAnalysisModelConfig | null,
): Promise<AffinityEventAnalysis> {
  if (!config?.baseUrl || !config.apiKey || !config.model) {
    return resolveAnalysisUnavailable(input, 'analysis_model_unavailable');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const prompt = buildPrompt(input);
    const raw = config.requestMode === 'responses'
      ? await fetchResponses(config, prompt, controller.signal)
      : await fetchChatCompletions(config, prompt, controller.signal);
    if (!raw) return resolveAnalysisUnavailable(input, 'analysis_model_empty_response');
    const json = extractJsonObject(raw);
    if (!json) return resolveAnalysisUnavailable(input, 'analysis_model_invalid_response');
    const parsed = normalizeAnalysis(JSON.parse(json));
    return parsed ?? resolveAnalysisUnavailable(input, 'analysis_model_invalid_analysis');
  } catch {
    return resolveAnalysisUnavailable(input, 'analysis_model_error');
  } finally {
    clearTimeout(timer);
  }
}
