import { describe, expect, it } from 'vitest';
import { parsePlainTextMemoryV1 } from '../src/plugins/memory/providers/plain-text-memory-v1.js';

describe('plain_text_memory_v1 parser', () => {
  it('parses strict bounded block lines', () => {
    const result = parsePlainTextMemoryV1(`
ignored
<memory_extraction_v3>
FACT|kind=preference|topic=answer-style|visibility=global|sensitivity=low|confidence=0.82|importance=0.70|用户喜欢简洁直接的技术回答
EPISODE|title=重构 memory-v3|date=2026-06-09|visibility=private_only|sensitivity=personal|confidence=0.80|importance=0.70|用户正在重构 kbot 的长期记忆系统
DROP|群聊玩笑，不应泛化为全局偏好
</memory_extraction_v3>
`);
    expect(result.map((item) => item.candidateType)).toEqual(['fact', 'episode', 'drop']);
    expect(result[0]).toMatchObject({ kind: 'preference', topicKey: 'answer-style', suggestedVisibility: 'global' });
  });

  it('fails the whole batch for malformed required fields', () => {
    expect(() => parsePlainTextMemoryV1(`
<memory_extraction_v3>
FACT|kind=preference|topic=answer-style|visibility=global|sensitivity=low|confidence=0.82|用户喜欢简洁直接的技术回答
</memory_extraction_v3>
`)).toThrow(/missing_importance/);
  });
});
