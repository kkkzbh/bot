import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReplyPromptCompilerInput, compileReplyPromptEnvelope } from '../src/plugins/reply/prompt/compiler.js';
import {
  beginPromptAssemblyTurn,
  clearPromptAssemblyTurn,
  compilePromptEnvelope,
  registerPromptFragment,
} from '../src/plugins/shared/prompt-context/index.js';
import { resolveChatlunaSiblingPackageRoot, resolveChatlunaSourceRoot } from './helpers/chatluna-paths.js';

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

  it('builds agent reply prompt messages without legacy finish-tool protocol text', () => {
    const envelope = compileReplyPromptEnvelope(
      buildReplyPromptCompilerInput(
        {
          input: {
            text: '只回复一句',
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
              value: '现在是晚上',
            },
          },
        ],
      ),
    );

    expect(envelope?.messages.every((message) => message.role === 'system')).toBe(true);
    expect(envelope?.messages.some((message) => String(message.content).includes('submit_reply_plan'))).toBe(false);
    expect(envelope?.messages.some((message) => String(message.content).includes('submit_working_state'))).toBe(false);
    expect(envelope?.messages.some((message) => String(message.content).includes('qqbot_reply_chat_style'))).toBe(false);
  });

  it('uses a chatluna build without pseudo natural-language after_user_message injection', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const builtEntry = readFileSync(join(packageRoot, 'lib/index.cjs'), 'utf8');

    expect(builtEntry).toContain('requests["after_user_message"] = afterUserMessage');
    expect(builtEntry).toContain('qqbot_after_user_message');
    expect(builtEntry).not.toContain('AGENT_AFTER_USER_PROMPT');
    expect(builtEntry).not.toContain('Respond naturally according to your system prompt');
  });

  it('keeps finishContract wired through plugin chat chain construction', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const pluginChainSource = readFileSync(join(packageRoot, 'src/llm-core/chain/plugin_chat_chain.ts'), 'utf8');

    expect(pluginChainSource).toContain('finishContract');
    expect(pluginChainSource).toContain('finishContract: this.finishContract');
    expect(pluginChainSource).toContain('ensureToolMaskAllows');
    expect(pluginChainSource).toContain('toolMask,');
    expect(pluginChainSource).toContain('toolMask,\n            finishContract');
  });

  it('removes the legacy reply_plan module and switches executor to the final response contract', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const executorSource = readFileSync(join(packageRoot, 'src/llm-core/agent/executor.ts'), 'utf8');

    expect(existsSync(join(packageRoot, 'src/llm-core/agent/reply_plan.ts'))).toBe(false);
    expect(executorSource).not.toContain('finishContract.maxRetries');
    expect(executorSource).not.toContain('finishContract.retryMessage');
    expect(executorSource).toContain("type: 'json_schema'");
    expect(executorSource).toContain('qqbot_final_response_contract');
  });

  it('removes plugin chat chain whole-turn retry loop', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const pluginChainSource = readFileSync(join(packageRoot, 'src/llm-core/chain/plugin_chat_chain.ts'), 'utf8');
    const builtEntry = readFileSync(join(packageRoot, 'lib/index.cjs'), 'utf8');

    expect(pluginChainSource).not.toContain('for (let i = 0; i < 3; i++)');
    expect(pluginChainSource).toContain('response = await request()');
    expect(builtEntry).not.toContain('for (let i = 0; i < 3; i++)');
    expect(builtEntry).toContain('response = await request2();');
  });

  it('wires the reply output contract through the plugin request path', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const pluginChainSource = readFileSync(join(packageRoot, 'src/llm-core/chain/plugin_chat_chain.ts'), 'utf8');
    const executorSource = readFileSync(join(packageRoot, 'src/llm-core/agent/executor.ts'), 'utf8');

    expect(pluginChainSource).toContain("requests['qqbot_final_response_contract'] = finalResponseContract");
    expect(executorSource).toContain("type: 'json_schema'");
    expect(executorSource).toContain('buildFinalResponseOverrideRequestParams');
    expect(executorSource).toContain('mergeFinalResponseInstructionAfterUserMessage');
    expect(executorSource).toContain('new SystemMessage(normalizedInstruction)');
    expect(executorSource).not.toContain('buildFinalResponseMessage');
    expect(executorSource).not.toContain("tool_choice: 'none'");
    expect(executorSource).not.toContain('finalResponseMode');
    expect(executorSource).toContain('buildAgentPlanningConfig');
    expect(executorSource).toContain('const planConfig = buildAgentPlanningConfig(input, config)');
    expect(executorSource).toContain('overrideRequestParams');
  });

  it('keeps provider-aware structured reply request overrides wired into the reply chain', () => {
    const generationSource = readFileSync(join(process.cwd(), 'src/plugins/reply/voice/generation.ts'), 'utf8');

    expect(generationSource).toContain('buildReplyOutputContract');
    expect(generationSource).toContain('mergeReplyOverrideRequestParams');
    expect(generationSource).toContain('overrideRequestParams');
  });

  it('keeps the linked OpenAI-like adapter wired for responses mode when requested by qqbot', () => {
    const sharedAdapterRoot = resolveChatlunaSiblingPackageRoot('shared-adapter');
    const openAiAdapterRoot = resolveChatlunaSiblingPackageRoot('adapter-openai-like');
    const sharedAdapterRequesterSource = readFileSync(join(sharedAdapterRoot, 'src', 'requester.ts'), 'utf8');
    const openAIRequesterSource = readFileSync(join(openAiAdapterRoot, 'src', 'requester.ts'), 'utf8');

    expect(sharedAdapterRequesterSource).toContain("override['qqbot_request_mode'] === 'responses'");
    expect(sharedAdapterRequesterSource).toContain("completionUrl: string = 'responses'");
    expect(sharedAdapterRequesterSource).toContain('sanitizeOverrideRequestParams');
    expect(sharedAdapterRequesterSource).toContain("key.startsWith('qqbot_')");
    expect(openAIRequesterSource).toContain("params.overrideRequestParams['qqbot_request_mode'] === 'responses'");
    expect(openAIRequesterSource).toContain("completionResponses(");
  });

  it('uses a chatluna context manager build that accepts plain prompt message objects', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const contextManagerSource = readFileSync(join(packageRoot, 'src/llm-core/prompt/context_manager.ts'), 'utf8');

    expect(contextManagerSource).toContain('interface PlainPromptMessage');
    expect(contextManagerSource).toContain('isPlainPromptMessage');
    expect(contextManagerSource).toContain('createMessageFromPlainObject');
  });

  it('suppresses tool call thought rendering in qqbot agent reply mode', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const requestModelSource = readFileSync(join(packageRoot, 'src/middlewares/model/request_model.ts'), 'utf8');

    expect(requestModelSource).toContain("context.options.inputMessage?.additional_kwargs?.qqbot_reply_mode ===");
    expect(requestModelSource).toContain("'agent'");
    expect(requestModelSource).toContain('return');
  });

  it('keeps reply request_model cleanup hooks wired through the request path', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const requestModelSource = readFileSync(join(packageRoot, 'src/middlewares/model/request_model.ts'), 'utf8');
    const generationSource = readFileSync(join(process.cwd(), 'src/plugins/reply/voice/generation.ts'), 'utf8');

    expect(requestModelSource).toContain('maybeHandleReplyRequestModelError');
    expect(requestModelSource).toContain('handleRequestModelError');
    expect(generationSource).toContain('registerReplyRunRequestModelGuard');
    expect(generationSource).toContain('suppressReplyErrorNotice(session);');
    expect(generationSource).toContain('setReplyRequestModelErrorHandler(session, undefined);');
  });

  it('keeps multimodal content structured through request_model and shared-adapter boundaries', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const sharedAdapterRoot = resolveChatlunaSiblingPackageRoot('shared-adapter');
    const readChatMessageSource = readFileSync(join(packageRoot, 'src/middlewares/chat/read_chat_message.ts'), 'utf8');
    const requestModelSource = readFileSync(join(packageRoot, 'src/middlewares/model/request_model.ts'), 'utf8');
    const chatServiceSource = readFileSync(join(packageRoot, 'src/services/chat.ts'), 'utf8');
    const sharedAdapterSource = readFileSync(join(sharedAdapterRoot, 'src', 'utils.ts'), 'utf8');
    const sharedAdapterRequesterSource = readFileSync(join(sharedAdapterRoot, 'src', 'requester.ts'), 'utf8');

    expect(readChatMessageSource).toContain("url.startsWith('base64://')");
    expect(readChatMessageSource).toContain("data:${ext ?? 'image/jpeg'};base64,${base64}");
    expect(requestModelSource).toContain('qqbot_input_content_meta');
    expect(requestModelSource).toContain('ensureImageContentIntegrity');
    expect(requestModelSource).toContain('originContent.map(async (message) =>');
    expect(requestModelSource).not.toContain('sortContentByType(');
    expect(chatServiceSource).toContain('ensureMessageImageIntegrity(message)');
    expect(sharedAdapterSource).toContain("detail: 'high'");
    expect(sharedAdapterSource).not.toContain("detail: 'low'");
    expect(sharedAdapterRequesterSource).toContain('summarizeLastUserMessage');
    expect(sharedAdapterRequesterSource).toContain('hasImageUrl');
  });

  it('keeps tool-call history content as strings for OpenAI-compatible request payloads', () => {
    const sharedAdapterRoot = resolveChatlunaSiblingPackageRoot('shared-adapter');
    const sharedAdapterSource = readFileSync(join(sharedAdapterRoot, 'src', 'utils.ts'), 'utf8');
    const sharedAdapterBundle = readFileSync(join(sharedAdapterRoot, 'lib', 'index.mjs'), 'utf8');

    expect(sharedAdapterSource).toContain("rawMessage.content == null ? '' : rawMessage.content");
    expect(sharedAdapterSource).not.toContain("rawMessage.content === '' ? null : rawMessage.content");
    expect(sharedAdapterBundle).toContain('rawMessage.content == null ? "" : rawMessage.content');
    expect(sharedAdapterBundle).not.toContain('rawMessage.content === "" ? null : rawMessage.content');
  });

  it('keeps research history normalization bundle aligned with AIMessage imports', () => {
    const packageRoot = resolveChatlunaSourceRoot();
    const messageHistoryBundle = readFileSync(
      join(packageRoot, 'lib', 'llm-core', 'memory', 'message', 'index.cjs'),
      'utf8',
    );

    expect(messageHistoryBundle).toMatch(/new import_messages\d*\.AIMessage\(normalizedText2\)/);
  });
});
