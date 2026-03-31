<script setup lang="ts">
import { inject } from 'vue'
import { useToast } from '../../composables/useToast'
import { BASIC_KEYS } from '../../composables/useBotConsole'
import { getFieldLabel, getFieldHint } from '../../utils/constants'
import type { useBotConsole } from '../../composables/useBotConsole'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

// Destructure reactive values so refs auto-unwrap in the template
const { envDraft, changedKeys, canSaveEnv } = bc

async function handleSave() {
  try {
    await bc.saveEnv(false)
    toastAdd('基础配置已保存', 'success')
  } catch (err: unknown) {
    toastAdd(err instanceof Error ? err.message : '保存失败', 'error')
  }
}

async function handleSaveAndRestart() {
  try {
    await bc.saveEnv(true)
    toastAdd('基础配置已保存，正在重启机器人…', 'success')
  } catch (err: unknown) {
    toastAdd(err instanceof Error ? err.message : '保存并重启失败', 'error')
  }
}
</script>

<template>
  <article class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <h2>基础配置</h2>
        <p>触发词和权限设置。修改后点击保存，通常需要重启才会生效。</p>
      </div>
      <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
        <span
          v-if="changedKeys.size > 0"
          class="bc-badge bc-badge-primary"
        >{{ changedKeys.size }} 项已修改</span>
        <button
          class="bc-btn"
          :disabled="!canSaveEnv"
          type="button"
          @click="handleSave"
        >
          保存配置
        </button>
        <button
          class="bc-btn bc-btn-primary"
          :disabled="!canSaveEnv"
          type="button"
          @click="handleSaveAndRestart"
        >
          保存并重启
        </button>
      </div>
    </div>

    <div class="bc-field-grid" style="margin-top: 1rem;">
      <label
        v-for="key in BASIC_KEYS"
        :key="key"
        class="bc-field"
        :class="{ 'bc-field-span': key === 'CHAT_NATURAL_TRIGGER_ALIASES' }"
      >
        <span class="bc-field-label">
          {{ getFieldLabel(key) }}
          <span
            v-if="getFieldHint(key)"
            class="bc-field-help"
            tabindex="0"
            role="note"
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

        <!-- Multi-line textarea for alias list; single-line input for the rest -->
        <textarea
          v-if="key === 'CHAT_NATURAL_TRIGGER_ALIASES'"
          :value="envDraft[key] ?? ''"
          rows="3"
          spellcheck="false"
          :placeholder="key === 'CHAT_NATURAL_TRIGGER_ALIASES' ? '多个别名用英文逗号分隔' : ''"
          @input="(e) => { envDraft[key] = (e.target as HTMLTextAreaElement).value }"
        />
        <input
          v-else
          :type="key === 'CHATLUNA_COMMAND_AUTHORITY' ? 'number' : 'text'"
          :value="envDraft[key] ?? ''"
          :min="key === 'CHATLUNA_COMMAND_AUTHORITY' ? 0 : undefined"
          :max="key === 'CHATLUNA_COMMAND_AUTHORITY' ? 5 : undefined"
          spellcheck="false"
          :placeholder="
            key === 'CHATLUNA_COMMAND_AUTHORITY' ? '0–5，默认 1'
            : ''
          "
          @input="(e) => { envDraft[key] = (e.target as HTMLInputElement).value }"
        />

        <em
          v-if="key === 'CHATLUNA_COMMAND_AUTHORITY'"
          class="bc-field-note"
        >Koishi 权限等级（0–5），低于此级别的用户无法执行 /chatluna 命令。</em>
      </label>
    </div>
  </article>
</template>
