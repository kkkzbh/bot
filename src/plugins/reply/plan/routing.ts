import type { UserTurnIntentState } from '../prompt/time-context.js';

export type ReplyRoute = 'plain' | 'structured';

export interface ReplyRouteCapabilitySnapshot {
  canMultiline: boolean;
  canVoice: boolean;
  canSticker: boolean;
}

export interface ReplyRouteDecision {
  route: ReplyRoute;
  reason:
    | 'explicit_rich_request'
    | 'daily_chat_with_sticker'
    | 'plain_text_task'
    | 'structured_multiline_task'
    | 'capability_disabled_fallback'
    | 'structured_retry'
    | 'plain_retry_after_structured_failure';
}

const EXPLICIT_STRUCTURED_PATTERN =
  /(表情包|贴纸|发图|图片|语音|录音|读出来|说给我听|多行|换行|分段发|一条一条发|混排)/i;
const PLAIN_TEXT_TASK_PATTERN =
  /(代码|命令|配置|日志|清单|列表|步骤|总结|解释|分析|原理|教程|文档|联网|搜索|搜一下|查一下|检索|资料|报告|是谁|是什么|什么意思|介绍一下|科普一下)/i;
const MULTILINE_TEXT_PATTERN = /(\n)|(```)|(^|\s)(代码|命令|配置|日志|清单|列表|步骤)(\s|$)/i;

function normalizeInputText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

export function resolveReplyRoute(args: {
  inputText: string;
  turnIntent: Pick<UserTurnIntentState, 'mode'>;
  capabilities: ReplyRouteCapabilitySnapshot;
}): ReplyRouteDecision {
  const inputText = normalizeInputText(args.inputText);
  const { turnIntent, capabilities } = args;

  if (EXPLICIT_STRUCTURED_PATTERN.test(inputText)) {
    return { route: 'structured', reason: 'explicit_rich_request' };
  }

  if (MULTILINE_TEXT_PATTERN.test(inputText)) {
    return { route: 'structured', reason: 'structured_multiline_task' };
  }

  if (PLAIN_TEXT_TASK_PATTERN.test(inputText)) {
    return { route: 'plain', reason: 'plain_text_task' };
  }

  if (capabilities.canSticker && turnIntent.mode === 'explicit_request') {
    return { route: 'structured', reason: 'daily_chat_with_sticker' };
  }

  if (capabilities.canVoice || capabilities.canMultiline || capabilities.canSticker) {
    return { route: 'structured', reason: 'capability_disabled_fallback' };
  }

  return { route: 'plain', reason: 'capability_disabled_fallback' };
}
