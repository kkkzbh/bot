<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue'
import { useToast } from '../../composables/useToast'
import {
  normalizeBoolean,
  TTS_BOT_ENV_KEYS,
  TTS_LOCAL_ENV_KEYS,
} from '../../composables/useBotConsole'
import { getActiveStateTone, getStatusDotClass } from '../../utils/constants'
import { formatErrorMessage } from '../../utils/format'
import type { useBotConsole } from '../../composables/useBotConsole'
import type {
  BotConsoleTtsHealthSnapshot,
  BotConsoleTtsStyleId,
  SynthesizeTtsSampleResponse,
} from '../../types'
import ToggleCard from '../ToggleCard.vue'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

const {
  botState,
  envDraft,
  ttsEnvDraft,
  changedTtsBotEnvKeys,
  changedTtsEnvKeys,
  canSaveTtsSettings,
  servicePending,
} = bc

const healthPending = ref(false)
const synthPending = ref(false)
const sampleText = ref('你好，这是一段用于试听的示例文本。欢迎使用 QQ 语音回复功能！')
const sampleStyle = ref<BotConsoleTtsStyleId>('white')
const sampleResult = ref<SynthesizeTtsSampleResponse | null>(null)

const textLangOptions = [
  ['all_zh', 'all_zh'],
  ['zh', 'zh'],
  ['auto', 'auto'],
  ['all_ja', 'all_ja'],
  ['ja', 'ja'],
  ['en', 'en'],
  ['all_yue', 'all_yue'],
  ['yue', 'yue'],
  ['all_ko', 'all_ko'],
  ['ko', 'ko'],
] as const

const promptLangOptions = [
  ['all_ja', 'all_ja（Sakiko）'],
  ['ja', 'ja'],
  ['all_zh', 'all_zh'],
  ['zh', 'zh'],
  ['en', 'en'],
  ['auto', 'auto'],
] as const

const splitMethodOptions = ['cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5'] as const
const versionOptions = ['v1', 'v2', 'v2Pro', 'v2ProPlus', 'v3', 'v4'] as const
const deviceOptions = ['cuda', 'cpu'] as const
const voiceOutputLanguageOptions = [
  ['zh', '中文'],
  ['ja', '日语'],
  ['en', '英语'],
  ['auto', '自动'],
] as const

const ttsState = computed(() => botState.value?.tts ?? null)
const localGateway = computed(() => ttsState.value?.localGateway ?? null)
const health = computed<BotConsoleTtsHealthSnapshot | null>(() => botState.value?.runtimeStatus.tts ?? ttsState.value?.health ?? null)
const ttsService = computed(() =>
  botState.value?.services.find(service => service.unit === 'qqbot-voice-tts.service') ?? null,
)
const tailnetService = computed(() =>
  botState.value?.services.find(service => service.unit === 'qqbot-voice-tts-tailnet.service') ?? null,
)

const localGatewayManageable = computed(() => localGateway.value?.manageable === true)
const botConfigDirty = computed(() => TTS_BOT_ENV_KEYS.some(key => changedTtsBotEnvKeys.value.has(key)))
const localConfigDirty = computed(() => TTS_LOCAL_ENV_KEYS.some(key => changedTtsEnvKeys.value.has(key)))
const configuredVoiceOutputLanguage = computed(() => envDraft.QQ_VOICE_OUTPUT_LANGUAGE || 'zh')
const ttsTextLangValue = computed(() => ttsEnvDraft.VOICE_TTS_TEXT_LANG || localGateway.value?.resolved.textLang || 'all_zh')
const suggestedVoiceOutputLanguage = computed(() => mapTtsTextLangToVoiceOutputLanguage(ttsTextLangValue.value))
const voiceLanguageMismatch = computed(() =>
  suggestedVoiceOutputLanguage.value !== 'auto' && configuredVoiceOutputLanguage.value !== suggestedVoiceOutputLanguage.value,
)

const outputEnabled = computed({
  get: () => normalizeBoolean(envDraft.QQ_VOICE_OUTPUT_ENABLED),
  set: (value: boolean) => {
    envDraft.QQ_VOICE_OUTPUT_ENABLED = String(value)
  },
})

