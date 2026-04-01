<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue'
import { useToast } from '../../composables/useToast'
import type { useBotConsole } from '../../composables/useBotConsole'
import { formatDateTime } from '../../utils/format'
import type {
  BotConsoleMemoryEpisodeItem,
  BotConsoleMemoryProfileItem,
  BotConsoleMemoryJobItem,
  BotConsoleMemoryScopeSummary,
} from '../../types'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

const { memoryState, memoryLoading } = bc

const scopeQuery = ref('')
const selectedScopeKey = ref('')

const filteredScopes = computed<BotConsoleMemoryScopeSummary[]>(() => {
  const scopes = memoryState.value?.scopes ?? []
  const query = scopeQuery.value.trim().toLowerCase()
  if (!query) return scopes
  return scopes.filter((scope) =>
    [
      scope.label,
      scope.scopeKey,
      scope.userId ?? '',
      scope.groupId ?? '',
    ].some((value) => value.toLowerCase().includes(query)),
  )
})

const selectedScope = computed<BotConsoleMemoryScopeSummary | null>(() => {
  const all = memoryState.value?.scopes ?? []
  return all.find((scope) => scope.scopeKey === selectedScopeKey.value) ?? null
})

const scopeProfileItems = computed<BotConsoleMemoryProfileItem[]>(() => {
  if (!selectedScopeKey.value) return []
  return (memoryState.value?.profileItems ?? []).filter((item) => item.scopeKey === selectedScopeKey.value)
})

const scopeEpisodes = computed<BotConsoleMemoryEpisodeItem[]>(() => {
  if (!selectedScopeKey.value) return []
  return (memoryState.value?.episodes ?? []).filter((item) => item.scopeKey === selectedScopeKey.value)
})

const scopeJobs = computed<BotConsoleMemoryJobItem[]>(() => {
  if (!selectedScopeKey.value) return []
  return (memoryState.value?.jobs ?? []).filter((item) => item.scopeKey === selectedScopeKey.value)
})

watch(
  filteredScopes,
  (scopes) => {
    const stillVisible = scopes.some((scope) => scope.scopeKey === selectedScopeKey.value)
    if (!stillVisible) {
      selectedScopeKey.value = scopes[0]?.scopeKey ?? ''
    }
  },
  { immediate: true },
)

function scopeTypeLabel(scopeType: 'user' | 'user_group'): string {
  return scopeType === 'user' ? '私聊画像' : '群内画像'
}

function profileKindLabel(kind: BotConsoleMemoryProfileItem['kind']): string {
  switch (kind) {
    case 'identity':
      return '身份'
    case 'preference':
      return '偏好'
    case 'trait':
      return '特点'
    case 'boundary':
      return '边界'
    case 'plan':
      return '计划'
    case 'relationship':
      return '关系'
    default:
      return '画像'
  }
}

function formatScore(value: number): string {
  return Number(value ?? 0).toFixed(2).replace(/\.00$/, '')
}

function jobStatusLabel(job: BotConsoleMemoryJobItem): string {
  if (job.status === 'processing' && Date.now() - job.updatedAt > 5 * 60 * 1000) {
    return '处理中过久'
  }
  return job.status === 'processing' ? '处理中' : '待处理'
}

function jobStatusTone(job: BotConsoleMemoryJobItem): string {
  if (job.status === 'processing' && Date.now() - job.updatedAt > 5 * 60 * 1000) {
    return 'danger'
  }
  return job.status === 'processing' ? 'warning' : 'muted'
}

async function ensureMemoryState() {
  if (memoryState.value || memoryLoading.value) return
  try {
    await bc.refreshMemoryState()
  } catch (error: unknown) {
    toastAdd(error instanceof Error ? error.message : '加载长期记忆失败', 'error')
  }
}

async function handleRefresh() {
  try {
    await bc.refreshMemoryState()
    toastAdd('长期记忆数据已刷新', 'success')
  } catch (error: unknown) {
    toastAdd(error instanceof Error ? error.message : '刷新长期记忆失败', 'error')
  }
}

onMounted(() => {
  void ensureMemoryState()
})
</script>

