<script setup lang="ts">
import { computed, inject, reactive, ref, watch } from 'vue'
import { useToast } from '../../composables/useToast'
import type { useBotConsole } from '../../composables/useBotConsole'
import type {
  AffinityRandomDirection,
  AffinitySettings,
  AffinityWhitelistInput,
  ConversationTarget,
} from '../../types'
import { formatDateTime, formatErrorMessage } from '../../utils/format'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

const DIRECTION_OPTIONS: Array<{ id: AffinityRandomDirection; label: string }> = [
  { id: 'local_thread', label: '未完线索' },
  { id: 'daily_greeting', label: '日常问候' },
  { id: 'music_rehearsal', label: '音乐排练' },
  { id: 'contest_discussion', label: '算法竞赛' },
  { id: 'computer_knowledge', label: '计算机小知识' },
  { id: 'web_hot_topic', label: '联网热点' },
  { id: 'relationship_scene', label: '阶段剧情' },
]

const REQUEST_MODES = ['chat_completions', 'responses'] as const
const OUTPUT_PROTOCOLS = ['chat_reply_v1', 'native_chat_json_schema', 'native_responses_json_schema', 'json_mode'] as const

const savingSettings = ref(false)
const savingWhitelist = ref(false)
const manualScopeKind = ref<'group' | 'private'>('group')
const manualScopeId = ref('')
const manualLabel = ref('')
const adjustUserKey = ref('')
const adjustReason = ref('')
const adjustDraft = reactive<Record<'trust' | 'familiarity' | 'comfort' | 'tension', string>>({
  trust: '',
  familiarity: '',
  comfort: '',
  tension: '',
})

const settingsDraft = reactive<AffinitySettings>({
  enabled: true,
  proactiveEnabled: true,
  randomWindowStartHour: 8,
  randomWindowEndHour: 22,
  randomCountWeights: [0.25, 0.6, 0.1, 0.05],
  enabledDirections: ['local_thread', 'daily_greeting', 'music_rehearsal', 'contest_discussion', 'computer_knowledge', 'relationship_scene'],
  webSourceEnabled: false,
  analysisModel: {
    baseUrl: '',
    apiKey: '',
    model: '',
    requestMode: 'chat_completions',
    structuredOutputProtocol: 'chat_reply_v1',
    timeoutMs: 5000,
  },
})

const whitelistDraft = reactive<Record<string, AffinityWhitelistInput>>({})

const affinity = computed(() => bc.botState.value?.affinity ?? null)
const conversationTargets = computed<ConversationTarget[]>(() => bc.botState.value?.conversationTargets ?? [])

function scopeKey(kind: string, id: string): string {
  return `${kind}:${id}`
}

function syncSettings(): void {
  const source = affinity.value?.settings
  if (!source) return
  settingsDraft.enabled = source.enabled
  settingsDraft.proactiveEnabled = source.proactiveEnabled
  settingsDraft.randomWindowStartHour = source.randomWindowStartHour
  settingsDraft.randomWindowEndHour = source.randomWindowEndHour
  settingsDraft.randomCountWeights = [...source.randomCountWeights] as [number, number, number, number]
  settingsDraft.enabledDirections = [...source.enabledDirections]
  settingsDraft.webSourceEnabled = source.webSourceEnabled
  settingsDraft.analysisModel = {
    baseUrl: source.analysisModel.baseUrl ?? '',
    apiKey: source.analysisModel.apiKey ?? '',
    model: source.analysisModel.model ?? '',
    requestMode: source.analysisModel.requestMode ?? 'chat_completions',
    structuredOutputProtocol: source.analysisModel.structuredOutputProtocol ?? 'chat_reply_v1',
    timeoutMs: Number(source.analysisModel.timeoutMs ?? 5000),
  }
}

function syncWhitelist(): void {
  for (const key of Object.keys(whitelistDraft)) delete whitelistDraft[key]
  for (const row of affinity.value?.scopes ?? []) {
    whitelistDraft[scopeKey(row.scopeKind, row.scopeId)] = {
      scopeKind: row.scopeKind,
      scopeId: row.scopeId,
      enabled: Number(row.enabled) === 1,
      proactiveEnabled: Number(row.proactiveEnabled) === 1,
      label: row.label,
      platform: row.platform,
      botSelfId: row.botSelfId,
      channelId: row.channelId,
      guildId: row.guildId,
      conversationId: row.conversationId,
    }
  }
}

