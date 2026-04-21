<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, watch } from 'vue'
import { useToast } from '../../composables/useToast'
import { MODEL_SHARED_KEYS, MODEL_TAB_IDS, SILICONFLOW_FIXED_MODEL } from '../../composables/useBotConsole'
import { getFieldHint, getFieldLabel } from '../../utils/constants'
import type { BotConsoleModelTabId } from '../../types'
import type { useBotConsole } from '../../composables/useBotConsole'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

const {
  envDraft,
  changedKeys,
  activeModelTab,
  copilotAuthAttempt,
  currentModelTabDraft,
  canSaveModelSettings,
  selectModelTab,
} = bc

const {
  startCopilotAuth,
  pollCopilotAuth,
  cancelCopilotAuth,
  logoutCopilotAuth,
  refreshCopilotAuthStatus,
} = bc

const tabTitles: Record<BotConsoleModelTabId, string> = {
  siliconflow: '硅基流动',
  openai: 'OpenAI',
  copilot: 'GitHub Copilot',
}

const currentTabModelHint = computed(() => currentModelTabDraft.value.modelHint)
const siliconflowModelOptions = [SILICONFLOW_FIXED_MODEL] as const

function inputType(key: string): string {
  return key.includes('API_KEY') ? 'password' : 'text'
}

function setTabField(key: 'baseUrl' | 'apiKey' | 'defaultModel', value: string) {
  currentModelTabDraft.value[key] = value
}

const isCopilotTab = computed(() => activeModelTab.value === 'copilot')
const isSiliconflowTab = computed(() => activeModelTab.value === 'siliconflow')
const copilotStatusTone = computed(() => {
  switch (currentModelTabDraft.value.authStatus) {
    case 'ready':
      return 'is-success'
    case 'pending':
      return 'is-warning'
    case 'error':
    case 'expired':
      return 'is-danger'
    default:
      return 'is-muted'
  }
})
const copilotStatusLabel = computed(() => {
  switch (currentModelTabDraft.value.authStatus) {
    case 'ready':
      return '已登录'
    case 'pending':
      return '登录中'
    case 'expired':
      return '已过期'
    case 'error':
      return '错误'
    default:
      return '未登录'
  }
})

let copilotPollTimer: number | null = null

function stopCopilotPolling() {
  if (copilotPollTimer != null) {
    window.clearTimeout(copilotPollTimer)
    copilotPollTimer = null
  }
}

function scheduleCopilotPolling() {
  stopCopilotPolling()
  const attempt = copilotAuthAttempt.value
  if (!attempt || attempt.state !== 'pending') return
  const delay = Math.max(250, attempt.nextPollAt - Date.now())
  copilotPollTimer = window.setTimeout(async () => {
    try {
      const result = await pollCopilotAuth(attempt.attemptId)
      if (result.authStatus === 'ready') {
        toastAdd('GitHub Copilot OAuth 登录成功', 'success')
      } else if (result.authStatus === 'error' || result.authStatus === 'expired') {
        toastAdd(result.authError || 'GitHub Copilot OAuth 登录失败', 'error')
      }
    } catch (err: unknown) {
      toastAdd(err instanceof Error ? err.message : 'GitHub Copilot 状态轮询失败', 'error')
    } finally {
      scheduleCopilotPolling()
    }
  }, delay)
}

async function handleStartCopilotAuth() {
  try {
    const result = await startCopilotAuth()
    scheduleCopilotPolling()
    toastAdd(`请在浏览器中输入验证码 ${result.attempt?.userCode ?? ''}`, 'success')
  } catch (err: unknown) {
    toastAdd(err instanceof Error ? err.message : '发起 GitHub Copilot OAuth 失败', 'error')
  }
}

async function handleCancelCopilotAuth() {
  try {
    await cancelCopilotAuth()
    stopCopilotPolling()
    toastAdd('已取消 GitHub Copilot OAuth 登录', 'success')
  } catch (err: unknown) {
    toastAdd(err instanceof Error ? err.message : '取消 GitHub Copilot OAuth 失败', 'error')
  }
}

async function handleLogoutCopilotAuth() {
  try {
    await logoutCopilotAuth()
    stopCopilotPolling()
    toastAdd('GitHub Copilot 授权已清除', 'success')
  } catch (err: unknown) {
    toastAdd(err instanceof Error ? err.message : '退出 GitHub Copilot OAuth 失败', 'error')
  }
}

