import { ref, reactive, computed } from 'vue'
import { send } from '@koishijs/client'
import type {
  BotConsoleState,
  BotServiceStatus,
  PresetDocument,
  PresetPrompt,
  SaveEnvResponse,
  SavePresetResponse,
  ServiceActionResponse,
  BotConsoleProbeResponse,
} from '../types'

// ─── Env key groups ───────────────────────────────────────────────────────────

export const FEATURE_KEYS = [
  'QQ_VOICE_ENABLED',
  'QQ_VOICE_INPUT_ENABLED',
  'QQ_VOICE_OUTPUT_ENABLED',
  'WEB_SEARCH_ENABLED',
  'POKEMON_BATTLE_ENABLED',
  'CHAT_NATURAL_TRIGGER_ENABLED',
  'TASK_AUTOMATION_INTENT_ENABLED',
  'QQBOT_LIVE_REPLY_ENABLED',
] as const

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

// ─── Internal helpers ─────────────────────────────────────────────────────────

function clonePreset(p: PresetDocument): PresetDocument {
  return {
    name: p.name,
    originalName: p.originalName ?? p.name,
    keywords: [...p.keywords],
    prompts: p.prompts.map(x => ({ role: x.role, content: x.content })),
  }
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
    currentPreset,
    probePending,
    servicePending,

    // Computed
    changedKeys,
    canSaveEnv,
    canSavePreset,
    defaultPreset,

    // Actions
    refresh,
    saveEnv,
    openPreset,
    saveCurrentPreset,
    deletePreset,
    runServiceAction,
    probeEmbedding,
  }
}