watch(affinity, () => {
  syncSettings()
  syncWhitelist()
}, { immediate: true })

function toggleDirection(direction: AffinityRandomDirection, checked: boolean): void {
  const set = new Set(settingsDraft.enabledDirections)
  if (checked) set.add(direction)
  else set.delete(direction)
  settingsDraft.enabledDirections = [...set]
}

function scopeForTarget(target: ConversationTarget): AffinityWhitelistInput {
  return {
    scopeKind: target.scopeKind === 'private' ? 'private' : 'group',
    scopeId: target.scopeId,
    enabled: false,
    proactiveEnabled: false,
    label: target.roomName,
    channelId: target.groupId ?? target.scopeId,
    guildId: target.groupId,
    conversationId: target.conversationId,
  }
}

function getTargetDraft(target: ConversationTarget): AffinityWhitelistInput {
  const base = scopeForTarget(target)
  const key = scopeKey(base.scopeKind, base.scopeId)
  if (!whitelistDraft[key]) whitelistDraft[key] = base
  return whitelistDraft[key]
}

function addManualScope(): void {
  const id = manualScopeId.value.trim()
  if (!id) return
  whitelistDraft[scopeKey(manualScopeKind.value, id)] = {
    scopeKind: manualScopeKind.value,
    scopeId: id,
    enabled: true,
    proactiveEnabled: true,
    label: manualLabel.value.trim() || null,
    channelId: id,
    guildId: manualScopeKind.value === 'group' ? id : null,
  }
  manualScopeId.value = ''
  manualLabel.value = ''
}

function removeScope(kind: string, id: string): void {
  delete whitelistDraft[scopeKey(kind, id)]
}

async function saveSettings(): Promise<void> {
  savingSettings.value = true
  try {
    await bc.saveAffinitySettings({
      ...settingsDraft,
      randomCountWeights: settingsDraft.randomCountWeights.map(Number) as [number, number, number, number],
      randomWindowStartHour: Number(settingsDraft.randomWindowStartHour),
      randomWindowEndHour: Number(settingsDraft.randomWindowEndHour),
      analysisModel: {
        ...settingsDraft.analysisModel,
        timeoutMs: Number(settingsDraft.analysisModel.timeoutMs ?? 5000),
      },
    })
    toastAdd('关系事件配置已保存', 'success')
  } catch (error: unknown) {
    toastAdd(formatErrorMessage(error, '保存失败'), 'error')
  } finally {
    savingSettings.value = false
  }
}

async function saveWhitelist(): Promise<void> {
  savingWhitelist.value = true
  try {
    await bc.saveAffinityWhitelist(Object.values(whitelistDraft))
    toastAdd('白名单已保存', 'success')
  } catch (error: unknown) {
    toastAdd(formatErrorMessage(error, '保存失败'), 'error')
  } finally {
    savingWhitelist.value = false
  }
}

