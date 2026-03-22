import { describe, expect, it } from 'vitest';
import { parseReplyPlanFromToolResultDetailed } from '../src/plugins/reply/plan/parser.js';

function createToolResult(input: Record<string, unknown>) {
  return {
    content: '',
    additional_kwargs: {
      chatluna_agent_terminal_tool: {
        name: 'submit_reply_plan',
        input,
      },
    },
  };
}

describe('reply plan parser', () => {
  it('parses mixed submit_reply_plan segments including image', () => {
    const result = parseReplyPlanFromToolResultDetailed(
      createToolResult({
        segments: [
          { kind: 'text', content: '第一句' },
          { kind: 'voice', content: '第二句' },
          { kind: 'image', asset_ref: 'asset://image-1', alt: '夜景' },
          { kind: 'sticker', content: '冷淡拒绝' },
        ],
      }),
    );

    expect(result).toEqual({
      plan: {
        segments: [
          { kind: 'text', content: '第一句' },
          { kind: 'voice', content: '第二句' },
          { kind: 'image', assetRef: 'asset://image-1', alt: '夜景' },
          { kind: 'sticker', content: '冷淡拒绝' },
        ],
      },
      error: null,
      terminalToolName: 'submit_reply_plan',
    });
  });

  it('fails when terminal tool is missing', () => {
    expect(parseReplyPlanFromToolResultDetailed({ content: '普通文本', additional_kwargs: {} })).toEqual({
      plan: null,
      error: 'reply-agent 未提交 submit_reply_plan 终态工具。',
      terminalToolName: null,
    });
  });

  it('fails when image segment misses asset_ref', () => {
    const result = parseReplyPlanFromToolResultDetailed(
      createToolResult({
        segments: [{ kind: 'image', alt: '夜景' }],
      }),
    );

    expect(result.plan).toBeNull();
    expect(result.error).toContain('submit_reply_plan 参数不符合 schema');
    expect(result.terminalToolName).toBe('submit_reply_plan');
  });
});
