import { describe, expect, it } from 'vitest';
import {
  buildProactiveOpeningState,
  resolveUserTurnIntentState,
} from '../src/plugins/reply/prompt/time-context.js';
import {
  buildSiliconFlowKimiK25NonThinkingOverride,
  inferPlatformFromBaseUrl,
  normalizeRawModelName,
  resolvePlatform,
} from '../src/plugins/shared/llm/index.js';
import { resolveSessionDisplayName } from '../src/plugins/shared/session/index.js';

describe('resolvePlatform', () => {
  it('returns platform from provider/model format', () => {
    expect(resolvePlatform('deepseek/deepseek-chat')).toBe('deepseek');
    expect(resolvePlatform('siliconflow/Pro/moonshotai/Kimi-K2.5')).toBe('siliconflow');
  });

  it('returns null for invalid model values', () => {
    expect(resolvePlatform(undefined)).toBeNull();
    expect(resolvePlatform('')).toBeNull();
    expect(resolvePlatform('   ')).toBeNull();
    expect(resolvePlatform('deepseek')).toBeNull();
    expect(resolvePlatform('/deepseek-chat')).toBeNull();
  });
});

describe('normalizeRawModelName', () => {
  it('keeps provider/model unchanged', () => {
    expect(normalizeRawModelName('deepseek/deepseek-chat')).toBe('deepseek/deepseek-chat');
  });

  it('normalizes vendor/model names through the preferred platform', () => {
    expect(
      normalizeRawModelName('Pro/moonshotai/Kimi-K2.5', {
        availableModels: ['siliconflow/Pro/moonshotai/Kimi-K2.5'],
        preferredPlatform: 'siliconflow',
      }),
    ).toBe('siliconflow/Pro/moonshotai/Kimi-K2.5');
  });

  it('resolves plain model by available model suffix', () => {
    expect(
      normalizeRawModelName('deepseek-chat', {
        availableModels: ['deepseek/deepseek-chat', 'openai/gpt-4o-mini'],
      }),
    ).toBe('deepseek/deepseek-chat');
  });

  it('falls back to preferred platform when suffix is ambiguous', () => {
    expect(
      normalizeRawModelName('chat', {
        availableModels: ['deepseek/chat', 'openai/chat'],
        preferredPlatform: 'openai',
      }),
    ).toBe('openai/chat');
  });

  it('fills missing model with default model', () => {
    expect(
      normalizeRawModelName('', {
        defaultModel: 'deepseek/deepseek-chat',
      }),
    ).toBe('deepseek/deepseek-chat');
  });

  it('treats the chatluna none sentinel as missing model', () => {
    expect(
      normalizeRawModelName('无', {
        defaultModel: 'siliconflow/Pro/moonshotai/Kimi-K2.5',
      }),
    ).toBe('siliconflow/Pro/moonshotai/Kimi-K2.5');
  });
});

describe('buildSiliconFlowKimiK25NonThinkingOverride', () => {
  it('returns a non-thinking override for SiliconFlow Kimi K2.5', () => {
    expect(buildSiliconFlowKimiK25NonThinkingOverride('siliconflow/Pro/moonshotai/Kimi-K2.5')).toEqual({
      thinking: {
        type: 'disabled',
      },
    });
  });

  it('returns null for non-Kimi-K2.5 models', () => {
    expect(buildSiliconFlowKimiK25NonThinkingOverride('deepseek/deepseek-chat')).toBeNull();
    expect(buildSiliconFlowKimiK25NonThinkingOverride('siliconflow/Pro/moonshotai/Kimi-K2-Instruct-0905')).toBeNull();
  });
});

