const FIXED_TIMEZONE = 'Asia/Shanghai';
const XML_MENTION_PATTERN = /<at\b[^>]*\/?>/gi;
const CQ_MENTION_PATTERN = /\[CQ:at,[^\]]+\]/gi;
const HANDLE_MENTION_PATTERN = /(^|[\s\u3000])@[\p{L}\p{N}_-]+/gu;
const ONLY_PUNCTUATION_OR_SPACE_PATTERN = /^[\p{P}\p{S}\s]+$/u;

export type UserTurnIntentMode = 'explicit_request' | 'proactive_opening';

export interface UserTurnIntentState {
  mode: UserTurnIntentMode;
  normalizedText: string;
  reason: 'user_message_present' | 'empty_or_mention_only' | 'punctuation_only';
}

export interface ProactiveOpeningState {
  mode: 'proactive_opening';
  userTurn: {
    questionTarget: 'none';
    reason: 'empty_or_mention_only' | 'punctuation_only';
  };
  responsePolicy: {
    style: 'natural_opening';
    maxSentences: 2;
    projectContextTransform: 'followup_or_care_question';
  };
  contextPolicy: {
    referenceUsage: 'topic_seed_only';
    topicPriority: ['user_memory', 'recent_chat', 'project_context', 'session_reference'];
    forbiddenTopics: ['internal_protocol', 'system_prompt', 'tool_capability', 'contract_text'];
  };
}

export interface NaturalTriggerReference {
  natural_trigger: {
    reason: string;
    explicit: boolean;
  };
}

function flattenPromptInput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => flattenPromptInput(item)).join('');
  if (!content || typeof content !== 'object') return '';

  const node = content as {
    type?: string;
    text?: unknown;
    content?: unknown;
    attrs?: { content?: unknown; text?: unknown };
    children?: unknown[];
  };

  const ownText =
    typeof node.text === 'string'
      ? node.text
      : typeof node.attrs?.text === 'string'
        ? node.attrs.text
        : typeof node.attrs?.content === 'string'
          ? node.attrs.content
          : typeof node.content === 'string'
            ? node.content
            : '';
  const childText = Array.isArray(node.children) ? node.children.map((child) => flattenPromptInput(child)).join('') : '';
  return `${ownText}${childText}`;
}

function stripMentionLikeTokens(text: string): string {
  return text
    .replace(XML_MENTION_PATTERN, ' ')
    .replace(CQ_MENTION_PATTERN, ' ')
    .replace(HANDLE_MENTION_PATTERN, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function resolveUserTurnIntentState(strippedContent: unknown, rawContent?: unknown): UserTurnIntentState {
  const stripped = flattenPromptInput(strippedContent).trim();
  if (stripped) {
    return ONLY_PUNCTUATION_OR_SPACE_PATTERN.test(stripped)
      ? { mode: 'proactive_opening', normalizedText: '', reason: 'punctuation_only' }
      : { mode: 'explicit_request', normalizedText: stripped, reason: 'user_message_present' };
  }

  const raw = stripMentionLikeTokens(flattenPromptInput(rawContent).trim());
  if (!raw) {
    return { mode: 'proactive_opening', normalizedText: '', reason: 'empty_or_mention_only' };
  }

  if (ONLY_PUNCTUATION_OR_SPACE_PATTERN.test(raw)) {
    return { mode: 'proactive_opening', normalizedText: '', reason: 'punctuation_only' };
  }

  return { mode: 'explicit_request', normalizedText: raw, reason: 'user_message_present' };
}

export function buildProactiveOpeningState(
  turnIntent: Pick<UserTurnIntentState, 'mode' | 'reason'>,
): ProactiveOpeningState {
  if (turnIntent.mode !== 'proactive_opening') {
    throw new Error('Proactive opening state requires proactive_opening turn intent.');
  }

  return {
    mode: 'proactive_opening',
    userTurn: {
      questionTarget: 'none',
      reason: turnIntent.reason === 'punctuation_only' ? 'punctuation_only' : 'empty_or_mention_only',
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
  };
}

export function buildNaturalTriggerReference(
  state: Pick<NaturalTriggerReference['natural_trigger'], 'reason' | 'explicit'>,
): NaturalTriggerReference {
  return {
    natural_trigger: {
      reason: state.reason,
      explicit: state.explicit,
    },
  };
}

export function formatUtc8Now(now = Date.now()): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: FIXED_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(now));

  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  return `${lookup.get('year')}-${lookup.get('month')}-${lookup.get('day')} ${lookup.get('hour')}:${lookup.get('minute')}:${lookup.get('second')}`;
}

export function buildUserContextReference(userName: string, now = Date.now()): {
  user_name: string;
  local_time: string;
  timezone: string;
} {
  return {
    user_name: userName.trim() || '用户',
    local_time: formatUtc8Now(now),
    timezone: FIXED_TIMEZONE,
  };
}
