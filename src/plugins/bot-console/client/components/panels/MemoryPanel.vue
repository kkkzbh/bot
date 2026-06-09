<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue'
import { useToast } from '../../composables/useToast'
import type { useBotConsole } from '../../composables/useBotConsole'
import { formatDateTime } from '../../utils/format'
import type {
  BotConsoleMemoryEpisodeItem,
  BotConsoleMemoryFactItem,
  BotConsoleMemoryPendingReviewItem,
  BotConsoleMemoryUserItem,
  MemorySensitivity,
  MemoryVisibility,
} from '../../types'

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

const { memoryState, memoryLoading } = bc
const userQuery = ref('')
const selectedUserKey = ref('')

const filteredUsers = computed<BotConsoleMemoryUserItem[]>(() => {
  const users = memoryState.value?.users ?? []
  const query = userQuery.value.trim().toLowerCase()
  if (!query) return users
  return users.filter(user =>
    [user.label, user.userKey, user.userId ?? '', user.platform ?? '']
      .some(value => value.toLowerCase().includes(query)),
  )
})

const selectedUser = computed<BotConsoleMemoryUserItem | null>(() => {
  const users = memoryState.value?.users ?? []
  return users.find(user => user.userKey === selectedUserKey.value) ?? users[0] ?? null
})

const selectedFacts = computed<BotConsoleMemoryFactItem[]>(() => {
  const key = selectedUser.value?.userKey
  if (!key) return []
  return (memoryState.value?.facts ?? []).filter(item => item.userKey === key)
})

const selectedEpisodes = computed<BotConsoleMemoryEpisodeItem[]>(() => {
  const key = selectedUser.value?.userKey
  if (!key) return []
  return (memoryState.value?.episodes ?? []).filter(item => item.userKey === key)
})

const selectedPending = computed<BotConsoleMemoryPendingReviewItem[]>(() => {
  const key = selectedUser.value?.userKey
  if (!key) return []
  return (memoryState.value?.pendingReview ?? []).filter(item => item.userKey === key)
})

const selectedJobs = computed(() => {
  const key = selectedUser.value?.userKey
  if (!key) return []
  return (memoryState.value?.jobs ?? []).filter(item => item.userKey === key)
})

const selectedAudit = computed(() => {
  const key = selectedUser.value?.userKey
  if (!key) return []
  return (memoryState.value?.audit ?? []).filter(item => item.userKey === key).slice(0, 30)
})

watch(
  filteredUsers,
  users => {
    if (!users.some(user => user.userKey === selectedUserKey.value)) {
      selectedUserKey.value = users[0]?.userKey ?? ''
    }
  },
  { immediate: true },
)

function visibilityLabel(value: MemoryVisibility): string {
  const map: Record<MemoryVisibility, string> = {
    global: '全局',
    private_only: '私聊',
    source_context_only: '来源上下文',
    allowed_contexts: '白名单上下文',
    denied_contexts: '黑名单上下文',
    pending_review: '待审核',
    archived: '归档',
  }
  return map[value] ?? value
}

function sensitivityLabel(value: MemorySensitivity): string {
  const map: Record<MemorySensitivity, string> = {
    low: '低',
    personal: '个人',
    sensitive: '敏感',
    secret: '密钥',
  }
  return map[value] ?? value
}

function formatScore(value: number): string {
  return Number(value ?? 0).toFixed(2).replace(/\.00$/, '')
}

function parseCandidatePayload(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    return String(parsed.content ?? parsed.summary ?? parsed.title ?? parsed.dropReason ?? payload)
  } catch {
    return payload
  }
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

async function handleForget(type: 'fact' | 'episode', id: number) {
  const userKey = selectedUser.value?.userKey
  if (!userKey) return
  try {
    await bc.forgetMemory({ userKey, type, id })
    toastAdd('已删除并写入 tombstone', 'success')
  } catch (error: unknown) {
    toastAdd(error instanceof Error ? error.message : '删除失败', 'error')
  }
}

async function handleVisibility(type: 'fact' | 'episode', id: number, visibility: MemoryVisibility) {
  const userKey = selectedUser.value?.userKey
  if (!userKey) return
  try {
    await bc.updateMemoryVisibility({ userKey, type, id, visibility })
    toastAdd('可见性已更新', 'success')
  } catch (error: unknown) {
    toastAdd(error instanceof Error ? error.message : '更新失败', 'error')
  }
}