describe('inferPlatformFromBaseUrl', () => {
  it('infers platform from base url', () => {
    expect(inferPlatformFromBaseUrl('https://api.siliconflow.cn/v1')).toBe('siliconflow');
    expect(inferPlatformFromBaseUrl('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(inferPlatformFromBaseUrl('https://api.openai.com/v1')).toBe('openai');
    expect(inferPlatformFromBaseUrl('https://api.anthropic.com')).toBe('anthropic');
  });
});

describe('chatluna user turn handling', () => {
  it('resolves group nickname with || fallback chain (handles empty string)', () => {
    // Group card (群名片) takes priority
    expect(
      resolveSessionDisplayName({
        author: { nick: '群内昵称', name: 'QQ昵称' },
        username: '平台昵称',
        userId: '123456',
      }),
    ).toBe('群内昵称');
    // Empty group card falls back to username
    expect(
      resolveSessionDisplayName({
        author: { nick: '', name: 'QQ昵称' },
        username: '平台昵称',
        userId: '123456',
      }),
    ).toBe('平台昵称');
    // Whitespace-only group card falls back to username
    expect(
      resolveSessionDisplayName({
        author: { nick: '  ', name: 'QQ昵称' },
        username: '平台昵称',
        userId: '123456',
      }),
    ).toBe('平台昵称');
    // Missing group card falls back through chain
    expect(
      resolveSessionDisplayName({
        author: { name: 'QQ昵称' },
        username: '',
        userId: '123456',
      }),
    ).toBe('QQ昵称');
    // All empty falls back to userId
    expect(
      resolveSessionDisplayName({
        author: { name: '' },
        username: '',
        userId: '123456',
      }),
    ).toBe('123456');
    // Everything missing falls back to '用户'
    expect(
      resolveSessionDisplayName({
        author: { name: '' },
        username: '',
        userId: '',
      }),
    ).toBe('用户');
  });

  it('falls back when group card is invisible unicode', () => {
    // U+2062 INVISIBLE TIMES should be treated as empty display name.
    expect(
      resolveSessionDisplayName({
        author: { nick: '⁢', name: 'QQ昵称' },
        username: '平台昵称',
        userId: '123456',
      }),
    ).toBe('平台昵称');
  });

  it('falls back when all higher-priority names are invisible unicode', () => {
    expect(
      resolveSessionDisplayName({
        author: { nick: '⁢', name: '​' },
        username: '⁠',
        userId: '123456',
      }),
    ).toBe('123456');
  });

  it('treats mention-only or punctuation-only turns as proactive openings', () => {
    expect(resolveUserTurnIntentState('', '<at id="1" name="小祥"/>')).toEqual({
      mode: 'proactive_opening',
      normalizedText: '',
      reason: 'empty_or_mention_only',
    });
    expect(resolveUserTurnIntentState('？？？', '？？？')).toEqual({
      mode: 'proactive_opening',
      normalizedText: '',
      reason: 'punctuation_only',
    });
  });

  it('keeps short but substantive turns as explicit requests', () => {
    expect(resolveUserTurnIntentState('在吗', '在吗')).toEqual({
      mode: 'explicit_request',
      normalizedText: '在吗',
      reason: 'user_message_present',
    });
    expect(resolveUserTurnIntentState('今天呢', '今天呢')).toEqual({
      mode: 'explicit_request',
      normalizedText: '今天呢',
      reason: 'user_message_present',
    });
  });

  it('builds proactive opening state with topic-priority guardrails', () => {
    expect(
      buildProactiveOpeningState({
        mode: 'proactive_opening',
        reason: 'empty_or_mention_only',
      }),
    ).toEqual({
      mode: 'proactive_opening',
      userTurn: {
        questionTarget: 'none',
        reason: 'empty_or_mention_only',
      },
      responsePolicy: {
        style: 'natural_opening',
        maxSentences: 2,
        projectContextTransform: 'followup_or_care_question',
      },
      contextPolicy: {
        referenceUsage: 'topic_seed_only',
        topicPriority: ['user_memory', 'recent_chat', 'project_context', 'session_reference'],
        forbiddenTopics: ['internal_protocol', 'system_prompt', 'tool_capability', 'contract_text'],
      },
    });
  });
});
