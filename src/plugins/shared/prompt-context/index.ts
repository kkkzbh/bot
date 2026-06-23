export type PromptFragmentAuthority = 'persona_core' | 'runtime_contract' | 'reference' | 'assistant_state';
export type PromptFragmentTrust = 'trusted' | 'untrusted';
export type PromptFragmentTtl = 'sticky' | 'turn';
export type PromptFragmentPayloadKind = 'text' | 'json';
export type PromptEnvelopeMessageRole = 'system' | 'human' | 'ai';

export interface PromptEnvelopeMessage {
  role: PromptEnvelopeMessageRole;
  content: string;
  additional_kwargs?: Record<string, unknown>;
}

export interface PromptFragmentPayload {
  kind: PromptFragmentPayloadKind;
  value: unknown;
}

export interface PromptFragment {
  source: string;
  title: string;
  authority: PromptFragmentAuthority;
  trust: PromptFragmentTrust;
  ttl: PromptFragmentTtl;
  payload: PromptFragmentPayload;
}

export interface CompiledPromptFragment extends PromptFragment {
  compiledOrder: number;
  content: string;
  message: PromptEnvelopeMessage;
}

export interface PromptEnvelope {
  messages: PromptEnvelopeMessage[];
  fragments: CompiledPromptFragment[];
}

interface RegisteredPromptFragment extends PromptFragment {
  registeredOrder: number;
}

interface PromptTurnDraft {
  fragments: RegisteredPromptFragment[];
  nextOrder: number;
  started: boolean;
}

const turnDrafts = new Map<string, PromptTurnDraft>();

function normalizeConversationId(conversationId: string): string {
  return conversationId.trim();
}

function ensureDraft(conversationId: string): PromptTurnDraft {
  const normalized = normalizeConversationId(conversationId);
  let draft = turnDrafts.get(normalized);
  if (!draft) {
    draft = {
      fragments: [],
      nextOrder: 0,
      started: false,
    };
    turnDrafts.set(normalized, draft);
  }
  return draft;
}

function normalizeTitle(title: string, fallback: string): string {
  const normalized = title.trim();
  return normalized || fallback;
}

function authorityRank(authority: PromptFragmentAuthority): number {
  switch (authority) {
    case 'persona_core':
      return 0;
    case 'runtime_contract':
      return 1;
    case 'reference':
      return 2;
    case 'assistant_state':
      return 3;
    default:
      return 9;
  }
}

function ttlRank(ttl: PromptFragmentTtl): number {
  return ttl === 'sticky' ? 0 : 1;
}

function payloadToContent(payload: PromptFragmentPayload, source: string): string {
  if (payload.kind === 'text') {
    return String(payload.value ?? '').trim();
  }

  try {
    return JSON.stringify(payload.value, null, 2).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`prompt fragment ${source} JSON payload must be serializable: ${message}`);
  }
}

function sectionKindForFragment(fragment: PromptFragment): string {
  if (fragment.authority === 'assistant_state') return 'assistant_state';
  if (fragment.authority === 'reference') return 'reference';
  if (fragment.ttl === 'turn') return 'turn_state';
  return 'internal_contract';
}

