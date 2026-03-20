/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, never>, Record<string, never>, any>
  export default component
}

declare module '@koishijs/client' {
  export function send<T = any>(event: string, ...args: any[]): Promise<T>
  export const store: Record<string, any>
}
