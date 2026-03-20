import 'koishi';
import type { Session } from 'koishi';

export type ScopedFeatureKey =
  | 'QQ_VOICE_ENABLED'
  | 'QQ_VOICE_INPUT_ENABLED'
  | 'QQ_VOICE_OUTPUT_ENABLED'
  | 'POKEMON_BATTLE_ENABLED'
  | 'CHAT_NATURAL_TRIGGER_ENABLED'
  | 'TASK_AUTOMATION_INTENT_ENABLED'
  | 'QQBOT_LIVE_REPLY_ENABLED';

export type FeatureScopeKind = 'private_default' | 'group';
export type ConversationTargetScopeKind = 'private' | 'group';

export interface FeatureScopeOverrideRecord {
  id: number;
  featureKey: ScopedFeatureKey;
  scopeKind: FeatureScopeKind;
  scopeId: string;
  enabled: number;
  updatedAt: number;
}

export interface FeatureOverrideInput {
  featureKey: ScopedFeatureKey;
  scopeKind: FeatureScopeKind;
  scopeId: string;
  enabled: boolean;
}

export interface ConsoleFeatureScope {
  scopeKind: FeatureScopeKind;
  scopeId: string;
  roomId: number | null;
  roomName: string;
  groupId: string | null;
  conversationId: string | null;
  visibility: string | null;
  updatedAt: number | null;
}

export interface ConversationTarget {
  roomId: number;
  roomName: string;
  scopeKind: ConversationTargetScopeKind;
  scopeId: string;
  groupId: string | null;
  conversationId: string;
  updatedAt: number | null;
}

export interface ClearConversationHistoryTarget {
  roomId: number;
  conversationId: string;
}

export interface ClearConversationHistoryResult {
  ok: true;
  roomId: number;
  conversationId: string;
  deletedMessages: number;
  updatedAt: number;
}

export interface FeaturePolicyServiceLike {
  resolveFeatureEnabled(session: Session, featureKey: ScopedFeatureKey): Promise<boolean>;
  listConsoleFeatureScopes(): Promise<ConsoleFeatureScope[]>;
  listConversationTargets(): Promise<ConversationTarget[]>;
  getFeatureOverrides(): Promise<FeatureScopeOverrideRecord[]>;
  saveFeatureOverrides(overrides: FeatureOverrideInput[]): Promise<FeatureScopeOverrideRecord[]>;
  clearConversationHistory(target: ClearConversationHistoryTarget): Promise<ClearConversationHistoryResult>;
  resolvePrivateConversationTarget(session: Session): Promise<ConversationTarget | null>;
}

declare module 'koishi' {
  interface Tables {
    feature_scope_override: FeatureScopeOverrideRecord;
  }

  interface Context {
    featurePolicy?: FeaturePolicyServiceLike;
  }
}
