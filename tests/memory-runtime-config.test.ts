import { describe, expect, it } from 'vitest';
import { buildMemoryExtractProviderProfile } from '../src/plugins/memory/providers/router.js';
import { resolveMainChatRuntimeProfileFromEnv } from '../src/plugins/shared/llm/main-chat-tabs.js';

describe('memory runtime config', () => {
  it('uses the main chat provider only when extract provider fields are all empty', () => {
    const mainProfile = resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'copilot',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'copilot-key',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'gpt-5.4-mini',
    });

    const profile = buildMemoryExtractProviderProfile(mainProfile);

    expect(profile).toMatchObject({
      baseUrl: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      apiKey: 'copilot-key',
      model: 'gpt-5.4-mini',
    });
  });

  it('does not mix partial extract provider fields with the main chat provider', () => {
    const mainProfile = resolveMainChatRuntimeProfileFromEnv({
      CHATLUNA_ACTIVE_TAB: 'copilot',
      CHATLUNA_COPILOT_BASE_URL: 'http://127.0.0.1:5140/api/internal/copilot/v1',
      CHATLUNA_COPILOT_API_KEY: 'copilot-key',
      CHATLUNA_COPILOT_DEFAULT_MODEL: 'gpt-5.4-mini',
    });

    const profile = buildMemoryExtractProviderProfile(mainProfile, {
      apiKey: 'extract-key',
    });

    expect(profile).toMatchObject({
      baseUrl: '',
      apiKey: 'extract-key',
      model: '',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'chat_reply_v1',
    });
  });
});