const synthTimeoutSeconds = computed({
  get: () => {
    const ms = Number(envDraft.QQ_VOICE_SYNTH_TIMEOUT_MS || 300000)
    return Number.isFinite(ms) ? Math.round(ms / 1000) : 300
  },
  set: (value: number) => {
    envDraft.QQ_VOICE_SYNTH_TIMEOUT_MS = String(Math.max(1, Math.round(value)) * 1000)
  },
})

function setBotEnv(key: string, value: string): void {
  envDraft[key] = value
}

function setOutputEnabled(value: boolean): void {
  outputEnabled.value = value
}

function setSynthTimeoutSeconds(value: number): void {
  synthTimeoutSeconds.value = value
}

function setTtsEnv(key: string, value: string): void {
  ttsEnvDraft[key] = value
}

function setTtsBoolean(key: string, value: boolean): void {
  ttsEnvDraft[key] = String(value)
}

function isBotDirty(key: string): boolean {
  return changedTtsBotEnvKeys.value.has(key)
}

function isLocalDirty(key: string): boolean {
  return changedTtsEnvKeys.value.has(key)
}

function statusDotClass(): string {
  if (health.value?.status === 'ok') return 'active'
  if (health.value?.status === 'degraded' || health.value?.status === 'unreachable') return 'failed'
  return ttsService.value ? getStatusDotClass(ttsService.value.activeState) : 'inactive'
}

function gatewayStatusLabel(): string {
  if (health.value?.status === 'ok') return '网关运行中'
  if (health.value?.status === 'degraded') return '网关异常'
  if (health.value?.status === 'unreachable') return '网关不可达'
  if (ttsService.value?.activeState === 'active') return '网关待检查'
  return '网关未运行'
}

function upstreamStatusLabel(): string {
  if (health.value?.running === true) return '上游模型运行中'
  if (health.value?.running === false) return '上游模型未就绪'
  return ttsService.value?.activeState === 'active' ? '上游模型待检查' : '上游模型未运行'
}

function formatBaseUrl(): string {
  return health.value?.targetBaseUrl || envDraft.QQ_VOICE_TTS_BASE_URL || localGateway.value?.resolved.baseUrl || '未配置'
}

function formatUpstreamUrl(): string {
  if (health.value?.upstreamHost && health.value?.upstreamPort) {
    return `${health.value.upstreamHost}:${health.value.upstreamPort}`
  }
  return localGateway.value?.resolved.upstreamBaseUrl.replace(/^https?:\/\//, '') || '未配置'
}

function formatFp16(): string {
  const isHalf = health.value?.isHalf ?? localGateway.value?.resolved.isHalf ?? normalizeBoolean(ttsEnvDraft.VOICE_TTS_IS_HALF)
  return isHalf ? 'fp16' : 'fp32'
}

function formatVoiceOutputLanguage(): string {
  const value = configuredVoiceOutputLanguage.value
  return voiceOutputLanguageOptions.find(([option]) => option === value)?.[1] ?? value
}

function formatTtsTextLangLabel(): string {
  const value = ttsTextLangValue.value.toLowerCase()
  if (value.includes('ja')) return '日语'
  if (value.includes('zh') || value.includes('yue')) return '中文'
  if (value.includes('en')) return '英语'
  if (value.includes('ko')) return '韩语'
  if (value === 'auto') return '自动'
  return '语音'
}

function mapTtsTextLangToVoiceOutputLanguage(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized.includes('ja')) return 'ja'
  if (normalized.includes('zh') || normalized.includes('yue')) return 'zh'
  if (normalized.includes('en')) return 'en'
  return 'auto'
}

function formatVoiceLanguageOption(value: string): string {
  return voiceOutputLanguageOptions.find(([option]) => option === value)?.[1] ?? value
}

function formatDuration(value: number | null): string {
  return value == null ? '-' : `${value.toFixed(2)} s`
}

function formatSeconds(value: number | null): string {
  return value == null ? '-' : `${(value / 1000).toFixed(2)} s`
}

function formatSampleRate(value: number | null): string {
  return value == null ? '-' : String(value)
}

