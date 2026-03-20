<script setup lang="ts">
import { inject } from 'vue'
import { useToast } from '../../composables/useToast'
import { getFieldLabel } from '../../utils/constants'
import { FEATURE_KEYS, normalizeBoolean } from '../../composables/useBotConsole'
import type { useBotConsole } from '../../composables/useBotConsole'
import ToggleCard from '../ToggleCard.vue'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

// Destructure reactive values so they auto-unwrap in the template
const { envDraft, changedKeys, canSaveEnv } = bc

async function handleSave() {
  try {
    await bc.saveEnv(false)
    toastAdd('功能配置已保存', 'success')
  } catch (e: unknown) {
    toastAdd(e instanceof Error ? e.message : '保存失败', 'error')
  }
}
</script>

<template>
  <section class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <h2>功能开关</h2>
        <p class="bc-muted">常用功能都可以在这里直接开关。修改后点击保存配置，重启机器人后生效。</p>
      </div>
      <button
        type="button"
        class="bc-btn bc-btn-primary"
        :disabled="!canSaveEnv"
        @click="handleSave"
      >
        保存配置
      </button>
    </div>

    <div class="bc-toggle-grid">
      <ToggleCard
        v-for="key in FEATURE_KEYS"
        :key="key"
        :label="getFieldLabel(key)"
        :model-value="normalizeBoolean(envDraft[key])"
        :is-dirty="changedKeys.has(key)"
        @update:model-value="(value) => { envDraft[key] = String(value) }"
      />
    </div>
  </section>
</template>
