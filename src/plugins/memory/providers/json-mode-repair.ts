import type { ExtractedMemoryCandidate } from '../gates.js';
import { requestChatMemoryPlainText } from './chat-client.js';
import type { MemoryProviderProfile } from './router.js';
import {
  buildMemoryExtractionPrompt,
  parseMemoryExtractionJson,
  type MemoryConversationTurn,
  type MemoryExtractionTarget,
} from './schemas.js';

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
    if (!response.ok) throw new Error(`extract_http_${response.status}`);
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
    const repairText = await requestChatMemoryPlainText(
      profile,
      [
        ...turns,
        {
          id: 'repair',
          role: 'human',
          text: [
            '上一次输出不是可解析的 memory_extraction JSON。',
            '请改用 plain_text_memory_v1 bounded block 重写同一批候选。',
            rawText,
          ].join('\n'),
          speakerId: target.speakerId,
          speakerName: target.speakerName,
          ownerUserKey: null,
          isTarget: true,
          attributionSource: 'direct_fallback',
        },
      ],
      target,
    );
    const { parsePlainTextMemoryV1 } = await import('./plain-text-memory-v1.js');
    return { candidates: parsePlainTextMemoryV1(repairText), rawText: repairText };
  }
}