async function handleSave() {
  try {
    const result = await bc.saveTtsSettings()
    const restarts: string[] = []
    if (result.restartRequired.bot) restarts.push('机器人')
    if (result.restartRequired.tts) restarts.push('TTS')
    toastAdd(restarts.length ? `TTS 配置已保存，需重启${restarts.join('和')}生效` : 'TTS 配置已保存', 'success')
  } catch (error: unknown) {
    toastAdd(formatErrorMessage(error, '保存 TTS 配置失败'), 'error')
  }
}

async function handleHealthProbe(showToast = true) {
  healthPending.value = true
  try {
    const result = await bc.probeTtsHealth()
    if (showToast) {
      toastAdd(result.health.status === 'ok' ? 'TTS 健康检查通过' : 'TTS 健康检查异常', result.health.status === 'ok' ? 'success' : 'warning')
    }
  } catch (error: unknown) {
    if (showToast) toastAdd(formatErrorMessage(error, 'TTS 健康检查失败'), 'error')
  } finally {
    healthPending.value = false
  }
}

async function handleSynthesize() {
  synthPending.value = true
  try {
    const result = await bc.synthesizeTtsSample(sampleText.value, sampleStyle.value)
    sampleResult.value = result
    toastAdd('试听音频已生成', 'success')
  } catch (error: unknown) {
    toastAdd(formatErrorMessage(error, '试听失败'), 'error')
  } finally {
    synthPending.value = false
  }
}

async function handleRestartTts() {
  try {
    await bc.runServiceAction('qqbot-voice-tts.service', 'restart')
    toastAdd('TTS 服务已触发重启', 'success')
  } catch (error: unknown) {
    toastAdd(formatErrorMessage(error, '重启 TTS 失败'), 'error')
  }
}

onMounted(() => {
  if ((health.value?.status ?? 'unknown') === 'unknown' && formatBaseUrl() !== '未配置') {
    void handleHealthProbe(false)
  }
})
</script>

