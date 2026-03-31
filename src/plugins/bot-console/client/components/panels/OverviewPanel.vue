<script setup lang="ts">
import { inject, computed } from 'vue'
import { useToast } from '../../composables/useToast'
import { normalizeBoolean } from '../../composables/useBotConsole'
import type { useBotConsole } from '../../composables/useBotConsole'
import {
  ALL_SERVICE_UNITS,
  OVERVIEW_FEATURE_ITEMS,
  getServiceLabel,
  getActiveStateLabel,
  getActiveStateTone,
  getStatusDotClass,
} from '../../utils/constants'
import { formatDateTime, formatLatency } from '../../utils/format'
import type { MemoryV2StatusSnapshot } from '../../types'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

// Destructure refs so they auto-unwrap in templates
const { botState, probePending } = bc

// ── Derived state ─────────────────────────────────────────────────────────────

const services  = computed(() => botState.value?.services ?? [])
const env       = computed(() => botState.value?.env ?? {})
const modelTabs = computed(() => botState.value?.modelTabs)
const activeModelProfile = computed(() =>
  modelTabs.value?.tabs?.find(tab => tab.id === modelTabs.value?.activeTab) ?? null,
)
const memory    = computed<MemoryV2StatusSnapshot | undefined>(
  () => botState.value?.runtimeStatus?.memoryV2,
)

const targetActiveState = computed(
  () => services.value.find(s => s.unit === 'qqbot.target')?.activeState ?? 'unknown',
)

/** Count of overview feature tiles currently enabled. */
const enabledCount = computed(
  () => OVERVIEW_FEATURE_ITEMS.filter(([key]) => normalizeBoolean(env.value[key])).length,
)

// ── Memory status helpers ─────────────────────────────────────────────────────

const memoryStatusLabel = computed<string>(() => {
  const m = memory.value
  if (!m?.available || !m?.enabled) return '未启用'
  if (!m?.embedConfigured) return '未配置'
  const embed = m.embed
  if (!embed || embed.state === 'never') return '从未调用'
  if (embed.lastSource === 'probe') {
    return embed.state === 'success' ? '检测成功' : '检测失败'
  }
  return embed.state === 'success' ? '最近成功' : '最近失败'
})

const memoryStatusTone = computed<string>(() => {
  const label = memoryStatusLabel.value
  if (label === '最近成功' || label === '检测成功') return 'success'
  if (label === '最近失败' || label === '检测失败') return 'danger'
  if (label === '未配置') return 'warning'
  return 'muted'
})

const canProbe = computed(() => {
  const m = memory.value
  return !probePending.value && Boolean(m?.available && m?.enabled && m?.embedConfigured)
})

// ── Lookup helper (called in template) ───────────────────────────────────────