<template>
  <section class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <p class="bc-eyebrow">长期记忆</p>
        <h2>记忆画像</h2>
        <p class="bc-muted">
          查看各个用户 / 群内用户 scope 的用户画像、事件记忆与当前队列状态。
        </p>
      </div>

      <div class="bc-hero-actions">
        <button
          class="bc-btn"
          type="button"
          :disabled="memoryLoading"
          @click="handleRefresh"
        >
          {{ memoryLoading ? '刷新中…' : '刷新记忆' }}
        </button>
      </div>
    </div>

    <div class="bc-memory-summary-grid">
      <article class="bc-memory-summary-card">
        <span>scope</span>
        <strong>{{ memoryState?.summary.scopeCount ?? 0 }}</strong>
        <small>私聊 {{ memoryState?.summary.userScopeCount ?? 0 }} / 群内 {{ memoryState?.summary.userGroupScopeCount ?? 0 }}</small>
      </article>
      <article class="bc-memory-summary-card">
        <span>profile</span>
        <strong>{{ memoryState?.summary.profileItemCount ?? 0 }}</strong>
        <small>用户画像条目</small>
      </article>
      <article class="bc-memory-summary-card">
        <span>episodes</span>
        <strong>{{ memoryState?.summary.episodeCount ?? 0 }}</strong>
        <small>历史事件摘要</small>
      </article>
      <article class="bc-memory-summary-card">
        <span>队列</span>
        <strong>{{ memoryState?.summary.processingJobs ?? 0 }} / {{ memoryState?.summary.pendingJobs ?? 0 }}</strong>
        <small>处理中 / 待处理</small>
      </article>
    </div>

    <div class="bc-memory-toolbar">
      <input
        v-model="scopeQuery"
        class="bc-input bc-memory-search"
        type="search"
        placeholder="按 userId / groupId / scopeKey 搜索"
      >
    </div>

    <div
      v-if="memoryLoading && !memoryState"
      class="bc-memory-empty"
    >
      正在加载长期记忆…
    </div>

    <div
      v-else-if="!memoryState?.available"
      class="bc-memory-empty"
    >
      当前运行时未提供长期记忆数据。
    </div>

    <div
      v-else
      class="bc-memory-main"
    >
      <aside class="bc-memory-sidebar">
        <div class="bc-memory-section-head">
          <h3>Scope 列表</h3>
          <span class="bc-muted">{{ filteredScopes.length }} 个结果</span>
        </div>

        <div class="bc-memory-scope-list">
          <button
            v-for="scope in filteredScopes"
            :key="scope.scopeKey"
            type="button"
            class="bc-memory-scope-item"
            :class="{ 'is-active': selectedScopeKey === scope.scopeKey }"
            @click="selectedScopeKey = scope.scopeKey"
          >
            <div class="bc-memory-scope-head">
              <strong>{{ scope.label }}</strong>
              <span class="bc-status-badge is-muted">{{ scopeTypeLabel(scope.scopeType) }}</span>
            </div>
            <div class="bc-memory-meta">
              <span>{{ scope.profileItemCount }} profile items</span>
              <span>{{ scope.episodeCount }} episodes</span>
            </div>
            <div class="bc-memory-scope-key">{{ scope.scopeKey }}</div>
            <div class="bc-memory-meta">
              <span>最近写入 {{ formatDateTime(scope.latestSeenAt) }}</span>
            </div>
          </button>
        </div>
      </aside>

      <div class="bc-memory-detail">
        <template v-if="selectedScope">
          <div class="bc-memory-section-head">
            <div>
              <h3>{{ selectedScope.label }}</h3>
              <p class="bc-muted">{{ selectedScope.scopeKey }}</p>
            </div>
            <span class="bc-status-badge is-muted">{{ scopeTypeLabel(selectedScope.scopeType) }}</span>
          </div>

          <section class="bc-memory-record-section">
            <div class="bc-memory-section-head">
              <h3>User Profile</h3>
              <span class="bc-muted">{{ scopeProfileItems.length }} 条</span>
            </div>

            <div
              v-if="scopeProfileItems.length === 0"
              class="bc-memory-empty"
            >
              该 scope 还没有用户画像。
            </div>

            <div
              v-else
              class="bc-memory-record-list"
            >
              <article
                v-for="item in scopeProfileItems"
                :key="`profile-${item.id}`"
                class="bc-memory-record-card"
              >
                <div class="bc-memory-record-head">
                  <strong>{{ profileKindLabel(item.kind) }} · {{ item.topicKey || `profile-${item.id}` }}</strong>
                  <div class="bc-memory-pill-row">
                    <span class="bc-memory-pill">{{ item.hasEmbedding ? '已向量化' : '不向量化' }}</span>
                    <span
                      v-if="item.archived"
                      class="bc-memory-pill is-archived"
                    >
                      archived
                    </span>
                  </div>
                </div>
                <p>{{ item.content }}</p>
                <div
                  v-if="item.keywords.length > 0"
                  class="bc-memory-pill-row"
                >
                  <span
                    v-for="keyword in item.keywords"
                    :key="keyword"
                    class="bc-memory-pill"
                  >
                    {{ keyword }}
                  </span>
                </div>
                <div class="bc-memory-meta">
                  <span>importance {{ formatScore(item.importance) }}</span>
                  <span>confidence {{ formatScore(item.confidence) }}</span>
                  <span>首次 {{ formatDateTime(item.firstSeenAt) }}</span>
                  <span>最近 {{ formatDateTime(item.lastSeenAt) }}</span>
                </div>
              </article>
            </div>
          </section>

          <section class="bc-memory-record-section">
            <div class="bc-memory-section-head">
              <h3>Past Episodes</h3>
              <span class="bc-muted">{{ scopeEpisodes.length }} 条</span>
            </div>

            <div
              v-if="scopeEpisodes.length === 0"
              class="bc-memory-empty"
            >
              该 scope 还没有 episode。
            </div>

            <div
              v-else
              class="bc-memory-record-list"
            >
              <article
                v-for="episode in scopeEpisodes"
                :key="`episode-${episode.id}`"
                class="bc-memory-record-card"
              >
                <div class="bc-memory-record-head">
                  <strong>{{ episode.title || `episode-${episode.id}` }}</strong>
                  <div class="bc-memory-pill-row">
                    <span class="bc-memory-pill">{{ episode.hasEmbedding ? '已向量化' : '未向量化' }}</span>
                    <span
                      v-if="episode.archived"
                      class="bc-memory-pill is-archived"
                    >
                      archived
                    </span>
                  </div>
                </div>
                <p>{{ episode.summary }}</p>
                <div
                  v-if="episode.keywords.length > 0"
                  class="bc-memory-pill-row"
                >
                  <span
                    v-for="keyword in episode.keywords"
                    :key="keyword"
                    class="bc-memory-pill"
                  >
                    {{ keyword }}
                  </span>
                </div>
                <div class="bc-memory-meta">
                  <span>importance {{ formatScore(episode.importance) }}</span>
                  <span>confidence {{ formatScore(episode.confidence) }}</span>
                  <span>区间 {{ formatDateTime(episode.periodStart) }} ~ {{ formatDateTime(episode.periodEnd) }}</span>
                  <span>最近写入 {{ formatDateTime(episode.lastSeenAt) }}</span>
                  <span>最近召回 {{ formatDateTime(episode.lastAccessedAt) }}</span>
                </div>
              </article>
            </div>
          </section>

          <section class="bc-memory-record-section">
            <div class="bc-memory-section-head">
              <h3>当前队列</h3>
              <span class="bc-muted">{{ scopeJobs.length }} 条</span>
            </div>

            <div
              v-if="scopeJobs.length === 0"
              class="bc-memory-empty"
            >
              该 scope 当前没有排队任务。
            </div>

            <div
              v-else
              class="bc-memory-job-list"
            >
              <article
                v-for="job in scopeJobs"
                :key="job.id"
                class="bc-memory-job-card"
              >
                <div class="bc-memory-record-head">
                  <strong>#{{ job.id }} · {{ job.jobType }}</strong>
                  <span :class="['bc-status-badge', `is-${jobStatusTone(job)}`]">
                    {{ jobStatusLabel(job) }}
                  </span>
                </div>
                <div class="bc-memory-meta">
                  <span>conversation {{ job.conversationId || '未知' }}</span>
                  <span>retry {{ job.retryCount }}</span>
                  <span>next {{ formatDateTime(job.nextRunAt) }}</span>
                  <span>updated {{ formatDateTime(job.updatedAt) }}</span>
                </div>
                <p
                  v-if="job.lastError"
                  class="bc-status-error"
                >
                  {{ job.lastError }}
                </p>
              </article>
            </div>
          </section>
        </template>

        <div
          v-else
          class="bc-memory-empty"
        >
          没有匹配的 scope。
        </div>
      </div>
    </div>
  </section>
</template>