<template>
  <section class="bc-panel bc-tts-panel">
    <div class="bc-panel-head">
      <div>
        <h2>TTS 语音</h2>
        <p class="bc-muted">管理 QQ 语音回复、本机 GPT-SoVITS 网关、声线和试听诊断。</p>
      </div>
      <button
        type="button"
        class="bc-btn bc-btn-primary"
        :disabled="!canSaveTtsSettings"
        @click="handleSave"
      >
        保存配置
      </button>
    </div>

    <div class="bc-tts-status-strip">
      <article class="bc-tts-status-item">
        <span :class="['bc-status-dot', statusDotClass()]" />
        <div>
          <strong>{{ gatewayStatusLabel() }}</strong>
          <p>{{ formatBaseUrl() }}</p>
        </div>
      </article>
      <article class="bc-tts-status-item">
        <span :class="['bc-status-dot', health?.running === true ? 'active' : health?.running === false ? 'failed' : 'inactive']" />
        <div>
          <strong>{{ upstreamStatusLabel() }}</strong>
          <p>{{ formatUpstreamUrl() }}</p>
        </div>
      </article>
      <article class="bc-tts-status-item">
        <span class="bc-status-dot active" />
        <div>
          <strong>{{ health?.device || ttsEnvDraft.VOICE_TTS_DEVICE || 'cuda' }} / {{ formatFp16() }}</strong>
          <p>设备：{{ ttsEnvDraft.VOICE_TTS_DEVICE || '-' }}　精度：{{ formatFp16() }}</p>
        </div>
      </article>
      <article class="bc-tts-status-item">
        <span class="bc-status-dot active" />
        <div>
          <strong>{{ formatTtsTextLangLabel() }}合成 {{ ttsEnvDraft.VOICE_TTS_TEXT_LANG || localGateway?.resolved.textLang || 'all_zh' }}</strong>
          <p>语音文本 {{ formatVoiceOutputLanguage() }} / 参考语言 {{ ttsEnvDraft.VOICE_TTS_PROMPT_LANG || localGateway?.resolved.promptLang || 'all_ja' }}（Sakiko）</p>
        </div>
      </article>
      <button
        type="button"
        class="bc-btn"
        :disabled="healthPending"
        @click="handleHealthProbe(true)"
      >
        {{ healthPending ? '刷新中…' : '刷新状态' }}
      </button>
    </div>

    <div class="bc-tts-grid">
      <section class="bc-tts-card">
        <div class="bc-tts-card-head">
          <h3>QQ 语音回复</h3>
          <span
            v-if="botConfigDirty"
            class="bc-badge bc-badge-primary"
          >已修改</span>
        </div>

        <div class="bc-tts-form">
          <ToggleCard
            label="语音回复"
            :model-value="outputEnabled"
            :is-dirty="isBotDirty('QQ_VOICE_OUTPUT_ENABLED')"
            @update:model-value="setOutputEnabled"
          />

          <label class="bc-field">
            <span class="bc-field-label">
              语音文本语言
              <span v-if="isBotDirty('QQ_VOICE_OUTPUT_LANGUAGE')" class="bc-field-modified">已修改</span>
            </span>
            <select
              :value="envDraft.QQ_VOICE_OUTPUT_LANGUAGE || 'zh'"
              @change="setBotEnv('QQ_VOICE_OUTPUT_LANGUAGE', ($event.target as HTMLSelectElement).value)"
            >
              <option
                v-for="[value, label] in voiceOutputLanguageOptions"
                :key="value"
                :value="value"
              >
                {{ label }}
              </option>
            </select>
            <em class="bc-field-note">控制模型写入 voice.content 的语言；TTS 只朗读，不翻译。</em>
          </label>

          <div
            v-if="voiceLanguageMismatch"
            class="bc-tts-warning"
          >
            TTS 输入语言是 {{ formatVoiceLanguageOption(suggestedVoiceOutputLanguage) }}，但模型语音文本语言是 {{ formatVoiceOutputLanguage() }}。语音模式建议保持一致。
          </div>

          <label class="bc-field">
            <span class="bc-field-label">
              TTS 地址
              <span v-if="isBotDirty('QQ_VOICE_TTS_BASE_URL')" class="bc-field-modified">已修改</span>
            </span>
            <input
              type="text"
              :value="envDraft.QQ_VOICE_TTS_BASE_URL ?? ''"
              spellcheck="false"
              placeholder="http://127.0.0.1:5162"
              @input="setBotEnv('QQ_VOICE_TTS_BASE_URL', ($event.target as HTMLInputElement).value)"
            />
          </label>

          <label class="bc-field">
            <span class="bc-field-label">
              API Key
              <span v-if="isBotDirty('QQ_VOICE_TTS_API_KEY')" class="bc-field-modified">已修改</span>
            </span>
            <input
              type="password"
              :value="envDraft.QQ_VOICE_TTS_API_KEY ?? ''"
              spellcheck="false"
              @input="setBotEnv('QQ_VOICE_TTS_API_KEY', ($event.target as HTMLInputElement).value)"
            />
          </label>

          <div class="bc-tts-field-row">
            <label class="bc-field">
              <span class="bc-field-label">
                单段字数上限
                <span v-if="isBotDirty('QQ_VOICE_OUTPUT_MAX_WORDS')" class="bc-field-modified">已修改</span>
              </span>
              <input
                type="number"
                min="1"
                step="1"
                :value="envDraft.QQ_VOICE_OUTPUT_MAX_WORDS || '80'"
                @input="setBotEnv('QQ_VOICE_OUTPUT_MAX_WORDS', ($event.target as HTMLInputElement).value)"
              />
            </label>

            <label class="bc-field">
              <span class="bc-field-label">
                单段最长秒数
                <span v-if="isBotDirty('QQ_VOICE_OUTPUT_MAX_SECONDS')" class="bc-field-modified">已修改</span>
              </span>
              <input
                type="number"
                min="1"
                step="1"
                :value="envDraft.QQ_VOICE_OUTPUT_MAX_SECONDS || '45'"
                @input="setBotEnv('QQ_VOICE_OUTPUT_MAX_SECONDS', ($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>

          <label class="bc-field">
            <span class="bc-field-label">
              合成超时时间
              <span v-if="isBotDirty('QQ_VOICE_SYNTH_TIMEOUT_MS')" class="bc-field-modified">已修改</span>
            </span>
            <input
              type="number"
              min="1"
              step="1"
              :value="synthTimeoutSeconds"
              @input="setSynthTimeoutSeconds(Number(($event.target as HTMLInputElement).value))"
            />
            <em class="bc-field-note">单位：秒</em>
          </label>
        </div>
      </section>

      <section class="bc-tts-card">
        <div class="bc-tts-card-head">
          <h3>合成参数</h3>
          <span
            v-if="localConfigDirty"
            class="bc-badge bc-badge-primary"
          >已修改</span>
        </div>

        <div class="bc-tts-form">
          <div class="bc-tts-field-row">
            <label class="bc-field">
              <span class="bc-field-label">
                文本语言
                <span v-if="isLocalDirty('VOICE_TTS_TEXT_LANG')" class="bc-field-modified">已修改</span>
              </span>
              <select
                :value="ttsEnvDraft.VOICE_TTS_TEXT_LANG"
                :disabled="!localGatewayManageable"
                @change="setTtsEnv('VOICE_TTS_TEXT_LANG', ($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="[value, label] in textLangOptions"
                  :key="value"
                  :value="value"
                >
                  {{ label }}
                </option>
              </select>
            </label>

            <label class="bc-field">
              <span class="bc-field-label">
                参考语言
                <span v-if="isLocalDirty('VOICE_TTS_PROMPT_LANG')" class="bc-field-modified">已修改</span>
              </span>
              <select
                :value="ttsEnvDraft.VOICE_TTS_PROMPT_LANG"
                :disabled="!localGatewayManageable"
                @change="setTtsEnv('VOICE_TTS_PROMPT_LANG', ($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="[value, label] in promptLangOptions"
                  :key="value"
                  :value="value"
                >
                  {{ label }}
                </option>
              </select>
            </label>
          </div>

          <div class="bc-tts-field-row">
            <label class="bc-field">
              <span class="bc-field-label">输出格式</span>
              <select
                :value="ttsEnvDraft.VOICE_TTS_MEDIA_TYPE || 'wav'"
                disabled
              >
                <option value="wav">wav</option>
              </select>
            </label>

            <label class="bc-field">
              <span class="bc-field-label">
                切分方法
                <span v-if="isLocalDirty('VOICE_TTS_SPLIT_METHOD')" class="bc-field-modified">已修改</span>
              </span>
              <select
                :value="ttsEnvDraft.VOICE_TTS_SPLIT_METHOD"
                :disabled="!localGatewayManageable"
                @change="setTtsEnv('VOICE_TTS_SPLIT_METHOD', ($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="value in splitMethodOptions"
                  :key="value"
                  :value="value"
                >
                  {{ value }}
                </option>
              </select>
            </label>
          </div>

          <div class="bc-tts-field-row">
            <label class="bc-field">
              <span class="bc-field-label">
                批量大小
                <span v-if="isLocalDirty('VOICE_TTS_BATCH_SIZE')" class="bc-field-modified">已修改</span>
              </span>
              <input
                type="number"
                min="1"
                step="1"
                :value="ttsEnvDraft.VOICE_TTS_BATCH_SIZE || '1'"
                :disabled="!localGatewayManageable"
                @input="setTtsEnv('VOICE_TTS_BATCH_SIZE', ($event.target as HTMLInputElement).value)"
              />
            </label>

            <label class="bc-field">
              <span class="bc-field-label">
                文本最大长度
                <span v-if="isLocalDirty('VOICE_TTS_MAX_TEXT_CHARS')" class="bc-field-modified">已修改</span>
              </span>
              <input
                type="number"
                min="1"
                step="1"
                :value="ttsEnvDraft.VOICE_TTS_MAX_TEXT_CHARS || '200'"
                :disabled="!localGatewayManageable"
                @input="setTtsEnv('VOICE_TTS_MAX_TEXT_CHARS', ($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>

          <div class="bc-tts-field-row">
            <label class="bc-field">
              <span class="bc-field-label">
                推理设备
                <span v-if="isLocalDirty('VOICE_TTS_DEVICE')" class="bc-field-modified">已修改</span>
              </span>
              <select
                :value="ttsEnvDraft.VOICE_TTS_DEVICE"
                :disabled="!localGatewayManageable"
                @change="setTtsEnv('VOICE_TTS_DEVICE', ($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="value in deviceOptions"
                  :key="value"
                  :value="value"
                >
                  {{ value }}
                </option>
              </select>
            </label>

            <div class="bc-tts-toggle-row">
              <span>半精度</span>
              <button
                type="button"
                :class="['bc-tts-switch', normalizeBoolean(ttsEnvDraft.VOICE_TTS_IS_HALF) ? 'is-on' : '']"
                :disabled="!localGatewayManageable"
                @click="setTtsBoolean('VOICE_TTS_IS_HALF', !normalizeBoolean(ttsEnvDraft.VOICE_TTS_IS_HALF))"
              >
                {{ normalizeBoolean(ttsEnvDraft.VOICE_TTS_IS_HALF) ? '开' : '关' }}
              </button>
            </div>
          </div>

          <div class="bc-tts-toggle-row">
            <span>并行推理</span>
            <button
              type="button"
              :class="['bc-tts-switch', normalizeBoolean(ttsEnvDraft.VOICE_TTS_PARALLEL_INFER) ? 'is-on' : '']"
              :disabled="!localGatewayManageable"
              @click="setTtsBoolean('VOICE_TTS_PARALLEL_INFER', !normalizeBoolean(ttsEnvDraft.VOICE_TTS_PARALLEL_INFER))"
            >
              {{ normalizeBoolean(ttsEnvDraft.VOICE_TTS_PARALLEL_INFER) ? '开' : '关' }}
            </button>
          </div>
        </div>
      </section>

      <section class="bc-tts-card bc-tts-card-wide">
        <div class="bc-tts-card-head">
          <h3>声线与模型</h3>
          <span
            v-if="!localGatewayManageable"
            class="bc-badge bc-badge-muted"
          >远端模式</span>
        </div>

        <div class="bc-tts-form">
          <div class="bc-tts-field-row">
            <label class="bc-field">
              <span class="bc-field-label">声线</span>
              <select disabled>
                <option>sakiko</option>
              </select>
            </label>

            <label class="bc-field">
              <span class="bc-field-label">
                模型版本
                <span v-if="isLocalDirty('VOICE_TTS_VERSION')" class="bc-field-modified">已修改</span>
              </span>
              <select
                :value="ttsEnvDraft.VOICE_TTS_VERSION"
                :disabled="!localGatewayManageable"
                @change="setTtsEnv('VOICE_TTS_VERSION', ($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="value in versionOptions"
                  :key="value"
                  :value="value"
                >
                  {{ value }}
                </option>
              </select>
            </label>
          </div>

          <div class="bc-tts-style-grid">
            <button
              type="button"
              :class="['bc-tts-style-card', sampleStyle === 'white' ? 'is-active' : '']"
              @click="sampleStyle = 'white'"
            >
              <strong>white</strong>
              <span>明亮清澈，柔和自然</span>
            </button>
            <button
              type="button"
              :class="['bc-tts-style-card', sampleStyle === 'black' ? 'is-active' : '']"
              @click="sampleStyle = 'black'"
            >
              <strong>black</strong>
              <span>温暖磁性，沉稳饱满</span>
            </button>
          </div>

          <label class="bc-field">
            <span class="bc-field-label">
              GPT 模型权重
              <span v-if="isLocalDirty('VOICE_TTS_GPT_WEIGHTS')" class="bc-field-modified">已修改</span>
            </span>
            <input
              type="text"
              :value="ttsEnvDraft.VOICE_TTS_GPT_WEIGHTS ?? ''"
              :disabled="!localGatewayManageable"
              spellcheck="false"
              @input="setTtsEnv('VOICE_TTS_GPT_WEIGHTS', ($event.target as HTMLInputElement).value)"
            />
          </label>

          <label class="bc-field">
            <span class="bc-field-label">
              SoVITS 模型权重
              <span v-if="isLocalDirty('VOICE_TTS_SOVITS_WEIGHTS')" class="bc-field-modified">已修改</span>
            </span>
            <input
              type="text"
              :value="ttsEnvDraft.VOICE_TTS_SOVITS_WEIGHTS ?? ''"
              :disabled="!localGatewayManageable"
              spellcheck="false"
              @input="setTtsEnv('VOICE_TTS_SOVITS_WEIGHTS', ($event.target as HTMLInputElement).value)"
            />
          </label>

          <div class="bc-tts-field-row">
            <label class="bc-field">
              <span class="bc-field-label">
                BERT 预训练
                <span v-if="isLocalDirty('VOICE_TTS_BERT_BASE')" class="bc-field-modified">已修改</span>
              </span>
              <input
                type="text"
                :value="ttsEnvDraft.VOICE_TTS_BERT_BASE ?? ''"
                :disabled="!localGatewayManageable"
                spellcheck="false"
                @input="setTtsEnv('VOICE_TTS_BERT_BASE', ($event.target as HTMLInputElement).value)"
              />
            </label>

            <label class="bc-field">
              <span class="bc-field-label">
                HuBERT 预训练
                <span v-if="isLocalDirty('VOICE_TTS_HUBERT_BASE')" class="bc-field-modified">已修改</span>
              </span>
              <input
                type="text"
                :value="ttsEnvDraft.VOICE_TTS_HUBERT_BASE ?? ''"
                :disabled="!localGatewayManageable"
                spellcheck="false"
                @input="setTtsEnv('VOICE_TTS_HUBERT_BASE', ($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>
        </div>
      </section>
    </div>

    <section class="bc-tts-diagnostics">
      <div class="bc-tts-card-head">
        <h3>试听与诊断</h3>
        <span
          v-if="tailnetService"
          :class="['bc-badge', `bc-badge-${getActiveStateTone(tailnetService.activeState)}`]"
        >Tailnet {{ tailnetService.activeState }}</span>
      </div>

      <div class="bc-tts-diagnostic-grid">
        <label class="bc-field bc-tts-sample-text">
          <span class="bc-field-label">合成文本（示例）</span>
          <textarea
            v-model="sampleText"
            maxlength="500"
          />
          <em class="bc-field-note">{{ sampleText.length }} / 500</em>
        </label>

        <div class="bc-tts-diagnostic-side">
          <div class="bc-tts-segment">
            <button
              type="button"
              :class="{ 'is-active': sampleStyle === 'white' }"
              @click="sampleStyle = 'white'"
            >
              white
            </button>
            <button
              type="button"
              :class="{ 'is-active': sampleStyle === 'black' }"
              @click="sampleStyle = 'black'"
            >
              black
            </button>
          </div>

          <div class="bc-tts-action-row">
            <button
              type="button"
              class="bc-btn bc-btn-primary"
              :disabled="synthPending || !sampleText.trim()"
              @click="handleSynthesize"
            >
              {{ synthPending ? '合成中…' : '试听' }}
            </button>
            <button
              type="button"
              class="bc-btn"
              :disabled="healthPending"
              @click="handleHealthProbe(true)"
            >
              {{ healthPending ? '检查中…' : '健康检查' }}
            </button>
            <button
              type="button"
              class="bc-btn bc-btn-danger"
              :disabled="!localGatewayManageable || !!servicePending['qqbot-voice-tts.service']"
              @click="handleRestartTts"
            >
              {{ servicePending['qqbot-voice-tts.service'] ? '重启中…' : '重启 TTS' }}
            </button>
          </div>

          <div class="bc-tts-result">
            <div>
              <span class="bc-muted">最近一次结果</span>
              <strong>{{ sampleResult ? '成功' : health?.status === 'ok' ? '健康' : '未记录' }}</strong>
            </div>
            <div>
              <span>耗时</span>
              <strong>{{ sampleResult ? formatSeconds(sampleResult.elapsedMs) : '-' }}</strong>
            </div>
            <div>
              <span>时长</span>
              <strong>{{ sampleResult ? formatDuration(sampleResult.audio.durationSeconds) : '-' }}</strong>
            </div>
            <div>
              <span>采样率</span>
              <strong>{{ sampleResult ? formatSampleRate(sampleResult.audio.sampleRate) : '-' }}</strong>
            </div>
            <div class="bc-tts-audio-cell">
              <audio
                v-if="sampleResult"
                :src="sampleResult.dataUri"
                controls
              />
              <a
                v-if="sampleResult"
                :href="sampleResult.dataUri"
                download="tts-sample.wav"
              >
                下载音频
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  </section>
</template>
