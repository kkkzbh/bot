<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue'
import { send } from '@koishijs/client'
import { useToast } from '../../composables/useToast'
import type { GetRecentLogsResponse } from '../../types'

const { add: toastAdd } = useToast()

const lines    = ref<string[]>([])
const loading  = ref(false)
const logEl    = ref<HTMLDivElement | null>(null)

// ── Log line classification ──────────────────────────────────────────────────

type LineClass = 'is-error' | 'is-warn' | 'is-debug' | ''

function classifyLine(line: string): LineClass {
  const low = line.toLowerCase()
  // Match common log level patterns: [ERROR], ERROR:, level=error, etc.
  if (/\b(error|err|critical|fatal|crit)\b/.test(low)) return 'is-error'
  if (/\b(warn|warning)\b/.test(low)) return 'is-warn'
  if (/\b(debug|trace|verbose)\b/.test(low)) return 'is-debug'
  return ''
}

// ── Data fetching ────────────────────────────────────────────────────────────

async function fetchLogs() {
  loading.value = true
  try {
    const result = await send<GetRecentLogsResponse>('bot-console/get-recent-logs')
    lines.value = result?.lines ?? []
    await nextTick()
    scrollToBottom()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    toastAdd(message || '日志加载失败', 'error')
  } finally {
    loading.value = false
  }
}

function scrollToBottom() {
  const el = logEl.value
  if (el) el.scrollTop = el.scrollHeight
}

function scrollToTop() {
  const el = logEl.value
  if (el) el.scrollTop = 0
}

onMounted(fetchLogs)
</script>

<template>
  <article class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <h2>运行日志</h2>
        <p>显示最近一批 Koishi 运行日志，用于快速定位异常。</p>
      </div>
      <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
        <span v-if="lines.length" class="bc-badge bc-badge-muted">
          {{ lines.length }} 行
        </span>
        <button
          class="bc-btn bc-btn-sm bc-btn-ghost"
          :disabled="loading"
          title="跳到顶部"
          @click="scrollToTop"
        >↑ 顶部</button>
        <button
          class="bc-btn bc-btn-sm bc-btn-ghost"
          :disabled="loading"
          title="跳到底部"
          @click="scrollToBottom"
        >↓ 底部</button>
        <button
          class="bc-btn bc-btn-sm"
          :disabled="loading"
          @click="fetchLogs"
        >
          {{ loading ? '加载中…' : '刷新日志' }}
        </button>
      </div>
    </div>

    <!-- Log output -->
    <div ref="logEl" class="bc-log-container" style="margin-top: 1rem;">
      <!-- Loading skeleton -->
      <template v-if="loading && lines.length === 0">
        <span class="bc-log-empty">正在加载日志…</span>
      </template>

      <!-- Empty state -->
      <template v-else-if="!loading && lines.length === 0">
        <span class="bc-log-empty">暂无日志记录。</span>
      </template>

      <!-- Log lines -->
      <template v-else>
        <span
          v-for="(line, idx) in lines"
          :key="idx"
          :class="['bc-log-line', classifyLine(line)]"
        >{{ line }}</span>
      </template>
    </div>

    <!-- Legend -->
    <div
      v-if="lines.length > 0"
      style="
        display: flex;
        gap: 1rem;
        margin-top: 0.6rem;
        flex-wrap: wrap;
        font-size: 0.76rem;
        color: var(--k-text-light);
      "
    >
      <span style="display: flex; align-items: center; gap: 0.3rem;">
        <span style="color: var(--k-color-danger);">■</span> 错误
      </span>
      <span style="display: flex; align-items: center; gap: 0.3rem;">
        <span style="color: var(--k-color-warning);">■</span> 警告
      </span>
      <span style="display: flex; align-items: center; gap: 0.3rem;">
        <span style="color: var(--k-text-light);">■</span> 调试
      </span>
    </div>
  </article>
</template>
