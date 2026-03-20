import { ref, reactive, computed } from 'vue'
import { send } from '@koishijs/client'
import type {
  BotConsoleState,
  ClearConversationHistoryResponse,
  ConversationTarget,
  DeleteConversationRoomResponse,
  FeatureOverrideInput,
  FeatureScopeKind,
  PresetDocument,
  PresetPrompt,
  SaveEnvResponse,
  SaveFeatureOverridesResponse,
  SavePresetResponse,
  ServiceActionResponse,
  BotConsoleProbeResponse,
  ScopedFeatureKey,
} from '../types'

// ─── Env key groups ───────────────────────────────────────────────────────────

export const FEATURE_KEYS = [
  'QQ_VOICE_ENABLED',
  'QQ_VOICE_INPUT_ENABLED',
  'QQ_VOICE_OUTPUT_ENABLED',
  'POKEMON_BATTLE_ENABLED',
  'CHAT_NATURAL_TRIGGER_ENABLED',
  'TASK_AUTOMATION_INTENT_ENABLED',
  'QQBOT_LIVE_REPLY_ENABLED',
] as const

export const PRIVATE_DEFAULT_SCOPE_ID = 'private-default'
export const PRIVATE_UNSUPPORTED_FEATURE_KEYS = ['CHAT_NATURAL_TRIGGER_ENABLED'] as const

export const MODEL_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'TASK_AUTOMATION_INTENT_MODEL',
  'TASK_AUTOMATION_DELIVERY_MODEL',
  'TASK_AUTOMATION_CHAT_REPLY_MODEL',
  'CHATLUNA_DEFAULT_MODEL',
  'CHATLUNA_DEFAULT_PRESET',
] as const

export const BASIC_KEYS = [
  'CHAT_ENABLED_GROUPS',
  'CHAT_NATURAL_TRIGGER_GROUPS',
  'CHAT_NATURAL_TRIGGER_ALIASES',
  'CHATLUNA_COMMAND_AUTHORITY',
] as const

export const ALL_ENV_KEYS = [...FEATURE_KEYS, ...MODEL_KEYS, ...BASIC_KEYS] as const

// ─── Exported helpers ─────────────────────────────────────────────────────────

/**
 * Treats any string value other than the literal string "false" (case-insensitive)
 * as true. Used for boolean env vars stored as strings.
 */
export function normalizeBoolean(v: string | undefined): boolean {
  return String(v ?? '').toLowerCase() !== 'false'
}

export function createEmptyPreset(): PresetDocument {
  return {
    name: '',
    originalName: '',
    keywords: [],
    prompts: [{ role: 'system', content: '' }],
  }
}

export type FeatureOverrideMode = 'inherit' | 'enabled' | 'disabled'

// ─── Internal helpers ─────────────────────────────────────────────────────────

function clonePreset(p: PresetDocument): PresetDocument {
  return {
    name: p.name,
    originalName: p.originalName ?? p.name,
    keywords: [...p.keywords],
    prompts: p.prompts.map(x => ({ role: x.role, content: x.content })),
  }
}

function buildFeatureOverrideKey(scopeKind: FeatureScopeKind, scopeId: string, featureKey: ScopedFeatureKey): string {
  return `${scopeKind}:${scopeId}:${featureKey}`
}

function normalizeOverrideMode(enabled: number | boolean | null | undefined): FeatureOverrideMode {
  if (enabled == null) return 'inherit'
  return Number(enabled) === 1 || enabled === true ? 'enabled' : 'disabled'
}

function denormalizeOverrideMode(mode: FeatureOverrideMode): boolean | null {
  if (mode === 'inherit') return null
  return mode === 'enabled'
}

function isPrivateUnsupportedFeatureKey(featureKey: string): boolean {
  return (PRIVATE_UNSUPPORTED_FEATURE_KEYS as readonly string[]).includes(featureKey)
}

// ─── Composable ───────────────────────────────────────────────────────────────

