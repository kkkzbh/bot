<script setup lang="ts">
import { inject } from 'vue'
import { useToast } from '../../composables/useToast'
import { MODEL_KEYS } from '../../composables/useBotConsole'
import { getFieldLabel, getFieldHint } from '../../utils/constants'
import type { useBotConsole } from '../../composables/useBotConsole'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

// Destructure reactive values for template auto-unwrapping
const { envDraft, changedKeys, canSaveEnv } = bc

function inputType(key: string): string {
  return key.includes('API_KEY') ? 'password' : 'text'
}

async function handleSave() {
  try {
    await bc.saveEnv(false)
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
        <p>填写模型接口地址、密钥和各链路使用的模型名称。保存后重启机器人生效。</p>
      </div>
      <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
        <span
          v-if="changedKeys.size > 0"
          class="bc-badge bc-badge-primary"
        >{{ changedKeys.size }} 项已修改</span>
        <button
          class="bc-btn bc-btn-primary"
          type="button"
          :disabled="!canSaveEnv"
          @click="handleSave"
        >
          保存配置
        </button>
      </div>
    </div>

    <div class="bc-field-grid" style="margin-top: 1rem;">
      <label
        v-for="key in MODEL_KEYS"
        :key="key"
        class="bc-field"
      >
        <span class="bc-field-label">
          <span>{{ getFieldLabel(key) }}</span>
          <!-- Inline tooltip for keys that have hints -->
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
  </article>
</template>
