<script setup lang="ts">
defineProps<{
  modelValue: boolean
  label: string
  isDirty?: boolean
}>()

defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()
</script>

<template>
  <label class="bc-toggle-card" :class="modelValue ? 'is-enabled' : 'is-disabled'">
    <span class="bc-toggle-label">{{ label }}</span>
    <span class="bc-toggle-right">
      <span v-if="isDirty" class="bc-dirty-tag">已修改</span>
      <input
        type="checkbox"
        class="bc-toggle-input"
        :checked="modelValue"
        @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
      <span class="bc-toggle-switch" aria-hidden="true">
        <span class="bc-toggle-knob" />
      </span>
    </span>
  </label>
</template>

<style scoped>
.bc-toggle-right {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  flex-shrink: 0;
}

.bc-toggle-input {
  position: absolute;
  inset: 0;
  width: 2.6rem;
  height: 1.5rem;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.bc-toggle-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 2.6rem;
  height: 1.5rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--k-fill-normal) 92%, var(--k-card-bg));
  border: 1px solid color-mix(in srgb, var(--k-card-border) 90%, transparent);
  flex-shrink: 0;
  transition:
    background 160ms ease,
    border-color 160ms ease,
    box-shadow 160ms ease;
}

.bc-toggle-knob {
  position: absolute;
  top: 50%;
  left: 0.14rem;
  width: 1.05rem;
  height: 1.05rem;
  border-radius: 50%;
  background: #fff;
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.18),
    0 2px 6px rgba(15, 23, 42, 0.08);
  transform: translate(0, -50%);
  transition:
    transform 160ms ease,
    background 160ms ease;
}

.bc-toggle-input:checked + .bc-toggle-switch {
  background: var(--k-color-success-fade);
  border-color: var(--k-color-success);
}

.bc-toggle-input:checked + .bc-toggle-switch .bc-toggle-knob {
  transform: translate(1.08rem, -50%);
}

.bc-toggle-input:focus-visible + .bc-toggle-switch {
  box-shadow: 0 0 0 3px var(--k-color-primary-fade, rgba(59, 130, 246, 0.16));
}
</style>
