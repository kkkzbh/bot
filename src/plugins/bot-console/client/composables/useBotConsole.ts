import { ref, reactive, computed } from 'vue'
import { send } from '@koishijs/client'
import type {
  BotConsoleToolPolicyState,
  BotConsoleState,
  ClearConversationHistoryResponse,
  ConversationTarget,
  DeleteConversationRoomResponse,
  FeatureOverrideInput,
  FeatureScopeKind,
  PresetDocument,
  PresetPrompt,
  ReorderPresetsResponse,
  SaveEnvResponse,
  SaveFeatureOverridesResponse,
  SavePresetResponse,
  SaveToolOverridesResponse,
  ServiceActionResponse,
  BotConsoleProbeResponse,
  ScopedFeatureKey,
  ToolCatalogEntry,
  ToolPolicyOverrideInput,
  ToolOverrideMode,
  ToolPolicyScope,
  ToolRouteProfile,
} from '../types'
import {
  buildToolOverrideKey,
  buildToolScopeKey,
  denormalizeToolOverrideMode,
  getToolRouteLabel,
  getToolScopeLabel,
  normalizeToolOverrideMode,
  TOOL_CATALOG,
  TOOL_GLOBAL_DEFAULT_SCOPE_ID,
  TOOL_PRIVATE_DEFAULT_SCOPE_ID,
  TOOL_ROUTE_PROFILES,
} from './toolPolicy'

// ─── Env key groups ───────────────────────────────────────────────────────────

export const FEATURE_KEYS = [
  'QQ_VOICE_ENABLED',
  'QQ_VOICE_INPUT_ENABLED',
  'QQ_VOICE_OUTPUT_ENABLED',
  'CHAT_NATURAL_TRIGGER_ENABLED',
  'TASK_AUTOMATION_INTENT_ENABLED',
  'QQBOT_REPLY_INTERRUPT_ENABLED',
] as const

