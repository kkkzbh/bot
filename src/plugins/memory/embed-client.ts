export interface MemoryEmbedRuntime {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

interface EmbeddingResponse {
  data?: Array<{
    index?: number;
    embedding?: unknown;
  }>;
}

export function isEmbedRuntimeConfigured(runtime: MemoryEmbedRuntime): boolean {
  return Boolean(runtime.baseUrl.trim() && runtime.apiKey.trim() && runtime.model.trim());
}

export async function embedTexts(runtime: MemoryEmbedRuntime, inputs: string[]): Promise<Array<number[] | null>> {
  if (!isEmbedRuntimeConfigured(runtime)) {
    return inputs.map(() => null);
  }
  if (!inputs.length) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
  try {
    const response = await fetch(`${runtime.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtime.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: runtime.model,
        input: inputs,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`embed_http_${response.status}`);
    }

    const payload = (await response.json()) as EmbeddingResponse;
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const result = inputs.map(() => null as number[] | null);
    for (const [position, row] of rows.entries()) {
      const index = Number.isFinite(Number(row.index)) ? Number(row.index) : position;
      if (!Array.isArray(row.embedding) || index < 0 || index >= result.length) continue;
      const vector = row.embedding.map((item) => Number(item)).filter((item) => Number.isFinite(item));
      result[index] = vector.length ? vector : null;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
