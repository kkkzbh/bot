import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('koishi-plugin-cron', () => ({}));

vi.mock('koishi-plugin-chatluna/utils/string', () => ({
  getMessageContent: (content: unknown) => (typeof content === 'string' ? content : ''),
}));

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
    h: {
      at: vi.fn((id: string) => ({ type: 'at', attrs: { id }, children: [] })),
      text: vi.fn((content: string) => ({ type: 'text', attrs: { content }, children: [] })),
    },
  };
});

import { sendBotMessageByLines } from '../src/plugins/automation/index.js';

describe('task automation outbound send', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends qqbot multiline payload as one bot message', async () => {
    const calls: Array<[string, unknown, string | undefined, unknown]> = [];
    const bot = {
      sendMessage: vi.fn(async (channelId: string, content: unknown, guildId?: string, options?: unknown) => {
        calls.push([channelId, content, guildId, options]);
        return ['msg-id'];
      }),
    };

    const receipts = await sendBotMessageByLines(bot, 'group-100', {
      mode: 'preserve',
      content: '第一行\n第二行',
    });

    expect(receipts).toEqual(['msg-id']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('group-100');
    expect(calls[0]?.[1]).toEqual({
      type: 'text',
      attrs: { content: '第一行\n第二行' },
      children: [],
    });
    expect(calls[0]?.[3]).toBeTruthy();
  });

  it('sends preserve-mode group mention as an explicit mention plus text block', async () => {
    const calls: Array<[string, unknown, string | undefined, unknown]> = [];
    const bot = {
      sendMessage: vi.fn(async (channelId: string, content: unknown, guildId?: string, options?: unknown) => {
        calls.push([channelId, content, guildId, options]);
        return ['msg-id'];
      }),
    };

    const receipts = await sendBotMessageByLines(
      bot,
      'group-100',
      {
        mode: 'preserve',
        content: '第一行\n第二行',
      },
      { mentionUserId: '123456' },
    );

    expect(receipts).toEqual(['msg-id']);
    expect(calls).toEqual([
      [
        'group-100',
        [
          { type: 'at', attrs: { id: '123456' }, children: [] },
          { type: 'text', attrs: { content: '\n第一行\n第二行' }, children: [] },
        ],
        undefined,
        expect.anything(),
      ],
    ]);
  });

  it('sends split-mode group mention only on the first line', async () => {
    vi.useFakeTimers();
    const calls: Array<[string, unknown, string | undefined, unknown]> = [];
    const bot = {
      sendMessage: vi.fn(async (channelId: string, content: unknown, guildId?: string, options?: unknown) => {
        calls.push([channelId, content, guildId, options]);
        return ['msg-id'];
      }),
    };

    const pending = sendBotMessageByLines(bot, 'group-100', '第一行\n第二行', {
      mentionUserId: '123456',
    });

    await vi.runAllTimersAsync();
    const receipts = await pending;

    expect(receipts).toEqual(['msg-id', 'msg-id']);
    expect(calls).toEqual([
      [
        'group-100',
        [
          { type: 'at', attrs: { id: '123456' }, children: [] },
          { type: 'text', attrs: { content: ' 第一行' }, children: [] },
        ],
        undefined,
        expect.anything(),
      ],
      [
        'group-100',
        { type: 'text', attrs: { content: '第二行' }, children: [] },
        undefined,
        expect.anything(),
      ],
    ]);
  });
});