function getServiceByUnit(unit: string) {
  return services.value.find(s => s.unit === unit)
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function handleProbe() {
  try {
    const result = await bc.probeEmbedding()
    if (result?.memoryV2?.ok) {
      toastAdd(
        `Embedding 检测成功，耗时 ${formatLatency(result.memoryV2.latencyMs)}`,
        'success',
      )
    } else {
      toastAdd(result?.memoryV2?.error || 'Embedding 检测失败', 'error')
    }
  } catch (e: unknown) {
    toastAdd(e instanceof Error ? e.message : '检测失败', 'error')
  }
}
</script>

<template>
  <section class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <p class="bc-eyebrow">总览</p>
        <h2>运行总览</h2>
        <p class="bc-muted">
          集中查看服务、当前对话配置、关键功能开关，以及长期记忆 / Embedding 健康。
        </p>
      </div>
    </div>

    <div class="bc-status-grid">

      <!-- ── Card 1: 服务总览 ────────────────────────────────────────── -->
      <article class="bc-status-card bc-status-card-service">
        <div class="bc-status-card-head">
          <strong>服务总览</strong>
          <span :class="['bc-status-badge', `is-${getActiveStateTone(targetActiveState)}`]">
            <span :class="['bc-status-dot', getStatusDotClass(targetActiveState)]" />
            {{ getActiveStateLabel(targetActiveState) }}
          </span>
        </div>

        <div
          v-for="unit in ALL_SERVICE_UNITS"
          :key="unit"
          class="bc-overview-service-row"
        >
          <span class="bc-overview-service-name">{{ getServiceLabel(unit) }}</span>
          <span
            :class="[
              'bc-status-badge',
              `is-${getActiveStateTone(getServiceByUnit(unit)?.activeState ?? 'unknown')}`,
            ]"
          >
            {{ getActiveStateLabel(getServiceByUnit(unit)?.activeState ?? 'unknown') }}
          </span>
        </div>
      </article>

      <!-- ── Card 2: 对话配置 ────────────────────────────────────────── -->
      <article class="bc-status-card bc-status-card-dialogue">
        <div class="bc-status-card-head">
          <strong>对话配置</strong>
          <span class="bc-status-badge is-muted">
            {{ activeModelProfile?.title || '未设置' }}
          </span>
        </div>
        <div class="bc-overview-kv">
          <span>当前 Tab</span>
          <strong>{{ activeModelProfile?.title || '未设置' }}</strong>
        </div>
        <div class="bc-overview-kv">
          <span>provider / mode</span>
          <strong>{{ activeModelProfile ? `${activeModelProfile.provider} / ${activeModelProfile.requestMode}` : '未设置' }}</strong>
        </div>
        <div class="bc-overview-kv">
          <span>默认模型</span>
          <strong>{{ env['CHATLUNA_DEFAULT_MODEL'] || '未设置' }}</strong>
        </div>
        <div class="bc-overview-kv">
          <span>默认预设</span>
          <strong>{{ env['CHATLUNA_DEFAULT_PRESET'] || 'sakiko' }}</strong>
        </div>
        <div class="bc-overview-kv">
          <span>模型接口</span>
          <strong>{{ env['CHATLUNA_BASE_URL'] || '未设置' }}</strong>
        </div>
      </article>

      <!-- ── Card 3: 功能状态 ────────────────────────────────────────── -->
      <article class="bc-status-card bc-status-card-feature">
        <div class="bc-status-card-head">
          <strong>功能状态</strong>
          <span :class="['bc-status-badge', enabledCount === OVERVIEW_FEATURE_ITEMS.length ? 'is-success' : 'is-warning']">
            {{ enabledCount }}/{{ OVERVIEW_FEATURE_ITEMS.length }} 已开启
          </span>
        </div>

        <div class="bc-feature-grid">
          <div
            v-for="[key, label] in OVERVIEW_FEATURE_ITEMS"
            :key="key"
            :class="[
              'bc-feature-tile',
              normalizeBoolean(env[key]) ? 'is-ok' : 'is-bad',
            ]"
          >
            <span class="bc-feature-tile-label">{{ label }}</span>
            <span class="bc-feature-tile-state">{{ normalizeBoolean(env[key]) ? '正常' : '异常' }}</span>
          </div>
        </div>
      </article>

      <!-- ── Card 4: Long Memory / Embedding ────────────────────────── -->
      <article class="bc-status-card bc-status-card-memory">
        <div class="bc-status-card-head">
          <strong>Long Memory / Embedding</strong>
          <span :class="['bc-status-badge', `is-${memoryStatusTone}`]">
            {{ memoryStatusLabel }}
          </span>
        </div>

        <div class="bc-overview-kv">
          <span>memory-v2</span>
          <strong>{{ memory?.enabled ? '已启用' : '未启用' }}</strong>
        </div>
        <div class="bc-overview-kv">
          <span>extract 模型</span>
          <strong>{{ memory?.extractModel || '未配置' }}</strong>
        </div>
        <div class="bc-overview-kv">
          <span>embedding</span>
          <strong>{{ memory?.embedModel || '未配置' }}</strong>
        </div>
        <div class="bc-overview-kv">
          <span>provider</span>
          <strong>{{ memory?.embedBaseUrl || '未配置' }}</strong>
        </div>

        <div v-if="memory?.jobs" class="bc-overview-kv bc-overview-kv-block">
          <span>队列</span>
          <strong>
            extract {{ memory.jobs.extractPending }} 待处理 / {{ memory.jobs.extractProcessing }} 处理中，
            embed {{ memory.jobs.embedPending }} 待处理 / {{ memory.jobs.embedProcessing }} 处理中
          </strong>
        </div>

        <div class="bc-overview-kv">
          <span>最近成功</span>
          <strong>{{ formatDateTime(memory?.embed?.lastSuccessAt) }}</strong>
        </div>
        <div class="bc-overview-kv">
          <span>最近失败</span>
          <strong>{{ formatDateTime(memory?.embed?.lastFailureAt) }}</strong>
        </div>
        <div class="bc-overview-kv">
          <span>最近耗时</span>
          <strong>{{ formatLatency(memory?.embed?.lastLatencyMs) }}</strong>
        </div>

        <p v-if="memory?.embed?.lastError" class="bc-status-error">
          {{ memory.embed.lastError }}
        </p>

        <div class="bc-status-actions">
          <button
            type="button"
            :disabled="!canProbe"
            @click="handleProbe"
          >
            {{ probePending ? '检测中…' : '立即检测' }}
          </button>
        </div>
      </article>

    </div>
  </section>
</template>
