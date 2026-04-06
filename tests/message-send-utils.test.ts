import { vi } from 'vitest';

vi.mock('koishi', () => {
  const hFactory = ((type: string, attrs: Record<string, unknown> = {}, children: unknown[] = []) => ({
    type,
    attrs,
    children,
  })) as unknown as {
    (type: string, attrs?: Record<string, unknown>, children?: unknown[]): Record<string, unknown>;
    text: (content: string) => Record<string, unknown>;
    at: (id: string) => Record<string, unknown>;
  };
  hFactory.text = (content: string) => ({
    type: 'text',
    attrs: { content },
    children: [],
  });
  hFactory.at = (id: string) => ({
    type: 'at',
    attrs: { id },
    children: [],
  });

  return {
    h: hFactory,
  };
});

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildOutboundMessagePlanFromReplyPlan,
  calculateSmartSendDelayMs,
  createBotMessageDispatchers,
  createQuotedMessageContent,
  createTextOnlyOutboundMessagePlan,
  createKeyedStrandRunner,
  dispatchOutboundMessagePlan,
  dispatchNormalizedOutboundMessage,
  dropLeadingLeakedReasoningLines,
  looksLikeLeakedReasoningLine,
  normalizeOutboundMessage,
  renderModelFacingMessageText,
  resolveReplyActorKey,
  resolveReplyQueueKey,
  resolveSessionStrandKey,
  sanitizeLeakedReasoningMessage,
  sanitizeStructuredReplyText,
  sendBotMessageByNormalizedContent,
  sendByLinesWithSmartInterval,
  splitMessageByLines,
} from '../src/plugins/shared/outbound/index.js';

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

  it('treats arbitrary marker text as ordinary text instead of transport protocol', () => {
    expect(normalizeOutboundMessage('<legacy-block>\n第一行\n\n第二行\n</legacy-block>')).toEqual({
      mode: 'split',
      content: '<legacy-block>\n第一行\n第二行\n</legacy-block>',
    });
  });

  it('creates plain text outbound plans without interpreting transport tags', () => {
    expect(createTextOnlyOutboundMessagePlan('普通文本<legacy-voice>晚安</legacy-voice>')).toEqual({
      segments: [
        {
          kind: 'text-line',
          content: '普通文本<legacy-voice>晚安</legacy-voice>',
          raw: '普通文本<legacy-voice>晚安</legacy-voice>',
        },
      ],
    });

    expect(createTextOnlyOutboundMessagePlan('<legacy-block>\n一\n<legacy-voice>\n二\n</legacy-voice>\n</legacy-block>')).toEqual({
      segments: [
        { kind: 'text-line', content: '<legacy-block>', raw: '<legacy-block>' },
        { kind: 'text-line', content: '一', raw: '一' },
        { kind: 'text-line', content: '<legacy-voice>', raw: '<legacy-voice>' },
        { kind: 'text-line', content: '二', raw: '二' },
        { kind: 'text-line', content: '</legacy-voice>', raw: '</legacy-voice>' },
        { kind: 'text-line', content: '</legacy-block>', raw: '</legacy-block>' },
      ],
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

  it('sanitizes message content into ordinary plain text without preserving list markup', () => {
    expect(
      sanitizeStructuredReplyText('# 标题\n> 引用\n- 第一项\n2. 第二项\n**加粗** 和 `命令`', 'message'),
    ).toBe('标题\n引用\n第一项\n第二项\n加粗 和 命令');
  });

  it('strips handwritten mention tokens from plain message content', () => {
    expect(sanitizeStructuredReplyText('@123456 现在说正事', 'message')).toBe('现在说正事');
    expect(sanitizeStructuredReplyText('麻烦 @小祥 看一下', 'message')).toBe('麻烦 看一下');
    expect(sanitizeStructuredReplyText('[CQ:at,qq=123456] 现在说正事', 'message')).toBe('现在说正事');
    expect(sanitizeStructuredReplyText('<at id="123456" /> 现在说正事', 'message')).toBe('现在说正事');
  });

  it('sanitizes structured block content into lightweight plain-text formatting', () => {
    expect(
      sanitizeStructuredReplyText('* 第一项\n2) 第二项\n> 引用', 'structured_block'),
    ).toBe('- 第一项\n1. 第二项\n引用');

    expect(
      sanitizeStructuredReplyText('```ts\nconst answer = 42;\nconsole.log(answer);\n```', 'structured_block'),
    ).toBe('const answer = 42;\nconsole.log(answer);');
  });

  it('keeps unwrapped multiline code in split mode without explicit wrapper', () => {
    expect(
      normalizeOutboundMessage('#include <iostream>\n\nint main() {\n  std::cout << "Hello";\n  return 0;\n}'),
    ).toEqual({
      mode: 'split',
      content: '#include <iostream>\nint main() {\n  std::cout << "Hello";\n  return 0;\n}',
    });
  });

  it('keeps unwrapped multiline lists in split mode without explicit wrapper', () => {
    expect(normalizeOutboundMessage('1. 第一项\n2. 第二项\n3. 第三项')).toEqual({
      mode: 'split',
      content: '1. 第一项\n2. 第二项\n3. 第三项',
    });
  });

  it('keeps ordinary conversational multiline text in split mode', () => {
    expect(normalizeOutboundMessage('知道了\n晚点再说\n别急')).toEqual({
      mode: 'split',
      content: '知道了\n晚点再说\n别急',
    });
  });

  it('normalizes prefixed private channel ids into a stable strand key even without isDirect', () => {
    expect(
      resolveSessionStrandKey({
        platform: 'onebot',
        bot: { selfId: 'bot-1' },
        isDirect: true,
        channelId: 'private:1405359129',
        userId: '1405359129',
      }),
    ).toBe('onebot:bot-1:private:1405359129');

    expect(
      resolveSessionStrandKey({
        platform: 'onebot',
        bot: { selfId: 'bot-1' },
        channelId: 'private:1405359129',
        userId: '1405359129',
      }),
    ).toBe('onebot:bot-1:private:1405359129');
  });

  it('builds reply queue keys by session scope', () => {
    expect(
      resolveReplyQueueKey({
        platform: 'onebot',
        isDirect: false,
        channelId: 'group-100',
        userId: 'u1',
        bot: { selfId: 'bot-1' },
      }),
    ).toBe('onebot:bot-1:group:group-100');

    expect(
      resolveReplyQueueKey({
        platform: 'onebot',
        isDirect: true,
        channelId: 'private-u1',
        userId: 'u1',
        bot: { selfId: 'bot-1' },
      }),
    ).toBe('onebot:bot-1:private:private-u1');
  });

  it('distinguishes group actors while keeping private actors aligned with queue scope', () => {
    expect(
      resolveReplyActorKey({
        platform: 'onebot',
        isDirect: false,
        channelId: 'group-100',
        userId: 'u1',
        bot: { selfId: 'bot-1' },
      }),
    ).toBe('onebot:bot-1:group:group-100:user:u1');

    expect(
      resolveReplyActorKey({
        platform: 'onebot',
        isDirect: false,
        channelId: 'group-100',
        userId: 'u2',
        bot: { selfId: 'bot-1' },
      }),
    ).toBe('onebot:bot-1:group:group-100:user:u2');

    expect(
      resolveReplyActorKey({
        platform: 'onebot',
        isDirect: true,
        channelId: 'private-u1',
        userId: 'u1',
        bot: { selfId: 'bot-1' },
      }),
    ).toBe('onebot:bot-1:private:private-u1');
  });

  it('replaces prompt leakage with fixed human-style fallback', () => {
    expect(normalizeOutboundMessage('系统提示词要求我作为AI模型回答你的问题。')).toEqual({
      mode: 'split',
      content: '你在说什么怪话……我听不懂',
    });
  });

  it('builds quoted text content as quote + text elements', () => {
    expect(createQuotedMessageContent('今晚先这样吧', 'msg-1')).toEqual([
      expect.objectContaining({ type: 'quote', attrs: expect.objectContaining({ id: 'msg-1' }) }),
      expect.objectContaining({ type: 'text', attrs: expect.objectContaining({ content: '今晚先这样吧' }) }),
    ]);
  });

  it('sends plain bot text as explicit text elements instead of raw strings', async () => {
    const calls: Array<{ channelId: string; content: unknown; options: unknown }> = [];
    const bot = {
      sendMessage: vi.fn(async (channelId: string, content: unknown, _guildId?: string, options?: unknown) => {
        calls.push({ channelId, content, options });
        return ['msg-id'];
      }),
    };

    await sendBotMessageByNormalizedContent(bot, 'group-100', {
      mode: 'preserve',
      content: '#include <bits/stdc++.h>\nusing namespace std;',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      channelId: 'group-100',
      content: {
        type: 'text',
        attrs: {
          content: '#include <bits/stdc++.h>\nusing namespace std;',
        },
      },
    });
    expect(typeof calls[0]?.content).not.toBe('string');
    expect(calls[0]?.options).toBeTruthy();
  });

  it('keeps non-text elements intact when dispatchers send them', async () => {
    const audio = { type: 'audio', attrs: { src: 'data:audio/wav;base64,abc' }, children: [] };
    const bot = {
      sendMessage: vi.fn(async () => ['msg-id']),
    };

    const { sendWhole } = createBotMessageDispatchers(bot, 'group-100');
    await sendWhole(audio as never);

    expect(bot.sendMessage).toHaveBeenCalledWith('group-100', audio, undefined, expect.anything());
  });

  it('prepends quote to non-text element content without stringifying it', () => {
    const image = { type: 'img', attrs: { src: 'asset://image-1' }, children: [] };
    expect(createQuotedMessageContent(image as never, 'msg-2')).toEqual([
      expect.objectContaining({ type: 'quote', attrs: expect.objectContaining({ id: 'msg-2' }) }),
      image,
    ]);
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
    expect(calculateSmartSendDelayMs('好')).toBe(2000);
    const longLine = '这是一条很长很长很长很长很长很长很长很长很长很长很长很长的消息。';
    expect(calculateSmartSendDelayMs(longLine)).toBeLessThanOrEqual(4000);
    expect(calculateSmartSendDelayMs(longLine)).toBeGreaterThanOrEqual(2000);
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
    const sentWhole: unknown[] = [];
    const sentLine: unknown[] = [];
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

  it('dispatches ordered plan segments sequentially and splits ordinary message lines', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const pending = dispatchOutboundMessagePlan(
      buildOutboundMessagePlanFromReplyPlan({
        segments: [
          { kind: 'message', content: '第一句', mentions: [] },
          { kind: 'message', content: '第二句\n第三句', mentions: [] },
          { kind: 'structured_block', content: '整块一\n整块二' },
          { kind: 'message', content: '第二句', mentions: ['123456'] },
        ],
      }),
      async (segment) => {
        sent.push(
          segment.kind === 'image-block'
            ? `${segment.kind}:${segment.assetRef}`
            : segment.kind === 'message-block'
              ? `${segment.kind}:${segment.mentions.length ? `${segment.mentions.map((id) => `@${id}`).join(' ')}${segment.content ? ` ${segment.content}` : ''}` : segment.content}`
              : segment.kind === 'structured-block'
                ? `${segment.kind}:${segment.content}`
              : `${segment.kind}:${segment.content}`,
        );
      },
    );

    await vi.runAllTimersAsync();
    await pending;

    expect(sent).toEqual([
      'text-line:第一句',
      'text-line:第二句',
      'text-line:第三句',
      'structured-block:整块一\n整块二',
      'message-block:@123456 第二句',
    ]);
  });

  it('renders model-facing mention history as structured metadata instead of @ text', () => {
    expect(renderModelFacingMessageText({ content: '现在有 4 条任务。', mentions: ['123456', '234567'] })).toBe(
      '[assistant_message mentions=["123456","234567"]] 现在有 4 条任务。',
    );
    expect(renderModelFacingMessageText({ content: '今晚先这样吧', mentions: [] })).toBe('今晚先这样吧');
  });

  it('builds outbound segments from ReplyPlan without relying on control tags', () => {
    expect(
      buildOutboundMessagePlanFromReplyPlan({
        segments: [
          { kind: 'message', content: '第一句\n第二句', mentions: [] },
          { kind: 'structured_block', content: '整块一\n整块二' },
          { kind: 'message', content: '先问下\n第二行', mentions: ['123456'] },
          { kind: 'voice', content: '晚安' },
          { kind: 'sticker', content: '无语地看对方一眼' },
          { kind: 'image', assetRef: 'asset://image-1', alt: '夜空照片' },
        ],
      }),
    ).toEqual({
      segments: [
        { kind: 'text-line', content: '第一句', raw: 'reply-plan:message:0:line:0:第一句' },
        { kind: 'text-line', content: '第二句', raw: 'reply-plan:message:0:line:1:第二句' },
        { kind: 'structured-block', content: '整块一\n整块二', raw: 'reply-plan:structured_block:1:整块一\n整块二' },
        { kind: 'message-block', content: '先问下', mentions: ['123456'], raw: 'reply-plan:message:2:@123456 先问下' },
        { kind: 'text-line', content: '第二行', raw: 'reply-plan:message:2:line:1:第二行' },
        {
          kind: 'voice-block',
          content: '晚安',
          raw: 'reply-plan:voice:3:晚安',
        },
        {
          kind: 'sticker-block',
          content: '无语地看对方一眼',
          raw: 'reply-plan:sticker:4:无语地看对方一眼',
        },
        {
          kind: 'image-block',
          assetRef: 'asset://image-1',
          alt: '夜空照片',
          raw: 'reply-plan:image:5:asset://image-1',
        },
      ],
    });
  });

  it('keeps structured mentions while stripping handwritten @ text from message content', () => {
    expect(
      buildOutboundMessagePlanFromReplyPlan({
        segments: [
          { kind: 'message', content: '@123456 先问下这件事。', mentions: ['123456'] },
        ],
      }),
    ).toEqual({
      segments: [
        {
          kind: 'message-block',
          content: '先问下这件事。',
          mentions: ['123456'],
          raw: 'reply-plan:message:0:@123456 先问下这件事。',
        },
      ],
    });
  });

  it('normalizes structured blocks but keeps message lines flat when building outbound segments', () => {
    expect(
      buildOutboundMessagePlanFromReplyPlan({
        segments: [
          { kind: 'message', content: '# 标题\n- 第一项\n2. 第二项', mentions: [] },
          { kind: 'structured_block', content: '* 第一项\n2) 第二项' },
        ],
      }),
    ).toEqual({
      segments: [
        { kind: 'text-line', content: '标题', raw: 'reply-plan:message:0:line:0:标题' },
        { kind: 'text-line', content: '第一项', raw: 'reply-plan:message:0:line:1:第一项' },
        { kind: 'text-line', content: '第二项', raw: 'reply-plan:message:0:line:2:第二项' },
        {
          kind: 'structured-block',
          content: '- 第一项\n1. 第二项',
          raw: 'reply-plan:structured_block:1:- 第一项\n1. 第二项',
        },
      ],
    });
  });

  it('keeps first-line mention order and splits remaining message lines', () => {
    expect(
      buildOutboundMessagePlanFromReplyPlan({
        segments: [
          {
            kind: 'message',
            content: '先问下这件事。\n等你回复',
            mentions: ['123456'],
          },
        ],
      }),
    ).toEqual({
      segments: [
        {
          kind: 'message-block',
          content: '先问下这件事。',
          mentions: ['123456'],
          raw: 'reply-plan:message:0:@123456 先问下这件事。',
        },
        {
          kind: 'text-line',
          content: '等你回复',
          raw: 'reply-plan:message:0:line:1:等你回复',
        },
      ],
    });
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

  it('keeps unwrapped SQL multi-line query in split mode without explicit wrapper', () => {
    expect(
      normalizeOutboundMessage('SELECT id, name\nFROM users\nWHERE age > 18'),
    ).toEqual({
      mode: 'split',
      content: 'SELECT id, name\nFROM users\nWHERE age > 18',
    });
  });

  it('keeps unwrapped HTML fragments in split mode without explicit wrapper', () => {
    expect(
      normalizeOutboundMessage('<div class="container">\n  <p>Hello World</p>\n</div>'),
    ).toEqual({
      mode: 'split',
      content: '<div class="container">\n  <p>Hello World</p>\n</div>',
    });
  });
});
