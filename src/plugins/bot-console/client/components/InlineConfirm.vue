<script setup lang="ts">
import { ref } from 'vue'

const props = withDefaults(defineProps<{
  label?: string
  confirmLabel?: string
  danger?: boolean
  disabled?: boolean
}>(), {
  label: '删除',
  confirmLabel: '确认删除',
  danger: true,
})

const emit = defineEmits<{
  (e: 'confirm'): void
}>()

const pending = ref(false)

function handleInitialClick() {
  if (props.disabled) return
  pending.value = true
}

function handleConfirm() {
  emit('confirm')
  pending.value = false
}

function handleCancel() {
  pending.value = false
}
</script>

<template>
  <span class="bc-inline-confirm">
    <template v-if="!pending">
      <button
        type="button"
        :class="['bc-btn', 'bc-btn-sm', danger ? 'bc-btn-danger' : 'bc-btn']"
        :disabled="disabled"
        @click="handleInitialClick"
      >
        {{ label }}
      </button>
    </template>

    <template v-else>
      <span class="bc-inline-confirm-prompt bc-text-muted">确认？</span>
      <button
        type="button"
        class="bc-btn bc-btn-sm bc-btn-danger"
        @click="handleConfirm"
      >
        {{ confirmLabel }}
      </button>
      <button
        type="button"
        class="bc-btn bc-btn-sm bc-btn-ghost"
        @click="handleCancel"
      >
        取消
      </button>
    </template>
  </span>
</template>

<style scoped>
.bc-inline-confirm {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.bc-inline-confirm-prompt {
  font-size: 0.85rem;
}
</style>
