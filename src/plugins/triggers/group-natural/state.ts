export type NaturalTriggerReason = 'alias' | 'quote' | 'rule' | 'focus' | 'model' | 'direct';

export interface NaturalTriggerState {
  reason: NaturalTriggerReason;
  explicit: boolean;
}

type SessionLike = Record<string, unknown> & {
  qqNaturalTrigger?: NaturalTriggerState;
};

export function setNaturalTriggerState(session: SessionLike, state: NaturalTriggerState | null): void {
  if (state) {
    session.qqNaturalTrigger = state;
    return;
  }

  delete session.qqNaturalTrigger;
}

export function getNaturalTriggerState(session: SessionLike): NaturalTriggerState | null {
  return session.qqNaturalTrigger ?? null;
}
