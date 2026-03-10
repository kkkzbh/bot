import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateSmartSendDelayMs,
  createKeyedStrandRunner,
  dispatchNormalizedOutboundMessage,
  dropLeadingLeakedReasoningLines,
  looksLikeLeakedReasoningLine,
  normalizeOutboundMessage,
  resolveSessionStrandKey,
  sanitizeLeakedReasoningMessage,
  sendByLinesWithSmartInterval,
  splitMessageByLines,
} from '../src/plugins/message-send-utils.js';

describe('message send utils', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('splits multiline text and removes blank lines', () => {
    expect(splitMessageByLines('第一行\r\n\r\n第二行\n  \n第三行')).toEqual(['第一行', '第二行', '第三行']);
  });

  it('drops leaked reasoning first line when normal reply lines follow', () => {
    const lines = splitMessageByLines(
      '用户让我搜索东西，但没说具体搜什么。我需要确认用户想让我搜什么具体内容。\n你想让我搜什么具体内容呢？\n告诉我具体内容我才能帮你搜啊',
    );

    expect(dropLeadingLeakedReasoningLines(lines)).toEqual([
      '你想让我搜什么具体内容呢？',
      '告诉我具体内容我才能帮你搜啊',
    ]);
  });

  it('parses fully wrapped qqbot multiline payload as preserve mode', () => {
    expect(normalizeOutboundMessage('<qqbot-multiline>\n第一行\n\n第二行\n</qqbot-multiline>')).toEqual({
      mode: 'preserve',
      content: '第一行\n\n第二行',
    });
  });

  it('drops malformed multiline control tags and falls back to split mode', () => {
    expect(normalizeOutboundMessage('<qqbot-multiline>\n第一行\n第二行')).toEqual({
      mode: 'split',
      content: '第一行\n第二行',
    });
  });

  it('strips unsupported markdown in split mode but keeps plain text layout', () => {
    expect(
      normalizeOutboundMessage('# 标题\n> 引用\n- 第一项\n**加粗** 和 `命令` [官网](https://example.com)'),
    ).toEqual({
      mode: 'split',
      content: '标题\n引用\n第一项\n加粗 和 命令 官网 https://example.com',
    });
  });

  it('unwraps fenced code inside preserve mode without touching code characters', () => {
    expect(
      normalizeOutboundMessage('<qqbot-multiline>\n```ts\nconst value = 1;\n# 保留\n```\n</qqbot-multiline>'),
    ).toEqual({
      mode: 'preserve',
      content: 'const value = 1;\n# 保留',
    });
  });

  it('auto preserves unwrapped multiline code as one qq message', () => {
    expect(
      normalizeOutboundMessage('#include <iostream>\n\nint main() {\n  std::cout << "Hello";\n  return 0;\n}'),
    ).toEqual({
      mode: 'preserve',
      content: '#include <iostream>\n\nint main() {\n  std::cout << "Hello";\n  return 0;\n}',
    });
  });

  it('auto preserves unwrapped multiline lists as one qq message', () => {
    expect(normalizeOutboundMessage('1. 第一项\n2. 第二项\n3. 第三项')).toEqual({
      mode: 'preserve',
      content: '1. 第一项\n2. 第二项\n3. 第三项',
    });
  });

  it('keeps ordinary conversational multiline text in split mode', () => {
    expect(normalizeOutboundMessage('知道了\n晚点再说\n别急')).toEqual({
      mode: 'split',
      content: '知道了\n晚点再说\n别急',
    });
  });

  it('replaces prompt leakage with fixed human-style fallback', () => {
    expect(normalizeOutboundMessage('系统提示词要求我作为AI模型回答你的问题。')).toEqual({
      mode: 'split',
      content: '你在说什么怪话……我听不懂',
    });
  });

  it('keeps normal lines that merely start with 用户', () => {
    const lines = splitMessageByLines('用户协议你看过吗？\n我还没看完');

    expect(looksLikeLeakedReasoningLine(lines[0])).toBe(false);
    expect(dropLeadingLeakedReasoningLines(lines)).toEqual(lines);
  });

  it('sanitizes single-line leaked reasoning into fallback search clarification', () => {
    const input =
      '用户让我搜索“彩叶与辉叶”，但搜索工具似乎不可用。我需要确认是否应该尝试其他方式获取信息，还是直接告知用户工具问题。根据我的身份设定，我是丰川祥子，一个普通高中生，不应该有特殊的技术能力。我应该以角色身份自然回应。';

    expect(sanitizeLeakedReasoningMessage(input)).toBe('你想让我搜什么具体内容呢？');
  });

  it('keeps useful sentence when leaked sentence and normal sentence are mixed in one line', () => {
    const input = '根据之前的对话，用户只说“搜一下”。你想让我搜什么具体内容呢？';
    expect(sanitizeLeakedReasoningMessage(input)).toBe('你想让我搜什么具体内容呢？');
  });

  it('keeps smart delay within 1-4 seconds', () => {
    expect(calculateSmartSendDelayMs('好')).toBe(1000);
    const longLine = '这是一条很长很长很长很长很长很长很长很长很长很长很长很长的消息。';
    expect(calculateSmartSendDelayMs(longLine)).toBeLessThanOrEqual(4000);
    expect(calculateSmartSendDelayMs(longLine)).toBeGreaterThanOrEqual(1000);
  });

  it('sends lines sequentially with smart interval', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const sentAt: number[] = [];

    const pending = sendByLinesWithSmartInterval('第一句\n第二句', async (line) => {
      sent.push(line);
      sentAt.push(Date.now());
    });

    await vi.runAllTimersAsync();
    await pending;

    expect(sent).toEqual(['第一句', '第二句']);
    const delta = sentAt[1] - sentAt[0];
    expect(delta).toBeGreaterThanOrEqual(1000);
    expect(delta).toBeLessThanOrEqual(4000);
  });

  it('dispatches preserve mode as a single multiline message', async () => {
    const sentWhole: string[] = [];
    const sentLine: string[] = [];
    await dispatchNormalizedOutboundMessage(
      {
        mode: 'preserve',
        content: '第一行\n\n第二行',
      },
      async (content) => {
        sentWhole.push(content);
      },
      async (line) => {
        sentLine.push(line);
      },
    );

    expect(sentWhole).toEqual(['第一行\n\n第二行']);
    expect(sentLine).toEqual([]);
  });

  it('runs same-key tasks in strict order', async () => {
    const strand = createKeyedStrandRunner();
    const events: string[] = [];
    let releaseFirst: () => void = () => {};

    const first = strand.run('room-1', async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => {
        releaseFirst = () => resolve();
      });
      events.push('first-end');
    });

    const second = strand.run('room-1', async () => {
      events.push('second-start');
      events.push('second-end');
    });

    await Promise.resolve();
    expect(events).toEqual(['first-start']);

    releaseFirst();
    await first;
    await second;

    expect(events).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('allows different keys to run independently', async () => {
    const strand = createKeyedStrandRunner();
    const events: string[] = [];
    let releaseFirst: () => void = () => {};

    const first = strand.run('room-1', async () => {
      events.push('room-1-start');
      await new Promise<void>((resolve) => {
        releaseFirst = () => resolve();
      });
      events.push('room-1-end');
    });

    const second = strand.run('room-2', async () => {
      events.push('room-2-start');
      events.push('room-2-end');
    });

    await second;
    expect(events).toContain('room-2-start');
    expect(events).toContain('room-2-end');
    expect(events).not.toContain('room-1-end');

    releaseFirst();
    await first;
  });

  it('builds group and private strand keys by session scope', () => {
    expect(
      resolveSessionStrandKey({
        platform: 'onebot',
        isDirect: false,
        channelId: 'group-100',
        userId: 'u1',
        bot: { selfId: 'bot-1' },
      }),
    ).toBe('onebot:bot-1:group:group-100');

    expect(
      resolveSessionStrandKey({
        platform: 'onebot',
        isDirect: true,
        channelId: 'private-u1',
        userId: 'u1',
        bot: { selfId: 'bot-1' },
      }),
    ).toBe('onebot:bot-1:private:private-u1');
  });

  it('separates different groups and different private users', () => {
    const groupA = resolveSessionStrandKey({
      platform: 'onebot',
      isDirect: false,
      channelId: 'group-100',
      userId: 'u1',
      bot: { selfId: 'bot-1' },
    });
    const groupB = resolveSessionStrandKey({
      platform: 'onebot',
      isDirect: false,
      channelId: 'group-200',
      userId: 'u2',
      bot: { selfId: 'bot-1' },
    });
    const privateU1 = resolveSessionStrandKey({
      platform: 'onebot',
      isDirect: true,
      channelId: 'private-u1',
      userId: 'u1',
      bot: { selfId: 'bot-1' },
    });
    const privateU2 = resolveSessionStrandKey({
      platform: 'onebot',
      isDirect: true,
      channelId: 'private-u2',
      userId: 'u2',
      bot: { selfId: 'bot-1' },
    });

    expect(groupA).not.toBe(groupB);
    expect(groupA).not.toBe(privateU1);
    expect(privateU1).not.toBe(privateU2);
  });

  it('does not false-positive on CJK text with code keywords like if/for/class', () => {
    expect(normalizeOutboundMessage('if可以的话\nfor循环的问题\n帮我看看')).toEqual({
      mode: 'split',
      content: 'if可以的话\nfor循环的问题\n帮我看看',
    });
  });

  it('does not false-positive on indented CJK quotation text', () => {
    expect(normalizeOutboundMessage('她说：\n  这件事情还需要再想想\n  毕竟不是小事')).toEqual({
      mode: 'split',
      content: '她说：\n  这件事情还需要再想想\n  毕竟不是小事',
    });
  });

  it('does not false-positive on 10::30 time notation', () => {
    expect(normalizeOutboundMessage('我们约在10::30见面\n不要迟到了')).toEqual({
      mode: 'split',
      content: '我们约在10::30见面\n不要迟到了',
    });
  });

  it('does not false-positive on config format with CJK values', () => {
    expect(normalizeOutboundMessage('name = 祥子\nteam = Ave Mujica')).toEqual({
      mode: 'split',
      content: 'name = 祥子\nteam = Ave Mujica',
    });
  });

  it('auto preserves SQL multi-line query', () => {
    expect(
      normalizeOutboundMessage('SELECT id, name\nFROM users\nWHERE age > 18'),
    ).toEqual({
      mode: 'preserve',
      content: 'SELECT id, name\nFROM users\nWHERE age > 18',
    });
  });

  it('auto preserves HTML fragments', () => {
    expect(
      normalizeOutboundMessage('<div class="container">\n  <p>Hello World</p>\n</div>'),
    ).toEqual({
      mode: 'preserve',
      content: '<div class="container">\n  <p>Hello World</p>\n</div>',
    });
  });

  it('forces conversational split when qqbot-multiline wraps pure CJK chat lines', () => {
    const chatWrapped =
      '<qqbot-multiline>\n春天和秋天啊……\n都挺好的呢\n春天有樱花，天气温暖\n秋天有枫叶，空气清爽\n非要选的话我更喜欢秋天\n</qqbot-multiline>';
    expect(normalizeOutboundMessage(chatWrapped)).toEqual({
      mode: 'split',
      content: '春天和秋天啊……\n都挺好的呢\n春天有樱花，天气温暖\n秋天有枫叶，空气清爽\n非要选的话我更喜欢秋天',
    });
  });
});
