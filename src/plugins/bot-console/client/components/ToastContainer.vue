<script setup lang="ts">
import { useToast } from '../composables/useToast'

const { toasts, dismiss } = useToast()
</script>

<template>
  <div class="bc-toast-container" aria-live="polite" aria-atomic="false">
    <TransitionGroup name="toast-list" tag="div" class="bc-toast-inner">
      <div
        v-for="t in toasts"
        :key="t.id"
        :class="['bc-toast', t.type]"
        role="alert"
      >
        <span class="bc-toast-icon" aria-hidden="true">
          <template v-if="t.type === 'success'">✓</template>
          <template v-else-if="t.type === 'error'">✗</template>
          <template v-else-if="t.type === 'warning'">!</template>
          <template v-else>i</template>
        </span>
        <span class="bc-toast-message">{{ t.message }}</span>
        <button
          class="bc-toast-close"
          type="button"
          :aria-label="`关闭提示：${t.message}`"
          @click="dismiss(t.id)"
        >×</button>
      </div>
    </TransitionGroup>
  </div>
</template>
