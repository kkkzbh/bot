import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  beginPromptAssemblyTurn,
  clearPromptAssemblyTurn,
  compilePromptEnvelope,
  registerPromptFragment,
} from '../src/plugins/shared/prompt-context/index.js';

describe('chatluna prompt pollution regression', () => {
  afterEach(() => {
    clearPromptAssemblyTurn('conv-prompt-pollution');
  });

  it('keeps qqbot prompt envelope as system messages only', () => {
    beginPromptAssemblyTurn('conv-prompt-pollution');
    registerPromptFragment('conv-prompt-pollution', {
      source: 'chatluna_time_context',
      authority: 'reference',
      trust: 'trusted',
      ttl: 'turn',
      payload: {
        kind: 'json',
        value: {
          user_name: '小祥',
          local_time: '2026-03-21 12:00:00',
        },
      },
    });

    const envelope = compilePromptEnvelope('conv-prompt-pollution');
    expect(envelope?.messages.every((message) => message.getType() === 'system')).toBe(true);
    expect(
      envelope?.messages.some((message) =>
        String(message.content).includes('Respond naturally according to your system prompt'),
      ),
    ).toBe(false);
  });

  it('uses a chatluna build without pseudo system after_user_message injection', () => {
    const packageJsonPath = require.resolve('koishi-plugin-chatluna/package.json');
    const packageRoot = dirname(packageJsonPath);
    const builtEntry = readFileSync(join(packageRoot, 'lib/index.cjs'), 'utf8');

    expect(builtEntry).not.toContain('requests["after_user_message"]');
    expect(builtEntry).not.toContain('AGENT_AFTER_USER_PROMPT');
    expect(builtEntry).not.toContain('Respond naturally according to your system prompt');
  });
});
