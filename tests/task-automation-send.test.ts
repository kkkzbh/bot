import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi-plugin-cron', () => ({}));

vi.mock('koishi', () => {
  class MockLogger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: vi.fn(() => ({ description: vi.fn() })),
      union: vi.fn(() => ({ description: vi.fn(), default: vi.fn(() => ({ description: vi.fn() })) })),
      array: vi.fn(() => ({ role: vi.fn(() => ({ description: vi.fn() })) })),
      string: vi.fn(() => ({
        description: vi.fn(),
        role: vi.fn(() => ({ description: vi.fn() })),
        default: vi.fn(() => ({ description: vi.fn() })),
      })),
      boolean: vi.fn(() => ({ default: vi.fn(() => ({ description: vi.fn() })) })),
      number: vi.fn(() => ({
        min: vi.fn(() => ({
          max: vi.fn(() => ({
            default: vi.fn(() => ({ description: vi.fn() })),
          })),
        })),
      })),
      natural: vi.fn(() => ({
        default: vi.fn(() => ({ description: vi.fn(), role: vi.fn(() => ({ default: vi.fn(() => ({ description: vi.fn() })) })) })),
        role: vi.fn(() => ({ default: vi.fn(() => ({ description: vi.fn() })) })),
      })),
      const: vi.fn(() => ({})),
    },
    Session: class {},
    h: { at: vi.fn((id: string) => `@${id}`) },
  };
});

import { normalizeOutboundMessage } from '../src/plugins/shared/outbound/index.js';
import { prependGroupMention, sendBotMessageByLines } from '../src/plugins/automation/index.js';

describe('task automation outbound send', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends qqbot multiline payload as one bot message', async () => {
    const calls: Array<[string, string, string | undefined, unknown]> = [];
    const bot = {
      sendMessage: vi.fn(async (channelId: string, content: string, guildId?: string, options?: unknown) => {
        calls.push([channelId, content, guildId, options]);
        return ['msg-id'];
      }),
    };

    await sendBotMessageByLines(bot, 'group-100', {
      mode: 'preserve',
      content: '第一行\n第二行',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('group-100');
    expect(calls[0]?.[1]).toBe('第一行\n第二行');
    expect(calls[0]?.[3]).toBeTruthy();
  });

  it('puts group mention on its own first line for preserve mode', () => {
    expect(prependGroupMention({ mode: 'preserve', content: '第一行\n第二行' }, '@123456')).toEqual({
      mode: 'preserve',
      content: '@123456\n第一行\n第二行',
    });
  });

  it('keeps split-mode group mention on the first line with a space', () => {
    expect(prependGroupMention(normalizeOutboundMessage('第一行\n第二行'), '@123456')).toEqual({
      mode: 'split',
      content: '@123456 第一行\n第二行',
    });
  });
});
