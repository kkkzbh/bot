import { describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

vi.mock('koishi-plugin-chatluna/utils/string', () => ({
  getMessageContent(content: unknown) {
    return typeof content === 'string' ? content : '';
  },
}));

import { applyQqbotRequestBudget } from '../../chatluna/packages/core/src/llm-core/chain/qqbot_request_budget.js';

describe('qqbot request budget', () => {
  it('trims long history down to the configured window', async () => {
    const history = Array.from({ length: 160 }, (_, index) =>
      index % 2 === 0
        ? new HumanMessage(`human-${index}`)
        : new AIMessage(`ai-${index}`),
    );

    const result = await applyQqbotRequestBudget(
      {
        getModelMaxContextSize: () => 100_000,
        getNumTokens: async (text: string) => Math.ceil(text.length / 4),
      } as any,
      history,
      {
        qqbot_request_budget_policy: {
          historyWindow: 80,
          historyTriggerCount: 120,
          historyTokenRatio: 0.7,
        },
      },
    );

    expect(result.stats?.applied).toBe(true);
    expect(result.messages).toHaveLength(80);
    expect(result.stats?.trimmedHistoryCount).toBe(80);
    expect(result.stats?.historyWindowCount).toBe(80);
  });
});
