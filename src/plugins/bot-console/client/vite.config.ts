import { defineConfig, type LibraryFormats } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

const outDir = process.env.QQBOT_CONSOLE_OUT_DIR
  ? resolve(process.env.QQBOT_CONSOLE_OUT_DIR)
  : resolve(__dirname, '../../../../dist/plugins/bot-console/client')

export default defineConfig({
  plugins: [vue({})],
  build: {
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      formats: ['es'] as LibraryFormats[],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['vue', '@koishijs/client', '@vueuse/core'],
      output: {
        entryFileNames: 'index.js',
        assetFileNames: 'style[extname]',
      },
    },
    outDir,
    emptyOutDir: true,
    cssCodeSplit: false,
  },
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
})
