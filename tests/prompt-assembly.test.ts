import { afterEach, describe, expect, it } from 'vitest';
import {
  beginPromptAssemblyTurn,
  clearPromptAssemblyTurn,
  compilePromptEnvelope,
  compilePromptEnvelopeFromFragments,
  consumePromptEnvelope,
  registerPromptFragment,
} from '../src/plugins/shared/prompt-context/index.js';
import { buildReplyPromptCompilerInput, compileReplyPromptEnvelope } from '../src/plugins/reply/prompt/compiler.js';
import { buildNaturalTriggerReference } from '../src/plugins/reply/prompt/time-context.js';

describe('prompt assembly', () => {
  afterEach(() => {
    clearPromptAssemblyTurn('conv-1');
  });

  it('compiles registered runtime contract before turn fragments without implicit reply builtins', () => {
    beginPromptAssemblyTurn('conv-1');
    registerPromptFragment('conv-1', {
      source: 'chatluna_time_context',
      title: 'User Turn Metadata',
      authority: 'reference',
      trust: 'trusted',
      ttl: 'turn',
      payload: {
        kind: 'json',
        value: {
          user_name: '小祥',
          local_time: '2026-03-20 12:00:00',
        },
      },
    });
    registerPromptFragment('conv-1', {
      source: 'qqbot_reply_transport_capability',
      title: 'Reply Transport Capability State',
      authority: 'runtime_contract',
      trust: 'trusted',
      ttl: 'turn',
      payload: {
        kind: 'json',
        value: {
          voice: {
            enabled: false,
          },
        },
      },
    });

    const envelope = compilePromptEnvelope('conv-1');
    expect(envelope?.fragments.map((fragment) => fragment.source)).toEqual([
      'qqbot_reply_transport_capability',
      'chatluna_time_context',
    ]);
    expect(envelope?.messages.every((message) => message.role === 'system')).toBe(true);
    const compiledContent = envelope?.fragments.map((fragment) => fragment.content).join('\n\n') ?? '';
    expect(compiledContent).toContain('[qqbot-context]');
    expect(compiledContent).toContain('kind: turn_state');
    expect(compiledContent).toContain('kind: reference');
    expect(compiledContent).not.toContain('qqbot_reply_protocol');
  });

  it('compiles ad-hoc fragments with the same ordering rules', () => {
    const envelope = compilePromptEnvelopeFromFragments([
      {
        source: 'chatluna_time_context',
        title: 'User Turn Metadata',
        authority: 'reference',
        trust: 'trusted',
        ttl: 'turn',
        payload: {
          kind: 'text',
          value: '当前是晚上',
        },
      },
      {
        source: 'qqbot_persona',
        title: 'Persona',
        authority: 'persona_core',
        trust: 'trusted',
        ttl: 'sticky',
        payload: {
          kind: 'text',
          value: '保持自然。',
        },
      },
    ]);

    expect(envelope?.fragments.map((fragment) => fragment.source)).toEqual([
      'qqbot_persona',
      'chatluna_time_context',
    ]);
    expect(envelope?.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('[qqbot-context]'),
    });
  });

  it('supports minimal weak natural trigger reference fragments', () => {
    beginPromptAssemblyTurn('conv-1');
    registerPromptFragment('conv-1', {
      source: 'qqbot_natural_trigger',
      title: 'Natural Trigger Context',
      authority: 'reference',
      trust: 'trusted',
      ttl: 'turn',
      payload: {
        kind: 'json',
        value: buildNaturalTriggerReference({
          reason: 'focus',
          explicit: false,
        }),
      },
    });

    const envelope = compilePromptEnvelope('conv-1');
    const compiledContent = envelope?.fragments.map((fragment) => fragment.content).join('\n\n') ?? '';
    expect(compiledContent).toContain('source: qqbot_natural_trigger');
    expect(compiledContent).toContain('"reason": "focus"');
    expect(compiledContent).toContain('"explicit": false');
  });

  it('rejects non-serializable JSON fragments instead of rendering object fallback text', () => {
    const value: Record<string, unknown> = {
      kind: 'bad-json',
    };
    value.self = value;

    expect(() => compilePromptEnvelopeFromFragments([
      {
        source: 'bad_internal_state',
        title: 'Bad Internal State',
        authority: 'assistant_state',
        trust: 'trusted',
        ttl: 'turn',
        payload: {
          kind: 'json',
          value,
        },
      },
    ])).toThrow(/prompt fragment bad_internal_state JSON payload must be serializable/u);
  });

  it('builds explicit agent prompt envelopes through the reply compiler', () => {
    const envelope = compileReplyPromptEnvelope(
      buildReplyPromptCompilerInput(
        {
          input: {
            text: '当前是 agent reply 主链路',
            hasImageInput: true,
            imageCount: 1,
            displayName: '小祥',
            userId: 'u1',
            isDirect: true,
          },
          capabilitySnapshot: null,
          continuationContext: null,
        },
        [
          {
            source: 'chatluna_time_context',
            title: 'User Turn Metadata',
            authority: 'reference',
            trust: 'trusted',
            ttl: 'turn',
            payload: {
              kind: 'text',
              value: '当前是 agent reply 主链路',
            },
          },
        ],
      ),
    );

    const compiledContent = envelope?.fragments.map((fragment) => fragment.content).join('\n\n') ?? '';
    expect(envelope?.fragments.map((fragment) => fragment.source)).not.toContain('qqbot_agent_reply_contract');
    expect(envelope?.fragments.map((fragment) => fragment.source)).not.toContain('qqbot_reply_capability_snapshot');
    expect(envelope?.fragments.map((fragment) => fragment.source)).toContain('qqbot_structured_reply_contract');
    expect(compiledContent).toContain('speaker_id=<id>');
    expect(compiledContent).toContain('直接在 `message.content` 里写 `@群名片 `');
    expect(compiledContent).toContain('"type": "structured_block"');
    expect(compiledContent).not.toContain('qqbot_reply_chat_style');
    expect(compiledContent).not.toContain('"displayName": "小祥"');
    expect(compiledContent).not.toContain('"userId": "u1"');
    expect(compiledContent).not.toContain('submit_reply_plan');
    expect(compiledContent).not.toContain('submit_working_state');
  });

  it('injects CHAT_REPLY_V1 output rules when text protocol is selected', () => {
    const envelope = compileReplyPromptEnvelope(
      buildReplyPromptCompilerInput(
        {
          input: {
            text: '当前走文本协议',
            hasImageInput: false,
            imageCount: 0,
            displayName: '小祥',
            userId: 'u1',
            isDirect: true,
          },
          capabilitySnapshot: null,
          continuationContext: null,
        },
        [],
        { outputProtocol: 'chat_reply_v1' },
      ),
    );

    const compiledContent = envelope?.fragments.map((fragment) => fragment.content).join('\n\n') ?? '';
    expect(compiledContent).toContain('CHAT_REPLY_V1 <nonce>');
    expect(compiledContent).toContain('payload 内容行必须以 `|` 开头');
    expect(compiledContent).toContain('当用户要求查询 Codeforces/CF 信息时，必须先调用 Codeforces 查询工具；工具会返回本地生成的卡片/曲线图 `image.assetRef`，最终回复先发该图，再用简短中文评价具体信息。');
    expect(compiledContent).not.toContain('"outbound_messages"');
  });

  it('adds the configured voice output language to reply prompt contracts', () => {
    const envelope = compileReplyPromptEnvelope(
      buildReplyPromptCompilerInput(
        {
          input: {
            text: '请发一句语音',
            hasImageInput: false,
            imageCount: 0,
            displayName: '小祥',
            userId: 'u1',
            isDirect: true,
          },
          capabilitySnapshot: {
            canMultiline: true,
            canVoice: true,
            voiceOutputLanguage: 'ja',
            canSticker: false,
            stickerAvailableCount: 0,
            source: 'cached',
          },
          continuationContext: null,
        },
        [],
        { outputProtocol: 'chat_reply_v1' },
      ),
    );

    const compiledContent = envelope?.fragments.map((fragment) => fragment.content).join('\n\n') ?? '';
    expect(compiledContent).toContain('当前语音输出目标语言：日语');
    expect(compiledContent).toContain('`voice.content` 必须直接写成自然日语');
    expect(compiledContent).toContain('|本当にうれしいです。');
  });

  it('consumes a turn envelope exactly once', () => {
    beginPromptAssemblyTurn('conv-1');
    registerPromptFragment('conv-1', {
      source: 'qqbot_memory',
      title: 'Long-Term Memory Reference',
      authority: 'reference',
      trust: 'untrusted',
      ttl: 'turn',
      payload: {
        kind: 'text',
        value: 'Relevant Long-Term Memory',
      },
    });

    expect(
      (consumePromptEnvelope('conv-1')?.messages.map((message) => String(message.content)).join('\n\n') as string) ?? '',
    ).toContain('Relevant Long-Term Memory');
    expect(consumePromptEnvelope('conv-1')).toBeNull();
  });

  it('deduplicates identical fragments within the same turn', () => {
    beginPromptAssemblyTurn('conv-1');
    const fragment = {
      source: 'qqbot_recent_attachments',
      title: 'Recent Attachments',
      authority: 'reference' as const,
      trust: 'trusted' as const,
      ttl: 'turn' as const,
      payload: {
        kind: 'text' as const,
        value: 'att_1 image/png screenshot.png',
      },
    };

    registerPromptFragment('conv-1', fragment);
    registerPromptFragment('conv-1', fragment);

    const envelope = compilePromptEnvelope('conv-1');
    expect(envelope?.fragments.map((item) => item.source)).toEqual(['qqbot_recent_attachments']);
    expect(envelope?.messages.map((item) => item.content).join('\n')).toContain('att_1 image/png screenshot.png');
  });

  it('keeps same-source fragments when their payloads differ', () => {
    beginPromptAssemblyTurn('conv-1');
    for (const value of ['att_1 image/png screenshot.png', 'att_2 application/pdf report.pdf']) {
      registerPromptFragment('conv-1', {
        source: 'qqbot_recent_attachments',
        title: 'Recent Attachments',
        authority: 'reference',
        trust: 'trusted',
        ttl: 'turn',
        payload: {
          kind: 'text',
          value,
        },
      });
    }

    const envelope = compilePromptEnvelope('conv-1');
    expect(envelope?.fragments.map((item) => item.source)).toEqual([
      'qqbot_recent_attachments',
      'qqbot_recent_attachments',
    ]);
    const content = envelope?.messages.map((item) => item.content).join('\n') ?? '';
    expect(content).toContain('att_1 image/png screenshot.png');
    expect(content).toContain('att_2 application/pdf report.pdf');
  });

  it('preserves fragments registered before the turn formally begins', () => {
    registerPromptFragment('conv-1', {
      source: 'qqbot_live_reply_continuation',
      title: 'Assistant Continuation State',
      authority: 'assistant_state',
      trust: 'trusted',
      ttl: 'turn',
      payload: {
        kind: 'text',
        value: '这是续写，不要重复前文。',
      },
    });

    beginPromptAssemblyTurn('conv-1');
    registerPromptFragment('conv-1', {
      source: 'chatluna_time_context',
      title: 'User Turn Metadata',
      authority: 'reference',
      trust: 'trusted',
      ttl: 'turn',
      payload: {
        kind: 'json',
        value: { user_name: '小祥' },
      },
    });

    const envelope = compilePromptEnvelope('conv-1');
    expect(envelope?.fragments.map((fragment) => fragment.content).join('\n\n') ?? '').toContain('这是续写，不要重复前文。');
    expect(envelope?.fragments.map((fragment) => fragment.source)).toContain('qqbot_live_reply_continuation');
  });

  it('clears stale fragments when a new started turn begins', () => {
    beginPromptAssemblyTurn('conv-1');
    registerPromptFragment('conv-1', {
      source: 'stale_fragment',
      title: 'Stale Fragment',
      authority: 'reference',
      trust: 'trusted',
      ttl: 'turn',
      payload: {
        kind: 'text',
        value: '旧内容',
      },
    });

    beginPromptAssemblyTurn('conv-1');

    const envelope = compilePromptEnvelope('conv-1');
    expect(envelope).toBeNull();
  });
});