async function handleRefreshCopilotAuth() {
  try {
    await refreshCopilotAuthStatus()
    toastAdd('GitHub Copilot 状态已刷新', 'success')
  } catch (err: unknown) {
    toastAdd(err instanceof Error ? err.message : '刷新 GitHub Copilot 状态失败', 'error')
  }
}

async function handleSave() {
  try {
    await bc.saveModelSettings(false)
    toastAdd('模型配置已保存', 'success')
  } catch (err: unknown) {
    toastAdd(err instanceof Error ? err.message : '保存失败', 'error')
  }
}

watch(copilotAuthAttempt, () => {
  scheduleCopilotPolling()
})

watch(activeModelTab, (tabId) => {
  if (tabId === 'copilot') {
    void refreshCopilotAuthStatus().catch(() => null)
  } else {
    stopCopilotPolling()
  }
})

onMounted(() => {
  if (activeModelTab.value === 'copilot') {
    void refreshCopilotAuthStatus().catch(() => null)
  }
  scheduleCopilotPolling()
})

onBeforeUnmount(() => {
  stopCopilotPolling()
})
</script>

<template>
  <article class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <h2>模型接口</h2>
        <p>固定内置三个主聊天 provider Tab。保存后重启机器人生效。</p>
      </div>
      <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
        <span
          v-if="changedKeys.size > 0"
          class="bc-badge bc-badge-primary"
        >{{ changedKeys.size }} 项全局配置已修改</span>
        <button
          class="bc-btn bc-btn-primary"
          type="button"
          :disabled="!canSaveModelSettings"
          @click="handleSave"
        >
          保存配置
        </button>
      </div>
    </div>

    <section class="bc-model-tabs">
      <div class="bc-model-tab-row">
        <button
          v-for="tabId in MODEL_TAB_IDS"
          :key="tabId"
          type="button"
          :class="['bc-model-tab', activeModelTab === tabId && 'is-active']"
          @click="selectModelTab(tabId)"
        >
          {{ tabTitles[tabId] }}
        </button>
      </div>

      <div class="bc-model-tab-card">
        <div class="bc-model-tab-head">
          <div>
            <strong>{{ tabTitles[activeModelTab] }}</strong>
            <p>{{ currentModelTabDraft.description }}</p>
          </div>
          <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
            <span class="bc-status-badge is-muted">provider: {{ currentModelTabDraft.provider }}</span>
            <span class="bc-status-badge is-muted">strategy: {{ currentModelTabDraft.strategyId }}</span>
            <span class="bc-status-badge is-muted">mode: {{ currentModelTabDraft.requestMode }}</span>
          </div>
        </div>

        <div
          v-if="!isCopilotTab"
          class="bc-field-grid"
          style="margin-top: 1rem;"
        >
          <label class="bc-field">
            <span class="bc-field-label">
              <span>对话模型接口地址</span>
            </span>
            <input
              type="text"
              :value="currentModelTabDraft.baseUrl"
              spellcheck="false"
              autocomplete="off"
              :readonly="isSiliconflowTab"
              @input="(e) => {
                if (!isSiliconflowTab) setTabField('baseUrl', (e.target as HTMLInputElement).value)
              }"
            >
          </label>

          <label class="bc-field">
            <span class="bc-field-label">
              <span>对话模型接口密钥</span>
            </span>
            <input
              type="password"
              :value="currentModelTabDraft.apiKey"
              spellcheck="false"
              autocomplete="off"
              @input="(e) => setTabField('apiKey', (e.target as HTMLInputElement).value)"
            >
          </label>

          <label class="bc-field">
            <span class="bc-field-label">
              <span>对话默认模型</span>
              <span
                class="bc-field-help"
                tabindex="0"
                :aria-label="currentTabModelHint"
              >
                <span aria-hidden="true">!</span>
                <span class="bc-field-tooltip" role="tooltip">{{ currentTabModelHint }}</span>
              </span>
            </span>
            <select
              v-if="isSiliconflowTab"
              :value="currentModelTabDraft.defaultModel"
              @change="(e) => setTabField('defaultModel', (e.target as HTMLSelectElement).value)"
            >
              <option
                v-for="model in siliconflowModelOptions"
                :key="model"
                :value="model"
              >
                {{ model }}
              </option>
            </select>
            <input
              v-else
              type="text"
              :value="currentModelTabDraft.defaultModel"
              spellcheck="false"
              autocomplete="off"
              @input="(e) => setTabField('defaultModel', (e.target as HTMLInputElement).value)"
            >
          </label>
        </div>

        <div
          v-else
          style="margin-top: 1rem; display: grid; gap: 1rem;"
        >
          <section class="bc-model-auth-card">
            <div class="bc-model-auth-head">
              <div>
                <strong>GitHub OAuth 状态</strong>
                <p class="bc-muted">本地与服务器登录状态独立保存。完成授权后，主聊天会通过本地 Copilot bridge 走 Responses API。</p>
              </div>
              <span :class="['bc-status-badge', copilotStatusTone]">{{ copilotStatusLabel }}</span>
            </div>

            <div class="bc-model-auth-body">
              <p><strong>账号：</strong>{{ currentModelTabDraft.accountLabel || '未登录' }}</p>
              <p><strong>Bridge：</strong>{{ currentModelTabDraft.baseUrl }}</p>
              <p v-if="currentModelTabDraft.authError"><strong>错误：</strong>{{ currentModelTabDraft.authError }}</p>
              <p v-if="copilotAuthAttempt">
                <strong>验证码：</strong>
                <code>{{ copilotAuthAttempt.userCode }}</code>
                <a
                  :href="copilotAuthAttempt.verificationUri"
                  target="_blank"
                  rel="noopener noreferrer"
                  style="margin-left: 0.5rem;"
                >打开 GitHub 授权页</a>
              </p>
            </div>

            <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
              <button
                class="bc-btn bc-btn-primary"
                type="button"
                :disabled="currentModelTabDraft.authStatus === 'pending'"
                @click="handleStartCopilotAuth"
              >
                开始 OAuth 登录
              </button>
              <button
                class="bc-btn"
                type="button"
                :disabled="!copilotAuthAttempt || currentModelTabDraft.authStatus !== 'pending'"
                @click="handleCancelCopilotAuth"
              >
                取消登录
              </button>
              <button
                class="bc-btn"
                type="button"
                :disabled="currentModelTabDraft.authStatus === 'unauthenticated'"
                @click="handleLogoutCopilotAuth"
              >
                退出登录
              </button>
              <button
                class="bc-btn"
                type="button"
                @click="handleRefreshCopilotAuth"
              >
                刷新状态
              </button>
            </div>
          </section>

          <div class="bc-field-grid">
            <label class="bc-field">
              <span class="bc-field-label">
                <span>对话默认模型</span>
                <span
                  class="bc-field-help"
                  tabindex="0"
                  :aria-label="currentTabModelHint"
                >
                  <span aria-hidden="true">!</span>
                  <span class="bc-field-tooltip" role="tooltip">{{ currentTabModelHint }}</span>
                </span>
              </span>
              <input
                type="text"
                :value="currentModelTabDraft.defaultModel"
                spellcheck="false"
                autocomplete="off"
                @input="(e) => setTabField('defaultModel', (e.target as HTMLInputElement).value)"
              >
            </label>
          </div>
        </div>
      </div>
    </section>

    <section class="bc-model-shared">
      <div class="bc-panel-subhead" style="margin-top: 1.25rem;">
        <div>
          <h3>全局共享模型配置</h3>
          <p class="bc-muted">这些字段不跟随上方主聊天 tab 切换，继续作为全局单份配置生效。</p>
        </div>
      </div>

      <div class="bc-field-grid" style="margin-top: 1rem;">
        <label
          v-for="key in MODEL_SHARED_KEYS"
          :key="key"
          class="bc-field"
        >
          <span class="bc-field-label">
            <span>{{ getFieldLabel(key) }}</span>
            <span
              v-if="getFieldHint(key)"
              class="bc-field-help"
              tabindex="0"
              :aria-label="getFieldHint(key)"
            >
              <span aria-hidden="true">!</span>
              <span class="bc-field-tooltip" role="tooltip">{{ getFieldHint(key) }}</span>
            </span>
            <span
              v-if="changedKeys.has(key)"
              class="bc-field-modified"
            >已修改</span>
          </span>
          <input
            :type="inputType(key)"
            :value="envDraft[key] ?? ''"
            spellcheck="false"
            autocomplete="off"
            @input="(e) => { envDraft[key] = (e.target as HTMLInputElement).value }"
          >
        </label>
      </div>
    </section>
  </article>
</template>
