import { defineConfig, type LibraryFormats } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

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
    outDir: resolve(
      __dirname,
      '../../../../node_modules/.cache/qqbot-bot-console',
    ),
    emptyOutDir: true,
    cssCodeSplit: false,
  },
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
})