async function handleReview(candidateId: number, action: 'approve' | 'reject' | 'private') {
  try {
    await bc.reviewMemoryCandidate({ candidateId, action })
    toastAdd('审核状态已更新', 'success')
  } catch (error: unknown) {
    toastAdd(error instanceof Error ? error.message : '审核失败', 'error')
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
        <h2>memory-v3</h2>
        <p class="bc-muted">按用户查看 facts、episodes、审核队列、任务与审计。</p>
      </div>

      <div class="bc-hero-actions">
        <button class="bc-btn" type="button" :disabled="memoryLoading" @click="handleRefresh">
          {{ memoryLoading ? '刷新中...' : '刷新记忆' }}
        </button>
      </div>
    </div>

    <div class="bc-memory-summary-grid">
      <article class="bc-memory-summary-card">
        <span>users</span>
        <strong>{{ memoryState?.summary.userCount ?? 0 }}</strong>
        <small>按 userKey 聚合</small>
      </article>
      <article class="bc-memory-summary-card">
        <span>facts</span>
        <strong>{{ memoryState?.summary.factCount ?? 0 }}</strong>
        <small>用户画像事实</small>
      </article>
      <article class="bc-memory-summary-card">
        <span>episodes</span>
        <strong>{{ memoryState?.summary.episodeCount ?? 0 }}</strong>
        <small>历史事件</small>
      </article>
      <article class="bc-memory-summary-card">
        <span>review / jobs</span>
        <strong>{{ memoryState?.summary.pendingReviewCount ?? 0 }} / {{ memoryState?.summary.pendingJobs ?? 0 }}</strong>
        <small>待审核 / 待处理</small>
      </article>
    </div>

    <div class="bc-memory-toolbar">
      <input
        v-model="userQuery"
        class="bc-input bc-memory-search"
        type="search"
        placeholder="按 userId / userKey 搜索"
      >
    </div>

    <div v-if="memoryLoading && !memoryState" class="bc-memory-empty">
      正在加载长期记忆...
    </div>

    <div v-else-if="!memoryState?.available" class="bc-memory-empty">
      当前运行时未提供 memory-v3 数据。
    </div>

    <div v-else class="bc-memory-main">
      <aside class="bc-memory-sidebar">
        <div class="bc-memory-section-head">
          <h3>用户</h3>
          <span class="bc-muted">{{ filteredUsers.length }} 个结果</span>
        </div>

        <div class="bc-memory-scope-list">
          <button
            v-for="user in filteredUsers"
            :key="user.userKey"
            type="button"
            class="bc-memory-scope-item"
            :class="{ 'is-active': selectedUser?.userKey === user.userKey }"
            @click="selectedUserKey = user.userKey"
          >
            <div class="bc-memory-scope-head">
              <strong>{{ user.label }}</strong>
              <span class="bc-status-badge is-muted">{{ user.writeEnabled ? 'write on' : 'write off' }}</span>
            </div>
            <div class="bc-memory-meta">
              <span>{{ user.factCount }} facts</span>
              <span>{{ user.episodeCount }} episodes</span>
              <span>{{ user.pendingReviewCount }} review</span>
            </div>
            <div class="bc-memory-scope-key">{{ user.userKey }}</div>
            <div class="bc-memory-meta">
              <span>最近 {{ formatDateTime(user.latestSeenAt) }}</span>
            </div>
          </button>
        </div>
      </aside>

      <div class="bc-memory-detail">
        <template v-if="selectedUser">
          <div class="bc-memory-section-head">
            <div>
              <h3>{{ selectedUser.label }}</h3>
              <p class="bc-muted">{{ selectedUser.userKey }}</p>
            </div>
            <span class="bc-status-badge is-muted">
              read {{ selectedUser.readEnabled ? 'on' : 'off' }} / write {{ selectedUser.writeEnabled ? 'on' : 'off' }}
            </span>
          </div>

          <section class="bc-memory-record-section">
            <div class="bc-memory-section-head">
              <h3>Pending Review</h3>
              <span class="bc-muted">{{ selectedPending.length }} 条</span>
            </div>
            <div v-if="selectedPending.length === 0" class="bc-memory-empty">没有待审核候选。</div>
            <div v-else class="bc-memory-record-list">
              <article v-for="item in selectedPending" :key="`candidate-${item.id}`" class="bc-memory-record-card">
                <div class="bc-memory-record-head">
                  <strong>{{ item.candidateType }} · {{ item.providerRoute }}</strong>
                  <div class="bc-memory-pill-row">
                    <span class="bc-memory-pill">{{ sensitivityLabel(item.sensitivity) }}</span>
                    <span class="bc-memory-pill">{{ visibilityLabel(item.finalVisibility ?? item.suggestedVisibility) }}</span>
                  </div>
                </div>
                <p>{{ parseCandidatePayload(item.payload) }}</p>
                <div class="bc-memory-meta">
                  <span>{{ item.contextKey }}</span>
                  <span>{{ formatDateTime(item.createdAt) }}</span>
                </div>
                <div class="bc-status-actions">
                  <button type="button" @click="handleReview(item.id, 'approve')">通过</button>
                  <button type="button" @click="handleReview(item.id, 'private')">转私密</button>
                  <button type="button" @click="handleReview(item.id, 'reject')">拒绝</button>
                </div>
              </article>
            </div>
          </section>

          <section class="bc-memory-record-section">
            <div class="bc-memory-section-head">
              <h3>Facts</h3>
              <span class="bc-muted">{{ selectedFacts.length }} 条</span>
            </div>
            <div v-if="selectedFacts.length === 0" class="bc-memory-empty">该用户还没有 fact。</div>
            <div v-else class="bc-memory-record-list">
              <article v-for="item in selectedFacts" :key="`fact-${item.id}`" class="bc-memory-record-card">
                <div class="bc-memory-record-head">
                  <strong>{{ item.kind }} · {{ item.topicKey }}</strong>
                  <div class="bc-memory-pill-row">
                    <span class="bc-memory-pill">{{ visibilityLabel(item.visibility) }}</span>
                    <span class="bc-memory-pill">{{ sensitivityLabel(item.sensitivity) }}</span>
                    <span class="bc-memory-pill">{{ item.hasEmbedding ? '已向量化' : '待向量化' }}</span>
                  </div>
                </div>
                <p>{{ item.content }}</p>
                <div class="bc-memory-meta">
                  <span>importance {{ formatScore(item.importance) }}</span>
                  <span>confidence {{ formatScore(item.confidence) }}</span>
                  <span>source {{ item.sourceContextKey }}</span>
                  <span>最近 {{ formatDateTime(item.lastSeenAt) }}</span>
                </div>
                <div class="bc-status-actions">
                  <button type="button" @click="handleVisibility('fact', item.id, 'global')">全局</button>
                  <button type="button" @click="handleVisibility('fact', item.id, 'private_only')">私密</button>
                  <button type="button" @click="handleVisibility('fact', item.id, 'source_context_only')">来源</button>
                  <button type="button" @click="handleForget('fact', item.id)">删除</button>
                </div>
              </article>
            </div>
          </section>

          <section class="bc-memory-record-section">
            <div class="bc-memory-section-head">
              <h3>Episodes</h3>
              <span class="bc-muted">{{ selectedEpisodes.length }} 条</span>
            </div>
            <div v-if="selectedEpisodes.length === 0" class="bc-memory-empty">该用户还没有 episode。</div>
            <div v-else class="bc-memory-record-list">
              <article v-for="episode in selectedEpisodes" :key="`episode-${episode.id}`" class="bc-memory-record-card">
                <div class="bc-memory-record-head">
                  <strong>{{ episode.title }}</strong>
                  <div class="bc-memory-pill-row">
                    <span class="bc-memory-pill">{{ visibilityLabel(episode.visibility) }}</span>
                    <span class="bc-memory-pill">{{ sensitivityLabel(episode.sensitivity) }}</span>
                    <span class="bc-memory-pill">{{ episode.hasEmbedding ? '已向量化' : '待向量化' }}</span>
                  </div>
                </div>
                <p>{{ episode.summary }}</p>
                <div class="bc-memory-meta">
                  <span>importance {{ formatScore(episode.importance) }}</span>
                  <span>confidence {{ formatScore(episode.confidence) }}</span>
                  <span>source {{ episode.sourceContextKey }}</span>
                  <span>最近 {{ formatDateTime(episode.lastSeenAt) }}</span>
                </div>
                <div class="bc-status-actions">
                  <button type="button" @click="handleVisibility('episode', episode.id, 'private_only')">私密</button>
                  <button type="button" @click="handleVisibility('episode', episode.id, 'source_context_only')">来源</button>
                  <button type="button" @click="handleForget('episode', episode.id)">删除</button>
                </div>
              </article>
            </div>
          </section>

          <section class="bc-memory-record-section">
            <div class="bc-memory-section-head">
              <h3>Jobs / Audit</h3>
              <span class="bc-muted">{{ selectedJobs.length }} jobs / {{ selectedAudit.length }} audit</span>
            </div>
            <div class="bc-memory-record-list">
              <article v-for="job in selectedJobs" :key="`job-${job.id}`" class="bc-memory-record-card">
                <div class="bc-memory-record-head">
                  <strong>{{ job.jobType }} · {{ job.status }}</strong>
                  <span class="bc-memory-pill">retry {{ job.retryCount }}</span>
                </div>
                <p v-if="job.lastError">{{ job.lastError }}</p>
                <div class="bc-memory-meta">
                  <span>{{ job.contextKey || 'no context' }}</span>
                  <span>next {{ formatDateTime(job.nextRunAt) }}</span>
                </div>
              </article>
              <article v-for="event in selectedAudit" :key="`audit-${event.id}`" class="bc-memory-record-card">
                <div class="bc-memory-record-head">
                  <strong>{{ event.eventType }}</strong>
                  <span class="bc-memory-pill">{{ formatDateTime(event.createdAt) }}</span>
                </div>
                <p v-if="event.detail">{{ event.detail }}</p>
              </article>
            </div>
          </section>
        </template>

        <div v-else class="bc-memory-empty">没有用户记忆。</div>
      </div>
    </div>
  </section>
</template>
