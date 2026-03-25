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
    expect(envelope?.fragments.map((fragment) => fragment.source)).toContain('qqbot_agent_reply_contract');
    expect(envelope?.fragments.map((fragment) => fragment.source)).not.toContain('qqbot_reply_structured_schema');
    expect(compiledContent).not.toContain('最终输出遵循结构化响应');
    expect(compiledContent).toContain('voice.content');
    expect(compiledContent).toContain('meme.content');
    expect(compiledContent).toContain('"hasImageInput": true');
    expect(compiledContent).toContain('"imageCount": 1');
    expect(compiledContent).not.toContain('submit_reply_plan');
    expect(compiledContent).not.toContain('submit_working_state');
  });

  it('consumes a turn envelope exactly once', () => {
    beginPromptAssemblyTurn('conv-1');
    registerPromptFragment('conv-1', {
      source: 'qqbot_memory_v2',
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