export const FILE_SYSTEM_CONTROL_KEYS = [
  'CHATLUNA_COMMON_FS',
  'CHATLUNA_COMMON_FS_SCOPE_PATH',
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

export const ALL_ENV_KEYS = [...FEATURE_KEYS, ...FILE_SYSTEM_CONTROL_KEYS, ...MODEL_KEYS, ...BASIC_KEYS] as const

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

function buildToolScopeMap(state: BotConsoleState | null): ToolPolicyScope[] {
  const scopes = new Map<string, ToolPolicyScope>()

  const addScope = (scope: ToolPolicyScope) => {
    scopes.set(buildToolScopeKey(scope), scope)
  }

  addScope({
    scopeKind: 'global_default',
    scopeId: TOOL_GLOBAL_DEFAULT_SCOPE_ID,
    roomId: null,
    roomName: '全局默认',
    groupId: null,
    conversationId: null,
    visibility: null,
    updatedAt: null,
  })

  addScope({
    scopeKind: 'private_default',
    scopeId: TOOL_PRIVATE_DEFAULT_SCOPE_ID,
    roomId: null,
    roomName: '所有私聊',
    groupId: null,
    conversationId: null,
    visibility: 'private',
    updatedAt: null,
  })

  for (const scope of state?.toolPolicy?.scopes ?? []) {
    addScope(scope)
  }

  for (const scope of state?.featureScopes ?? []) {
    if (scope.scopeKind !== 'group') continue
    addScope({
      scopeKind: 'group',
      scopeId: scope.scopeId,
      roomId: scope.roomId,
      roomName: scope.roomName,
      groupId: scope.groupId,
      conversationId: scope.conversationId,
      visibility: scope.visibility,
      updatedAt: scope.updatedAt,
    })
  }

  for (const target of state?.conversationTargets ?? []) {
    if (target.scopeKind !== 'private') continue
    addScope({
      scopeKind: 'private_conversation',
      scopeId: String(target.roomId),
      roomId: target.roomId,
      roomName: target.roomName,
      groupId: target.groupId,
      conversationId: target.conversationId,
      visibility: 'private',
      updatedAt: target.updatedAt,
    })
  }

  return [...scopes.values()].sort((left, right) => {
    const order = toolScopeSortRank(left) - toolScopeSortRank(right)
    if (order !== 0) return order
    const timeDelta = (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    if (timeDelta !== 0) return timeDelta
    return left.scopeId.localeCompare(right.scopeId, 'zh-CN')
  })
}

function toolScopeSortRank(scope: ToolPolicyScope): number {
  switch (scope.scopeKind) {
    case 'global_default':
      return 0
    case 'private_default':
      return 1
    case 'group':
      return 2
    case 'private_conversation':
      return 3
    default:
      return 9
  }
}

function buildToolCatalog(state: BotConsoleState | null): ToolCatalogEntry[] {
  const catalog = state?.toolPolicy?.catalog ?? TOOL_CATALOG
  return [...catalog].sort((left, right) => {
    const categoryDelta = left.category.localeCompare(right.category, 'zh-CN')
    if (categoryDelta !== 0) return categoryDelta
    return left.title.localeCompare(right.title, 'zh-CN')
  })
}

function buildToolRouteProfiles(state: BotConsoleState | null): ToolRouteProfile[] {
  const routes = state?.toolPolicy?.routeProfiles?.length ? state.toolPolicy.routeProfiles : [...TOOL_ROUTE_PROFILES]
  return [...new Set(routes)]
}

function buildToolOverrideMap(state: BotConsoleState | null): Record<string, ToolOverrideMode> {
  const next: Record<string, ToolOverrideMode> = {}
  for (const item of state?.toolPolicy?.overrides ?? []) {
    next[buildToolOverrideKey(item.scopeKind, item.scopeId, item.routeProfile, item.toolName)] = normalizeToolOverrideMode(item.enabled)
  }
  return next
}

function resolveToolOverrideKey(scope: ToolPolicyScope, routeProfile: ToolRouteProfile, toolName: string): string {
  return buildToolOverrideKey(scope.scopeKind, scope.scopeId, routeProfile, toolName)
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

  /** Currently edited tool route profile. */
  const toolRouteProfile = ref<ToolRouteProfile>('chat')

  /** Currently selected tool policy scope. */
  const selectedToolScopeKey = ref<string>(
    buildToolScopeKey({
      scopeKind: 'global_default',
      scopeId: TOOL_GLOBAL_DEFAULT_SCOPE_ID,
    }),
  )

  /** Live-editable tool overrides keyed by `${route}:${scopeKind}:${scopeId}:${toolName}`. */
  const toolOverrideDraft = reactive<Record<string, ToolOverrideMode>>({})

  /** Last successfully loaded tool overrides. */
  const originalToolOverrides = ref<Record<string, ToolOverrideMode>>({})

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

  const toolPolicyScopes = computed<ToolPolicyScope[]>(() => buildToolScopeMap(botState.value))
  const toolPolicyCatalog = computed<ToolCatalogEntry[]>(() => buildToolCatalog(botState.value))
  const toolPolicyRouteProfiles = computed<ToolRouteProfile[]>(() => buildToolRouteProfiles(botState.value))

  const changedToolOverrideKeys = computed<Set<string>>(() => {
    const keys = new Set<string>()
    const allKeys = new Set([
      ...Object.keys(toolOverrideDraft),
      ...Object.keys(originalToolOverrides.value),
    ])
    for (const key of allKeys) {
      if ((toolOverrideDraft[key] ?? 'inherit') !== (originalToolOverrides.value[key] ?? 'inherit')) {
        keys.add(key)
      }
    }
    return keys
  })

  const canSaveToolPolicyOverrides = computed(() => changedToolOverrideKeys.value.size > 0)
  const canSaveToolPolicySettings = computed(() => canSaveToolPolicyOverrides.value)

  const canSavePreset = computed(() => {
    const p = currentPreset.value
    return (
      p.name.trim().length > 0 &&
      p.prompts.some((x: PresetPrompt) => x.content.trim().length > 0)
    )
  })

  const defaultPreset = computed(() => botState.value?.defaultPreset ?? 'sakiko')

  const selectedToolScope = computed<ToolPolicyScope | null>(() => {
    const current = toolPolicyScopes.value.find(scope => buildToolScopeKey(scope) === selectedToolScopeKey.value)
    return current ?? toolPolicyScopes.value[0] ?? null
  })

  const selectedToolScopeLabel = computed(() => {
    const scope = selectedToolScope.value
    return scope ? getToolScopeLabel(scope) : '未选择'
  })

  const selectedToolRouteLabel = computed(() => getToolRouteLabel(toolRouteProfile.value))

  // ── Actions ───────────────────────────────────────────────────────────────────

  /**
   * Fetches full bot state from the backend and syncs local draft state.
   * If no preset is currently open and the backend has presets, opens the first one.
   */
  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const state = await send<BotConsoleState>('bot-console/get-state')
      const toolPolicy = await send<BotConsoleToolPolicyState>('bot-console/get-tool-policy-state').catch(() => null)
      const mergedState: BotConsoleState = {
        ...state,
        toolPolicy: toolPolicy ?? state?.toolPolicy ?? null,
      }
      botState.value = mergedState

      const env = mergedState?.env ?? {}
      originalEnv.value = { ...env }

      // Mutate envDraft in-place to preserve reactive bindings
      for (const key of Object.keys(envDraft)) {
        delete envDraft[key]
      }
      Object.assign(envDraft, env)

      const nextOverrides: Record<string, FeatureOverrideMode> = {}
      for (const item of mergedState?.featureOverrides ?? []) {
        nextOverrides[buildFeatureOverrideKey(item.scopeKind, item.scopeId, item.featureKey)] = normalizeOverrideMode(item.enabled)
      }
      originalFeatureOverrides.value = nextOverrides
      for (const key of Object.keys(featureOverrideDraft)) {
        delete featureOverrideDraft[key]
      }
      Object.assign(featureOverrideDraft, nextOverrides)

      for (const scope of mergedState?.featureScopes ?? []) {
        for (const featureKey of FEATURE_KEYS) {
          if (scope.scopeKind === 'private_default' && isPrivateUnsupportedFeatureKey(featureKey)) continue
          const key = buildFeatureOverrideKey(scope.scopeKind, scope.scopeId, featureKey)
          featureOverrideDraft[key] = nextOverrides[key] ?? 'inherit'
        }
      }

      const toolScopes = toolPolicyScopes.value
      const toolRoutes = toolPolicyRouteProfiles.value
      const toolCatalog = toolPolicyCatalog.value
      const nextToolOverrides = buildToolOverrideMap(mergedState)
      originalToolOverrides.value = nextToolOverrides
      for (const key of Object.keys(toolOverrideDraft)) {
        delete toolOverrideDraft[key]
      }
      for (const scope of toolScopes) {
        for (const routeProfile of toolRoutes) {
          for (const tool of toolCatalog) {
            const key = resolveToolOverrideKey(scope, routeProfile, tool.toolName)
            toolOverrideDraft[key] = nextToolOverrides[key] ?? 'inherit'
          }
        }
      }

      if (!toolRoutes.includes(toolRouteProfile.value)) {
        toolRouteProfile.value = toolRoutes[0] ?? 'chat'
      }

      const foundToolScope = toolScopes.find(scope => buildToolScopeKey(scope) === selectedToolScopeKey.value)
      if (!foundToolScope) {
        selectedToolScopeKey.value = buildToolScopeKey(toolScopes[0] ?? {
          scopeKind: 'global_default',
          scopeId: TOOL_GLOBAL_DEFAULT_SCOPE_ID,
          roomId: null,
          roomName: '全局默认',
          groupId: null,
          conversationId: null,
          visibility: null,
          updatedAt: null,
        })
      }

      // Auto-open first preset when none is selected
      if (!currentPreset.value.name && mergedState?.presets?.length) {
        await openPreset(mergedState.presets[0].name)
      }
    } finally {
      loading.value = false
    }
  }

  /**
   * Saves all managed env keys to the backend.
   * Optionally restarts qqbot.target immediately after saving.
   */
  async function saveEnvPatch(keys: readonly string[], restartAfter = false): Promise<SaveEnvResponse> {
    const payload: Record<string, string> = {}
    for (const key of keys) {
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

  async function saveEnv(restartAfter = false): Promise<SaveEnvResponse> {
    return saveEnvPatch(ALL_ENV_KEYS, restartAfter)
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

  function getToolOverrideMode(scope: ToolPolicyScope, routeProfile: ToolRouteProfile, toolName: string): ToolOverrideMode {
    return toolOverrideDraft[resolveToolOverrideKey(scope, routeProfile, toolName)] ?? 'inherit'
  }

  function resolveEffectiveToolEnabled(
    scope: ToolPolicyScope,
    routeProfile: ToolRouteProfile,
    toolName: string,
  ): boolean {
    const tool = toolPolicyCatalog.value.find(item => item.toolName === toolName)
    let enabled = tool?.defaultEnabledByRoute?.[routeProfile] ?? true

    const resolveMode = (targetScopeKind: ToolPolicyScope['scopeKind'], targetScopeId: string): ToolOverrideMode =>
      toolOverrideDraft[buildToolOverrideKey(targetScopeKind, targetScopeId, routeProfile, toolName)] ?? 'inherit'

    const applyMode = (mode: ToolOverrideMode) => {
      if (mode === 'enabled') enabled = true
      if (mode === 'disabled') enabled = false
    }

    applyMode(resolveMode('global_default', TOOL_GLOBAL_DEFAULT_SCOPE_ID))

    if (scope.scopeKind === 'private_default' || scope.scopeKind === 'private_conversation') {
      applyMode(resolveMode('private_default', TOOL_PRIVATE_DEFAULT_SCOPE_ID))
    }

    if (scope.scopeKind === 'group' || scope.scopeKind === 'private_conversation') {
      applyMode(resolveMode(scope.scopeKind, scope.scopeId))
    }

    return enabled
  }

  function resolveEffectiveToolStatusLabel(
    scope: ToolPolicyScope,
    routeProfile: ToolRouteProfile,
    toolName: string,
  ): string {
    return resolveEffectiveToolEnabled(scope, routeProfile, toolName) ? '启用' : '禁用'
  }

  function setToolOverrideMode(
    scope: ToolPolicyScope,
    routeProfile: ToolRouteProfile,
    toolName: string,
    mode: ToolOverrideMode,
  ): void {
    toolOverrideDraft[resolveToolOverrideKey(scope, routeProfile, toolName)] = mode
  }

  function selectToolPolicyScope(scope: ToolPolicyScope): void {
    selectedToolScopeKey.value = buildToolScopeKey(scope)
  }

  function setToolRouteProfile(routeProfile: ToolRouteProfile): void {
    toolRouteProfile.value = routeProfile
  }

  function validateToolPolicyDraft(): string[] {
    const scopes = toolPolicyScopes.value
    const catalog = toolPolicyCatalog.value
    const errors: string[] = []
    const catalogByName = new Map(catalog.map(tool => [tool.toolName, tool]))

    for (const scope of scopes) {
      for (const routeProfile of toolPolicyRouteProfiles.value) {
        for (const tool of catalog) {
          const key = resolveToolOverrideKey(scope, routeProfile, tool.toolName)
          if (toolOverrideDraft[key] !== 'enabled') continue

          for (const dependency of tool.hardDependencies) {
            const dependencyTool = catalogByName.get(dependency)
            if (!dependencyTool) {
              errors.push(
                `${getToolRouteLabel(routeProfile)} · ${getToolScopeLabel(scope)}：工具 ${tool.title} 依赖的 ${dependency} 不在目录中`,
              )
              continue
            }

            const dependencyKey = resolveToolOverrideKey(scope, routeProfile, dependencyTool.toolName)
            if (toolOverrideDraft[dependencyKey] === 'disabled') {
              errors.push(
                `${getToolRouteLabel(routeProfile)} · ${getToolScopeLabel(scope)}：启用 ${tool.title} 前请不要禁用 ${dependencyTool.title}`,
              )
            }
          }
        }
      }
    }

    return errors
  }

  async function saveToolOverrides(): Promise<SaveToolOverridesResponse> {
    const validationErrors = validateToolPolicyDraft()
    if (validationErrors.length > 0) {
      throw new Error(validationErrors[0])
    }

    const overrides: ToolPolicyOverrideInput[] = []
    const scopes = toolPolicyScopes.value
    const routes = toolPolicyRouteProfiles.value
    const catalog = toolPolicyCatalog.value

    for (const scope of scopes) {
      for (const routeProfile of routes) {
        for (const tool of catalog) {
          const key = resolveToolOverrideKey(scope, routeProfile, tool.toolName)
          const mode = toolOverrideDraft[key] ?? 'inherit'
          const enabled = denormalizeToolOverrideMode(mode)
          if (enabled == null) continue
          overrides.push({
            toolName: tool.toolName,
            routeProfile,
            scopeKind: scope.scopeKind,
            scopeId: scope.scopeId,
            enabled,
          })
        }
      }
    }

    const result = await send<SaveToolOverridesResponse>('bot-console/save-tool-overrides', { overrides })

    const nextOverrides: Record<string, ToolOverrideMode> = {}
    for (const item of result?.overrides ?? []) {
      nextOverrides[buildToolOverrideKey(item.scopeKind, item.scopeId, item.routeProfile, item.toolName)] =
        normalizeToolOverrideMode(item.enabled)
    }

    originalToolOverrides.value = nextOverrides
    for (const key of Object.keys(toolOverrideDraft)) {
      toolOverrideDraft[key] = nextOverrides[key] ?? 'inherit'
    }

    if (botState.value) {
      botState.value = {
        ...botState.value,
        toolPolicy: {
          ...(botState.value.toolPolicy ?? {
            routeProfiles: toolPolicyRouteProfiles.value,
            catalog: toolPolicyCatalog.value,
            scopes: toolPolicyScopes.value,
            overrides: [],
          }),
          overrides: result?.overrides ?? [],
        },
      }
    }

    return result
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

  async function reorderPresets(names: string[]): Promise<ReorderPresetsResponse> {
    const result = await send<ReorderPresetsResponse>('bot-console/reorder-presets', { names })
    if (botState.value) {
      botState.value = {
        ...botState.value,
        presets: result?.presets ?? botState.value.presets,
      }
    }
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
    toolRouteProfile,
    selectedToolScopeKey,
    toolOverrideDraft,
    originalToolOverrides,

    // Computed
    changedKeys,
    canSaveEnv,
    changedFeatureOverrideKeys,
    canSaveFeatureOverrides,
    canSaveFeatureSettings,
    toolPolicyScopes,
    toolPolicyCatalog,
    toolPolicyRouteProfiles,
    selectedToolScope,
    selectedToolScopeLabel,
    selectedToolRouteLabel,
    changedToolOverrideKeys,
    canSaveToolPolicyOverrides,
    canSaveToolPolicySettings,
    canSavePreset,
    defaultPreset,

    // Actions
    refresh,
    saveEnv,
    saveEnvPatch,
    saveFeatureOverrides,
    saveFeatureSettings,
    getToolOverrideMode,
    resolveEffectiveToolEnabled,
    resolveEffectiveToolStatusLabel,
    setToolOverrideMode,
    selectToolPolicyScope,
    setToolRouteProfile,
    validateToolPolicyDraft,
    saveToolOverrides,
    clearConversationHistory,
    deleteConversationRoom,
    openPreset,
    saveCurrentPreset,
    deletePreset,
    reorderPresets,
    runServiceAction,
    probeEmbedding,
  }
}
