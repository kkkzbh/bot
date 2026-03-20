import { ref } from 'vue'

export type ToastType = 'success' | 'warning' | 'error' | 'info'

export interface Toast {
  id: number
  message: string
  type: ToastType
}

// Singleton pattern - shared across all uses of useToast()
const toasts = ref<Toast[]>([])

export function useToast() {
  function add(message: string, type: ToastType = 'info', duration = 3500) {
    const id = Date.now() + Math.random()
    toasts.value.push({ id, message, type })
    setTimeout(() => dismiss(id), duration)
  }

  function dismiss(id: number) {
    toasts.value = toasts.value.filter((t: Toast) => t.id !== id)
  }

  return { toasts, add, dismiss }
}
