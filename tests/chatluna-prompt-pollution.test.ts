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
    expect(envelope?.messages.every((message) => message.role === 'system')).toBe(true);
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

  it('keeps finishContract wired through plugin chat chain construction', () => {
    const packageJsonPath = require.resolve('koishi-plugin-chatluna/package.json');
    const packageRoot = dirname(packageJsonPath);
    const pluginChainSource = readFileSync(join(packageRoot, 'src/llm-core/chain/plugin_chat_chain.ts'), 'utf8');

    expect(pluginChainSource).toContain('finishContract');
    expect(pluginChainSource).toContain('finishContract: this.finishContract');
    expect(pluginChainSource).toContain('ensureToolMaskAllows');
    expect(pluginChainSource).toContain('toolMask,');
    expect(pluginChainSource).toContain('toolMask,\n            finishContract');
  });

  it('uses a chatluna context manager build that accepts plain prompt message objects', () => {
    const packageJsonPath = require.resolve('koishi-plugin-chatluna/package.json');
    const packageRoot = dirname(packageJsonPath);
    const contextManagerSource = readFileSync(join(packageRoot, 'src/llm-core/prompt/context_manager.ts'), 'utf8');

    expect(contextManagerSource).toContain('interface PlainPromptMessage');
    expect(contextManagerSource).toContain('isPlainPromptMessage');
    expect(contextManagerSource).toContain('createMessageFromPlainObject');
  });

  it('suppresses tool call thought rendering in reply-agent mode', () => {
    const packageJsonPath = require.resolve('koishi-plugin-chatluna/package.json');
    const packageRoot = dirname(packageJsonPath);
    const requestModelSource = readFileSync(join(packageRoot, 'src/middlewares/model/request_model.ts'), 'utf8');

    expect(requestModelSource).toContain("context.options.room?.chatMode === 'reply-agent'");
    expect(requestModelSource).toContain('return');
  });

  it('keeps tool-call history content as strings for OpenAI-compatible request payloads', () => {
    const packageJsonPath = require.resolve('koishi-plugin-chatluna/package.json');
    const packageRoot = dirname(packageJsonPath);
    const sharedAdapterSource = readFileSync(join(packageRoot, '..', 'shared-adapter', 'src', 'utils.ts'), 'utf8');
    const sharedAdapterBundle = readFileSync(join(packageRoot, '..', 'shared-adapter', 'lib', 'index.mjs'), 'utf8');

    expect(sharedAdapterSource).toContain("rawMessage.content == null ? '' : rawMessage.content");
    expect(sharedAdapterSource).not.toContain("rawMessage.content === '' ? null : rawMessage.content");
    expect(sharedAdapterBundle).toContain('rawMessage.content == null ? "" : rawMessage.content');
    expect(sharedAdapterBundle).not.toContain('rawMessage.content === "" ? null : rawMessage.content');
  });
});
