export { Config, apply, inject, name, type Config as ReplyConfig } from './voice/generation.js';
export {
  buildProactiveOpeningState,
  buildUserContextReference,
  formatUtc8Now,
  formatUserStampedPrompt,
  injectUserStampedPrompt,
  resolveUserTurnIntentState,
  type ProactiveOpeningState,
  type UserTurnIntentMode,
  type UserTurnIntentState,
} from './prompt/time-context.js';