function parseOptionalScore(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function handleAdjustUser(): Promise<void> {
  try {
    await bc.adjustAffinityUser({
      userKey: adjustUserKey.value.trim(),
      reason: adjustReason.value.trim() || 'console adjustment',
      trust: parseOptionalScore(adjustDraft.trust),
      familiarity: parseOptionalScore(adjustDraft.familiarity),
      comfort: parseOptionalScore(adjustDraft.comfort),
      tension: parseOptionalScore(adjustDraft.tension),
    })
    toastAdd('用户关系已修正', 'success')
  } catch (error: unknown) {
    toastAdd(formatErrorMessage(error, '修正失败'), 'error')
  }
}
</script>

<template>
  <section class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <h2>关系事件</h2>
        <p class="bc-muted">管理丰川祥子的长期关系玩法、自然触发、主动随机事件和事件分析模型。</p>
      </div>
      <button class="bc-btn" type="button" :disabled="bc.loading.value" @click="bc.refresh">刷新</button>
    </div>

    <div v-if="!affinity?.available" class="bc-empty">关系事件服务不可用。</div>

    <template v-else>
      <section class="bc-card">
        <div class="bc-card-head">
          <h3>模块与随机事件</h3>
          <button class="bc-btn bc-btn-primary" type="button" :disabled="savingSettings" @click="saveSettings">
            {{ savingSettings ? '保存中…' : '保存配置' }}
          </button>
        </div>

        <div class="bc-form-grid">
          <label class="bc-field">
            <span>总开关</span>
            <input v-model="settingsDraft.enabled" type="checkbox" />
          </label>
          <label class="bc-field">
            <span>主动随机事件</span>
            <input v-model="settingsDraft.proactiveEnabled" type="checkbox" />
          </label>
          <label class="bc-field">
            <span>联网素材</span>
            <input v-model="settingsDraft.webSourceEnabled" type="checkbox" />
          </label>
          <label class="bc-field">
            <span>开始小时</span>
            <input v-model.number="settingsDraft.randomWindowStartHour" class="bc-input" type="number" min="0" max="23" />
          </label>
          <label class="bc-field">
            <span>结束小时</span>
            <input v-model.number="settingsDraft.randomWindowEndHour" class="bc-input" type="number" min="1" max="24" />
          </label>
        </div>

        <div class="bc-form-grid">
          <label v-for="(_, index) in settingsDraft.randomCountWeights" :key="index" class="bc-field">
            <span>{{ index }} 次权重</span>
            <input v-model.number="settingsDraft.randomCountWeights[index]" class="bc-input" type="number" min="0" max="1" step="0.01" />
          </label>
        </div>

        <div class="bc-check-grid">
          <label v-for="direction in DIRECTION_OPTIONS" :key="direction.id" class="bc-check-row">
            <input
              type="checkbox"
              :checked="settingsDraft.enabledDirections.includes(direction.id)"
              @change="toggleDirection(direction.id, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ direction.label }}</span>
          </label>
        </div>
      </section>

      <section class="bc-card">
        <div class="bc-card-head">
          <h3>分析模型</h3>
          <span class="bc-muted">核心项全空时跟随当前主聊天模型；部分填写会被后端拒绝。</span>
        </div>
        <div class="bc-form-grid">
          <label class="bc-field">
            <span>Base URL</span>
            <input v-model="settingsDraft.analysisModel.baseUrl" class="bc-input" type="text" />
          </label>
          <label class="bc-field">
            <span>API Key</span>
            <input v-model="settingsDraft.analysisModel.apiKey" class="bc-input" type="password" />
          </label>
          <label class="bc-field">
            <span>Model</span>
            <input v-model="settingsDraft.analysisModel.model" class="bc-input" type="text" />
          </label>
          <label class="bc-field">
            <span>Request Mode</span>
            <select v-model="settingsDraft.analysisModel.requestMode" class="bc-input">
              <option v-for="mode in REQUEST_MODES" :key="mode" :value="mode">{{ mode }}</option>
            </select>
          </label>
          <label class="bc-field">
            <span>Output Protocol</span>
            <select v-model="settingsDraft.analysisModel.structuredOutputProtocol" class="bc-input">
              <option v-for="protocol in OUTPUT_PROTOCOLS" :key="protocol" :value="protocol">{{ protocol }}</option>
            </select>
          </label>
          <label class="bc-field">
            <span>Timeout ms</span>
            <input v-model.number="settingsDraft.analysisModel.timeoutMs" class="bc-input" type="number" min="1000" />
          </label>
        </div>
      </section>

      <section class="bc-card">
        <div class="bc-card-head">
          <h3>白名单</h3>
          <button class="bc-btn bc-btn-primary" type="button" :disabled="savingWhitelist" @click="saveWhitelist">
            {{ savingWhitelist ? '保存中…' : '保存白名单' }}
          </button>
        </div>

        <div class="bc-form-grid">
          <select v-model="manualScopeKind" class="bc-input">
            <option value="group">群聊</option>
            <option value="private">私聊</option>
          </select>
          <input v-model="manualScopeId" class="bc-input" type="text" placeholder="群号或私聊 channel id" />
          <input v-model="manualLabel" class="bc-input" type="text" placeholder="备注" />
          <button class="bc-btn" type="button" @click="addManualScope">添加</button>
        </div>

        <div class="bc-list">
          <article v-for="target in conversationTargets" :key="`${target.scopeKind}:${target.scopeId}`" class="bc-list-row">
            <div>
              <strong>{{ target.roomName }}</strong>
              <p class="bc-muted">{{ target.scopeKind }} · {{ target.scopeId }}</p>
            </div>
            <label><input v-model="getTargetDraft(target).enabled" type="checkbox" /> 启用</label>
            <label><input v-model="getTargetDraft(target).proactiveEnabled" type="checkbox" /> 主动</label>
          </article>
          <article v-for="scope in Object.values(whitelistDraft)" :key="`${scope.scopeKind}:${scope.scopeId}`" class="bc-list-row">
            <div>
              <strong>{{ scope.label || scope.scopeId }}</strong>
              <p class="bc-muted">{{ scope.scopeKind }} · {{ scope.scopeId }}</p>
            </div>
            <label><input v-model="scope.enabled" type="checkbox" /> 启用</label>
            <label><input v-model="scope.proactiveEnabled" type="checkbox" /> 主动</label>
            <button class="bc-btn" type="button" @click="removeScope(scope.scopeKind, scope.scopeId)">移除</button>
          </article>
        </div>
      </section>

      <section class="bc-card">
        <div class="bc-card-head">
          <h3>用户关系</h3>
        </div>
        <div class="bc-list">
          <article v-for="user in affinity.users.slice(0, 20)" :key="user.userKey" class="bc-list-row">
            <div>
              <strong>{{ user.displayName || user.userId }}</strong>
              <p class="bc-muted">{{ user.userKey }} · {{ user.stage }} · {{ user.mood }}</p>
            </div>
            <span>T {{ Math.round(user.trust) }}</span>
            <span>F {{ Math.round(user.familiarity) }}</span>
            <span>C {{ Math.round(user.comfort) }}</span>
            <span>X {{ Math.round(user.tension) }}</span>
          </article>
        </div>

        <div class="bc-form-grid">
          <input v-model="adjustUserKey" class="bc-input" type="text" placeholder="userKey" />
          <input v-model="adjustReason" class="bc-input" type="text" placeholder="修正原因" />
          <input v-model="adjustDraft.trust" class="bc-input" type="number" placeholder="trust" />
          <input v-model="adjustDraft.familiarity" class="bc-input" type="number" placeholder="familiarity" />
          <input v-model="adjustDraft.comfort" class="bc-input" type="number" placeholder="comfort" />
          <input v-model="adjustDraft.tension" class="bc-input" type="number" placeholder="tension" />
          <button class="bc-btn" type="button" @click="handleAdjustUser">管理员修正</button>
        </div>
      </section>

      <section class="bc-card">
        <div class="bc-card-head">
          <h3>最近随机事件</h3>
        </div>
        <div class="bc-list">
          <article v-for="plan in affinity.randomPlans.slice(0, 20)" :key="plan.id" class="bc-list-row">
            <div>
              <strong>{{ plan.direction }} · {{ plan.status }}</strong>
              <p class="bc-muted">{{ plan.scopeKind }}:{{ plan.scopeId }} · {{ formatDateTime(plan.scheduledAt) }}</p>
            </div>
            <span>{{ plan.skipReason || plan.messageText || '' }}</span>
          </article>
        </div>
      </section>

      <section class="bc-card">
        <div class="bc-card-head">
          <h3>审计</h3>
        </div>
        <div class="bc-list">
          <article v-for="event in affinity.recentEvents.slice(0, 20)" :key="event.id" class="bc-list-row">
            <div>
              <strong>{{ event.eventType }} · {{ event.effectTier }}</strong>
              <p class="bc-muted">{{ event.route }} · {{ event.reasonCode }} · {{ formatDateTime(event.createdAt) }}</p>
            </div>
            <span>{{ event.evidence }}</span>
          </article>
        </div>
      </section>
    </template>
  </section>
</template>