export function useBotConsole() {
  // ── Core state ──────────────────────────────────────────────────────────────
  const loading = ref(true)
  const botState = ref<BotConsoleState | null>(null)

  /**
   * Live-editable env values. Keyed by env var name.
   * Always mutated in-place so reactive consumers stay connected.
   */
  const envDraft = reactive<Record<string, string>>({})

  /** Last successfully saved / loaded env values. Used to compute changedKeys. */
  const originalEnv = ref<Record<string, string>>({})

  /** The preset currently open in the editor. */
  const currentPreset = ref<PresetDocument>(createEmptyPreset())

  /** True while an embedding probe request is in-flight. */
  const probePending = ref(false)

  /** Live-editable scoped feature overrides keyed by `${scopeKind}:${scopeId}:${featureKey}`. */
  const featureOverrideDraft = reactive<Record<string, FeatureOverrideMode>>({})

  /** Last successfully loaded scoped feature overrides. */
  const originalFeatureOverrides = ref<Record<string, FeatureOverrideMode>>({})

  /** Tracks in-flight conversation clear requests keyed by conversationId. */
  const conversationPending = reactive<Record<string, boolean>>({})

  /** Tracks in-flight room delete requests keyed by conversationId. */
  const conversationDeletePending = reactive<Record<string, boolean>>({})

  /**
   * Tracks in-flight service actions keyed by unit name.
   * Value is the action string (e.g. 'restart') while pending, null otherwise.
   */
  const servicePending = reactive<Record<string, string | null>>({})

  // ── Computed ─────────────────────────────────────────────────────────────────

  /** Set of env keys whose current draft value differs from the last saved value. */
  const changedKeys = computed<Set<string>>(() => {
    const keys = new Set<string>()
    for (const key of ALL_ENV_KEYS) {
      if ((envDraft[key] ?? '') !== (originalEnv.value[key] ?? '')) {
        keys.add(key)
      }
    }
    return keys
  })

  const canSaveEnv = computed(() => changedKeys.value.size > 0)

  const changedFeatureOverrideKeys = computed<Set<string>>(() => {
    const keys = new Set<string>()
    const allKeys = new Set([
      ...Object.keys(featureOverrideDraft),
      ...Object.keys(originalFeatureOverrides.value),
    ])
    for (const key of allKeys) {
      if ((featureOverrideDraft[key] ?? 'inherit') !== (originalFeatureOverrides.value[key] ?? 'inherit')) {
        keys.add(key)
      }
    }
    return keys
  })

  const canSaveFeatureOverrides = computed(() => changedFeatureOverrideKeys.value.size > 0)
  const canSaveFeatureSettings = computed(() => canSaveEnv.value || canSaveFeatureOverrides.value)

  const canSavePreset = computed(() => {
    const p = currentPreset.value
    return (
      p.name.trim().length > 0 &&
      p.prompts.some((x: PresetPrompt) => x.content.trim().length > 0)
    )
  })

  const defaultPreset = computed(() => botState.value?.defaultPreset ?? 'sakiko')

  // ── Actions ───────────────────────────────────────────────────────────────────

  /**
   * Fetches full bot state from the backend and syncs local draft state.
   * If no preset is currently open and the backend has presets, opens the first one.
   */
  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const state = await send<BotConsoleState>('bot-console/get-state')
      botState.value = state

      const env = state?.env ?? {}
      originalEnv.value = { ...env }

      // Mutate envDraft in-place to preserve reactive bindings
      for (const key of Object.keys(envDraft)) {
        delete envDraft[key]
      }
      Object.assign(envDraft, env)

      const nextOverrides: Record<string, FeatureOverrideMode> = {}
      for (const item of state?.featureOverrides ?? []) {
        nextOverrides[buildFeatureOverrideKey(item.scopeKind, item.scopeId, item.featureKey)] = normalizeOverrideMode(item.enabled)
      }
      originalFeatureOverrides.value = nextOverrides
      for (const key of Object.keys(featureOverrideDraft)) {
        delete featureOverrideDraft[key]
      }
      Object.assign(featureOverrideDraft, nextOverrides)

      for (const scope of state?.featureScopes ?? []) {
        for (const featureKey of FEATURE_KEYS) {
          if (scope.scopeKind === 'private_default' && isPrivateUnsupportedFeatureKey(featureKey)) continue
          const key = buildFeatureOverrideKey(scope.scopeKind, scope.scopeId, featureKey)
          featureOverrideDraft[key] = nextOverrides[key] ?? 'inherit'
        }
      }

      // Auto-open first preset when none is selected
      if (!currentPreset.value.name && state?.presets?.length) {
        await openPreset(state.presets[0].name)
      }
    } finally {
      loading.value = false
    }
  }

  /**
   * Saves all managed env keys to the backend.
   * Optionally restarts qqbot.target immediately after saving.
   */
  async function saveEnv(restartAfter = false): Promise<SaveEnvResponse> {
    const payload: Record<string, string> = {}
    for (const key of ALL_ENV_KEYS) {
      payload[key] = envDraft[key] ?? ''
    }

    const result = await send<SaveEnvResponse>('bot-console/save-env', payload)

    // Sync saved state
    originalEnv.value = { ...(result?.env ?? {}) }
    for (const key of Object.keys(envDraft)) {
      delete envDraft[key]
    }
    Object.assign(envDraft, result?.env ?? {})

    if (restartAfter) {
      await runServiceAction('qqbot.target', 'restart')
    }

    return result
  }

  async function saveFeatureOverrides(): Promise<SaveFeatureOverridesResponse> {
    const overrides: FeatureOverrideInput[] = []
    const scopes = botState.value?.featureScopes ?? []
    for (const scope of scopes) {
      for (const featureKey of FEATURE_KEYS) {
        if (scope.scopeKind === 'private_default' && isPrivateUnsupportedFeatureKey(featureKey)) continue
        const draftKey = buildFeatureOverrideKey(scope.scopeKind, scope.scopeId, featureKey)
        const mode = featureOverrideDraft[draftKey] ?? 'inherit'
        const enabled = denormalizeOverrideMode(mode)
        if (enabled == null) continue
        overrides.push({
          featureKey,
          scopeKind: scope.scopeKind,
          scopeId: scope.scopeId,
          enabled,
        })
      }
    }

    const result = await send<SaveFeatureOverridesResponse>(
      'bot-console/save-feature-overrides',
      { overrides },
    )

    const nextOverrides: Record<string, FeatureOverrideMode> = {}
    for (const item of result?.overrides ?? []) {
      nextOverrides[buildFeatureOverrideKey(item.scopeKind, item.scopeId, item.featureKey)] = normalizeOverrideMode(item.enabled)
    }
    originalFeatureOverrides.value = nextOverrides
    for (const key of Object.keys(featureOverrideDraft)) {
      featureOverrideDraft[key] = nextOverrides[key] ?? 'inherit'
    }

    if (botState.value) {
      botState.value = {
        ...botState.value,
        featureOverrides: result?.overrides ?? [],
      }
    }

    return result
  }

  async function saveFeatureSettings(restartAfter = false): Promise<void> {
    if (canSaveEnv.value) {
      await saveEnv(false)
    }
    if (canSaveFeatureOverrides.value) {
      await saveFeatureOverrides()
    }
    if (restartAfter) {
      await runServiceAction('qqbot.target', 'restart')
    }
  }

  async function clearConversationHistory(target: ConversationTarget): Promise<ClearConversationHistoryResponse> {
    conversationPending[target.conversationId] = true
    try {
      const result = await send<ClearConversationHistoryResponse>(
        'bot-console/clear-conversation-history',
        {
          roomId: target.roomId,
          conversationId: target.conversationId,
        },
      )

      if (botState.value) {
        botState.value = {
          ...botState.value,
          conversationTargets: botState.value.conversationTargets.map(item =>
            item.conversationId === target.conversationId
              ? { ...item, updatedAt: result.result.updatedAt }
              : item,
          ),
        }
      }

      return result
    } finally {
      conversationPending[target.conversationId] = false
    }
  }

  async function deleteConversationRoom(target: ConversationTarget): Promise<DeleteConversationRoomResponse> {
    conversationDeletePending[target.conversationId] = true
    try {
      const result = await send<DeleteConversationRoomResponse>(
        'bot-console/delete-conversation-room',
        {
          roomId: target.roomId,
          conversationId: target.conversationId,
        },
      )

      await refresh()
      return result
    } finally {
      conversationDeletePending[target.conversationId] = false
    }
  }

  /**
   * Loads a named preset from the backend and opens it in the editor.
   */
  async function openPreset(name: string): Promise<void> {
    const preset = await send<PresetDocument>('bot-console/get-preset', name)
    currentPreset.value = clonePreset(preset)
  }

  /**
   * Saves the currently open preset to the backend, refreshes state,
   * then re-opens the preset by the name returned from the server
   * (handles renames transparently).
   */
  async function saveCurrentPreset(): Promise<SavePresetResponse> {
    const preset = clonePreset(currentPreset.value)
    const result = await send<SavePresetResponse>('bot-console/save-preset', preset)
    await refresh()
    await openPreset(result?.preset?.name ?? preset.name)
    return result
  }

  /**
   * Deletes a named preset, resets the editor, and refreshes state.
   */
  async function deletePreset(name: string): Promise<{ ok: boolean }> {
    const result = await send<{ ok: boolean }>(
      'bot-console/delete-preset',
      name,
      botState.value?.defaultPreset ?? 'sakiko',
    )
    currentPreset.value = createEmptyPreset()
    await refresh()
    return result
  }

  /**
   * Runs a systemd service action (start / stop / restart / enable).
   * Tracks pending state per unit so UI can show loading indicators.
   */
  async function runServiceAction(
    unit: string,
    action: string,
  ): Promise<ServiceActionResponse | undefined> {
    servicePending[unit] = action
    try {
      const result = await send<ServiceActionResponse>(
        'bot-console/service-action',
        unit,
        action,
      )
      await refresh()
      return result
    } finally {
      servicePending[unit] = null
    }
  }

  /**
   * Runs an embedding health probe, updates the in-memory memoryV2 snapshot,
   * and returns the full probe result for callers to handle toasts / feedback.
   */
  async function probeEmbedding(): Promise<BotConsoleProbeResponse> {
    probePending.value = true
    try {
      const result = await send<BotConsoleProbeResponse>(
        'bot-console/run-status-probe',
        'embedding',
      )

      // Patch the in-memory snapshot so the Overview panel updates without a full refresh
      if (result?.memoryV2?.snapshot && botState.value) {
        botState.value = {
          ...botState.value,
          runtimeStatus: {
            ...botState.value.runtimeStatus,
            memoryV2: result.memoryV2.snapshot,
          },
        }
      }

      return result
    } finally {
      probePending.value = false
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  return {
    // State
    loading,
    botState,
    envDraft,
    originalEnv,
    featureOverrideDraft,
    originalFeatureOverrides,
    currentPreset,
    probePending,
    servicePending,
    conversationPending,
    conversationDeletePending,

    // Computed
    changedKeys,
    canSaveEnv,
    changedFeatureOverrideKeys,
    canSaveFeatureOverrides,
    canSaveFeatureSettings,
    canSavePreset,
    defaultPreset,

    // Actions
    refresh,
    saveEnv,
    saveFeatureOverrides,
    saveFeatureSettings,
    clearConversationHistory,
    deleteConversationRoom,
    openPreset,
    saveCurrentPreset,
    deletePreset,
    runServiceAction,
    probeEmbedding,
  }
}
