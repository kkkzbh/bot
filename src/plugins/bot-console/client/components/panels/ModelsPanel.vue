<script setup lang="ts">
import { computed, inject } from 'vue'
import { useToast } from '../../composables/useToast'
import { MODEL_SHARED_KEYS, MODEL_TAB_IDS } from '../../composables/useBotConsole'
import { getFieldHint, getFieldLabel } from '../../utils/constants'
import type { BotConsoleModelTabId } from '../../types'
import type { useBotConsole } from '../../composables/useBotConsole'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

const {
  envDraft,
  changedKeys,
  activeModelTab,
  currentModelTabDraft,
  canSaveModelSettings,
  selectModelTab,
} = bc

const tabTitles: Record<BotConsoleModelTabId, string> = {
  siliconflow: '硅基流动',
  openai: 'OpenAI',
}

const currentTabModelHint = computed(() => currentModelTabDraft.value.modelHint)

function inputType(key: string): string {
  return key.includes('API_KEY') ? 'password' : 'text'
}

function setTabField(key: 'baseUrl' | 'apiKey' | 'defaultModel', value: string) {
  currentModelTabDraft.value[key] = value
}

async function handleSave() {
  try {
    await bc.saveModelSettings(false)
    toastAdd('模型配置已保存', 'success')
  } catch (err: unknown) {
    toastAdd(err instanceof Error ? err.message : '保存失败', 'error')
  }
}
</script>

<template>
  <article class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <h2>模型接口</h2>
        <p>固定内置两个主聊天 provider Tab。保存后重启机器人生效。</p>
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

        <div class="bc-field-grid" style="margin-top: 1rem;">
          <label class="bc-field">
            <span class="bc-field-label">
              <span>对话模型接口地址</span>
            </span>
            <input
              type="text"
              :value="currentModelTabDraft.baseUrl"
              spellcheck="false"
              autocomplete="off"
              @input="(e) => setTabField('baseUrl', (e.target as HTMLInputElement).value)"
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