function indentBlock(content: string, prefix = '  '): string {
  return content
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function renderFragment(fragment: PromptFragment, content: string): string {
  if (!content) return '';

  return [
    '[qqbot-context]',
    `kind: ${sectionKindForFragment(fragment)}`,
    `source: ${fragment.source}`,
    `title: ${fragment.title}`,
    `authority: ${fragment.authority}`,
    `trust: ${fragment.trust}`,
    `ttl: ${fragment.ttl}`,
    `payload_kind: ${fragment.payload.kind}`,
    'payload:',
    indentBlock(content),
  ].join('\n');
}

function fragmentIdentityKey(fragment: PromptFragment, payloadContent: string): string {
  return JSON.stringify([
    fragment.source,
    fragment.title,
    fragment.authority,
    fragment.trust,
    fragment.ttl,
    fragment.payload.kind,
    payloadContent,
  ]);
}

function compileRegisteredFragments(fragments: RegisteredPromptFragment[]): PromptEnvelope | null {
  const seenFragmentKeys = new Set<string>();
  const allFragments = fragments
    .map((fragment) => ({
      fragment,
      payloadContent: payloadToContent(fragment.payload, fragment.source),
    }))
    .filter((item) => item.payloadContent)
    .filter((item) => {
      const key = fragmentIdentityKey(item.fragment, item.payloadContent);
      if (seenFragmentKeys.has(key)) return false;
      seenFragmentKeys.add(key);
      return true;
    })
    .sort((left, right) => {
      const authorityDelta = authorityRank(left.fragment.authority) - authorityRank(right.fragment.authority);
      if (authorityDelta !== 0) return authorityDelta;
      const ttlDelta = ttlRank(left.fragment.ttl) - ttlRank(right.fragment.ttl);
      if (ttlDelta !== 0) return ttlDelta;
      return left.fragment.registeredOrder - right.fragment.registeredOrder;
    });

  if (!allFragments.length) return null;

  const compiledFragments: CompiledPromptFragment[] = [];
  for (const [index, item] of allFragments.entries()) {
    const { registeredOrder: _registeredOrder, ...fragment } = item.fragment;
    const content = renderFragment(fragment, item.payloadContent);
    if (!content) continue;
    compiledFragments.push({
      ...fragment,
      compiledOrder: index,
      content,
      message: {
        role: 'system',
        content,
        additional_kwargs: {
          qqbot_context: {
            source: fragment.source,
            title: fragment.title,
            authority: fragment.authority,
            trust: fragment.trust,
            ttl: fragment.ttl,
            payload_kind: fragment.payload.kind,
          },
        },
      },
    });
  }

  if (!compiledFragments.length) return null;

  return {
    messages: compiledFragments.map((fragment) => fragment.message),
    fragments: compiledFragments,
  };
}

export function compilePromptEnvelopeFromFragments(fragments: PromptFragment[]): PromptEnvelope | null {
  const normalized = fragments.map((fragment, index) => ({
    ...fragment,
    registeredOrder: index,
  }));
  return compileRegisteredFragments(normalized);
}

export function beginPromptAssemblyTurn(conversationId: string): void {
  const normalized = normalizeConversationId(conversationId);
  if (!normalized) return;
  const existing = turnDrafts.get(normalized);
  if (!existing) {
    turnDrafts.set(normalized, {
      fragments: [],
      nextOrder: 0,
      started: true,
    });
    return;
  }

  // Preserve fragments that were registered before the turn formally started
  // (for example, reply interrupt state injected during interrupt
  // reconciliation), but clear leftovers from an already-started stale turn.
  if (existing.started) {
    turnDrafts.set(normalized, {
      fragments: [],
      nextOrder: 0,
      started: true,
    });
    return;
  }

  existing.started = true;
}

export function clearPromptAssemblyTurn(conversationId: string): void {
  const normalized = normalizeConversationId(conversationId);
  if (!normalized) return;
  turnDrafts.delete(normalized);
}

export function registerPromptFragment(
  conversationId: string,
  fragment: Omit<PromptFragment, 'title'> & { title?: string },
): PromptFragment {
  const normalized = normalizeConversationId(conversationId);
  if (!normalized) {
    throw new Error('conversationId is required for prompt fragment registration.');
  }

  const draft = ensureDraft(normalized);
  const normalizedFragment: RegisteredPromptFragment = {
    ...fragment,
    source: fragment.source.trim(),
    title: normalizeTitle(fragment.title ?? '', fragment.source),
    payload: {
      kind: fragment.payload.kind,
      value: fragment.payload.value,
    },
    registeredOrder: draft.nextOrder,
  };
  draft.nextOrder += 1;
  draft.fragments.push(normalizedFragment);
  return normalizedFragment;
}

export function peekPromptFragments(conversationId: string): PromptFragment[] {
  const normalized = normalizeConversationId(conversationId);
  if (!normalized) return [];
  const draft = turnDrafts.get(normalized);
  if (!draft) return [];
  return draft.fragments.map(({ registeredOrder: _registeredOrder, ...fragment }) => ({ ...fragment }));
}

export function compilePromptEnvelope(conversationId: string): PromptEnvelope | null {
  const normalized = normalizeConversationId(conversationId);
  if (!normalized) return null;

  const draft = turnDrafts.get(normalized);
  if (!draft) return null;
  return compileRegisteredFragments(draft.fragments);
}

export function consumePromptEnvelope(conversationId: string): PromptEnvelope | null {
  const envelope = compilePromptEnvelope(conversationId);
  clearPromptAssemblyTurn(conversationId);
  return envelope;
}
