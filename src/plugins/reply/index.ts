export { Config, apply, inject, name, type Config as ReplyConfig } from './voice/generation.js';
export { formatStructuredLogBlock } from './pipeline/debug.js';
export {
  buildNaturalTriggerReference,
  buildProactiveOpeningState,
  buildUserContextReference,
  formatUtc8Now,
  resolveUserTurnIntentState,
  type NaturalTriggerReference,
  type ProactiveOpeningState,
  type UserTurnIntentMode,
  type UserTurnIntentState,
} from './prompt/time-context.js';
