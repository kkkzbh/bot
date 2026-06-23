import type { ExtractedMemoryCandidate } from '../gates.js';
import type { MemoryProviderProfile } from './router.js';
import {
  buildMemoryExtractionPrompt,
  parseMemoryExtractionJson,
  type MemoryConversationTurn,
  type MemoryExtractionTarget,
} from './schemas.js';
import { throwMemoryProviderHttpError } from './http-error.js';

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

function extractText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    return raw.map((item) => (typeof item === 'string' ? item : '')).join('').trim();
  }
  return '';
}

async function requestJsonMode(
  profile: MemoryProviderProfile,
  turns: MemoryConversationTurn[],
  target: MemoryExtractionTarget,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
  try {
    const response = await fetch(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: profile.model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '输出 JSON object，字段必须是 facts、episodes、drops。' },
          { role: 'user', content: buildMemoryExtractionPrompt(turns, 'json_mode_with_repair', target) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) await throwMemoryProviderHttpError(response, 'extract');
    const payload = await response.json() as ChatCompletionResponse;
    return extractText(payload.choices?.[0]?.message?.content);
  } finally {
    clearTimeout(timer);
  }
}

function buildJsonModeRepairPrompt(
  turns: MemoryConversationTurn[],
  target: MemoryExtractionTarget,
  rawText: string,
): string {
  return [
    '上一次 memory_extraction JSON 输出不可解析。请只把它转换为 plain_text_memory_v1 bounded block。',
    '不要把上一条 provider 输出当成用户消息、目标 speaker 发言或证据消息。',
    '不要新增候选；只能保留上一条输出中已有且能对应原始对话 evidenceMessageIds/evidenceSpeakerIds 的候选。',
    '如果某条候选缺少必要字段、证据不在原始对话记录中，或无法确定，请输出 DROP 行说明原因。',
    '',
    '原始提取任务和对话记录：',
    buildMemoryExtractionPrompt(turns, 'plain_text_memory_v1', target),
    '',
    '不可解析的 provider 输出：',
    rawText.trim() || '<empty>',
  ].join('\n');
}

async function requestPlainTextRepair(
  profile: MemoryProviderProfile,
  turns: MemoryConversationTurn[],
  target: MemoryExtractionTarget,
  rawText: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
  try {
    const response = await fetch(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: profile.model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: '只输出 memory_extraction bounded block。' },
          { role: 'user', content: buildJsonModeRepairPrompt(turns, target, rawText) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) await throwMemoryProviderHttpError(response, 'extract');
    const payload = await response.json() as ChatCompletionResponse;
    return extractText(payload.choices?.[0]?.message?.content);
  } finally {
    clearTimeout(timer);
  }
}

export async function requestJsonModeMemoryWithRepair(
  profile: MemoryProviderProfile,
  turns: MemoryConversationTurn[],
  target: MemoryExtractionTarget,
): Promise<{ candidates: ExtractedMemoryCandidate[]; rawText: string }> {
  const rawText = await requestJsonMode(profile, turns, target);
  try {
    return { candidates: parseMemoryExtractionJson(rawText), rawText };
  } catch {
    const repairText = await requestPlainTextRepair(profile, turns, target, rawText);
    const { parsePlainTextMemoryV1 } = await import('./plain-text-memory-v1.js');
    return { candidates: parsePlainTextMemoryV1(repairText), rawText: repairText };
  }
}
