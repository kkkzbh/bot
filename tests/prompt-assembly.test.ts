import { afterEach, describe, expect, it } from 'vitest';
import {
  beginPromptAssemblyTurn,
  clearPromptAssemblyTurn,
  compilePromptEnvelope,
  consumePromptEnvelope,
  registerPromptFragment,
} from '../src/plugins/prompt-assembly.js';

describe('prompt assembly', () => {
  afterEach(() => {
    clearPromptAssemblyTurn('conv-1');
  });

  it('compiles built-in runtime contract before turn fragments', () => {
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
      'qqbot_persona_invariant',
      'qqbot_reply_protocol',
      'qqbot_reply_transport_capability',
      'chatluna_time_context',
    ]);
    expect(envelope?.content).toContain('<qqbot-internal-contract');
    expect(envelope?.content).toContain('<qqbot-turn-state');
    expect(envelope?.content).toContain('<qqbot-reference');
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

    expect(consumePromptEnvelope('conv-1')?.content).toContain('Relevant Long-Term Memory');
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
    expect(envelope?.content).toContain('这是续写，不要重复前文。');
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
    expect(envelope?.content).not.toContain('旧内容');
    expect(envelope?.fragments.map((fragment) => fragment.source)).not.toContain('stale_fragment');
  });
});
