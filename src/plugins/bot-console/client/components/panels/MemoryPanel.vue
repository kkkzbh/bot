<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue'
import { useToast } from '../../composables/useToast'
import type { useBotConsole } from '../../composables/useBotConsole'
import { formatDateTime } from '../../utils/format'
import type {
  BotConsoleMemoryEpisodeItem,
  BotConsoleMemoryFactItem,
  BotConsoleMemoryUserItem,
  MemorySensitivity,
  MemoryVisibility,
} from '../../types'

type MemoryMode = 'fact' | 'episode' | 'all'
type ScopeFilter = 'all' | 'dm' | 'group'
type SortMode = 'recent' | 'importance' | 'confidence'
type ScoreFilter = 'all' | 'high' | 'medium'
type MemoryRecord =
  | { type: 'fact'; item: BotConsoleMemoryFactItem }
  | { type: 'episode'; item: BotConsoleMemoryEpisodeItem }

const bc = inject<ReturnType<typeof useBotConsole>>('bc')!
const { add: toastAdd } = useToast()

const { memoryState, memoryLoading } = bc
const userQuery = ref('')
const recordQuery = ref('')
const selectedUserKey = ref('')
const memoryMode = ref<MemoryMode>('fact')
const scopeFilter = ref<ScopeFilter>('all')
const sortMode = ref<SortMode>('recent')
const importanceFilter = ref<ScoreFilter>('all')
const confidenceFilter = ref<ScoreFilter>('all')
const factsExpanded = ref(true)
const episodesExpanded = ref(true)
const openActionMenu = ref<string | null>(null)
const failedAvatarKeys = ref<Set<string>>(new Set())

const filteredUsers = computed<BotConsoleMemoryUserItem[]>(() => {
  const users = memoryState.value?.users ?? []
  const query = userQuery.value.trim().toLowerCase()
  if (!query) return users
  return users.filter(user =>
    [user.userId ?? '', user.qqNick ?? '', user.label, user.userKey]
      .some(value => value.toLowerCase().includes(query)),
  )
})

const selectedUser = computed<BotConsoleMemoryUserItem | null>(() => {
  const users = filteredUsers.value
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

const factRecords = computed(() => filterRecords(selectedFacts.value.map(item => ({ type: 'fact' as const, item }))))
const episodeRecords = computed(() => filterRecords(selectedEpisodes.value.map(item => ({ type: 'episode' as const, item }))))

const visibleFacts = computed(() => memoryMode.value === 'episode' ? [] : factRecords.value)
const visibleEpisodes = computed(() => memoryMode.value === 'fact' ? [] : episodeRecords.value)

function filterRecords(records: MemoryRecord[]): MemoryRecord[] {
  const query = recordQuery.value.trim().toLowerCase()
  return records
    .filter(record => {
      if (scopeFilter.value === 'dm' && !record.item.sourceContextKey.includes(':dm:')) return false
      if (scopeFilter.value === 'group' && !record.item.sourceContextKey.includes(':group:')) return false
      if (!passesScore(record.item.importance, importanceFilter.value)) return false
      if (!passesScore(record.item.confidence, confidenceFilter.value)) return false
      if (!query) return true
      const text = record.type === 'fact'
        ? `${record.item.content} ${record.item.kind} ${record.item.topicKey} ${record.item.keywords.join(' ')}`
        : `${record.item.title} ${record.item.summary} ${record.item.keywords.join(' ')}`
      return text.toLowerCase().includes(query)
    })
    .sort((left, right) => {
      if (sortMode.value === 'importance') return right.item.importance - left.item.importance
      if (sortMode.value === 'confidence') return right.item.confidence - left.item.confidence
      return right.item.lastSeenAt - left.item.lastSeenAt
    })
}

function passesScore(value: number, filter: ScoreFilter): boolean {
  if (filter === 'high') return value >= 0.75
  if (filter === 'medium') return value >= 0.5
  return true
}

function visibilityLabel(value: MemoryVisibility): string {
  const map: Record<MemoryVisibility, string> = {
    global: '全局',
    private_only: '私聊',
    source_context_only: '来源',
    allowed_contexts: '白名单',
    denied_contexts: '黑名单',
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

function sourceLabel(sourceContextKey: string): string {
  const parts = sourceContextKey.split(':')
  const botIndex = parts.indexOf('bot')
  const botId = botIndex >= 0 ? parts[botIndex + 1] : ''
  const shortBot = botId ? `bot${botId.slice(-4)}` : 'bot'
  const dmIndex = parts.indexOf('dm')
  if (dmIndex >= 0) return `DM · ${shortBot}`
  const groupIndex = parts.indexOf('group')
  if (groupIndex >= 0) return `群 ${parts[groupIndex + 1] ?? ''}`
  return sourceContextKey
}

function avatarFallback(user: BotConsoleMemoryUserItem): string {
  const nick = user.qqNick?.trim() || user.label.trim()
  if (nick) return [...nick][0] ?? ''
  return (user.userId || user.userKey || '?').slice(-2)
}

function userPrimaryText(user: BotConsoleMemoryUserItem): string {
  return user.userId || user.userKey || user.label || '未知用户'
}

function userNickText(user: BotConsoleMemoryUserItem): string {
  return user.qqNick || user.label || '未知'
}

function isAvatarFailed(userKey: string): boolean {
  return failedAvatarKeys.value.has(userKey)
}

function markAvatarFailed(userKey: string): void {
  const next = new Set(failedAvatarKeys.value)
  next.add(userKey)
  failedAvatarKeys.value = next
}

function selectUser(userKey: string): void {
  selectedUserKey.value = userKey
  openActionMenu.value = null
}

function recordActionKey(type: 'fact' | 'episode', id: number): string {
  return `${type}:${id}`
}

function toggleActionMenu(type: 'fact' | 'episode', id: number): void {
  const key = recordActionKey(type, id)
  openActionMenu.value = openActionMenu.value === key ? null : key
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
    openActionMenu.value = null
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
    openActionMenu.value = null
    toastAdd('可见性已更新', 'success')
  } catch (error: unknown) {
    toastAdd(error instanceof Error ? error.message : '更新失败', 'error')
  }
}

onMounted(() => {
  void ensureMemoryState()
})
</script>

<template>
  <section class="bc-panel bc-memory-panel">
    <div v-if="memoryLoading && !memoryState" class="bc-memory-empty">
      正在加载长期记忆...
    </div>

    <div v-else-if="!memoryState?.available" class="bc-memory-empty">
      当前运行时未提供 memory 数据。
    </div>

    <div v-else class="bc-memory-layout">
      <aside class="bc-memory-sidebar">
        <div class="bc-memory-sidebar-head">
          <h2>用户</h2>
          <button class="bc-memory-filter-button" type="button" title="筛选">
            ≡
          </button>
        </div>
        <input
          v-model="userQuery"
          class="bc-input bc-memory-user-search"
          type="search"
          placeholder="搜索 QQ / 昵称"
        >

        <div class="bc-memory-user-list">
          <button
            v-for="user in filteredUsers"
            :key="user.userKey"
            type="button"
            class="bc-memory-user-item"
            :class="{ 'is-active': selectedUser?.userKey === user.userKey }"
            @click="selectUser(user.userKey)"
          >
            <span class="bc-memory-avatar">
              <img
                v-if="user.avatarUrl && !isAvatarFailed(user.userKey)"
                :src="user.avatarUrl"
                :alt="user.label"
                @error="markAvatarFailed(user.userKey)"
              >
              <span v-else>{{ avatarFallback(user) }}</span>
            </span>
            <span class="bc-memory-user-body">
              <span class="bc-memory-user-title">
                <strong>{{ userPrimaryText(user) }}</strong>
                <em>{{ userNickText(user) }}</em>
                <i class="bc-memory-user-dot" aria-hidden="true" />
              </span>
              <span class="bc-memory-user-counts">{{ user.factCount }} facts · {{ user.episodeCount }} episodes</span>
              <span class="bc-memory-user-meta">
                <span>最近更新 {{ formatDateTime(user.latestSeenAt) }}</span>
                <span class="bc-memory-mini-flags">
                  <b :class="{ 'is-off': !user.readEnabled }" title="read">R</b>
                  <b :class="{ 'is-off': !user.writeEnabled }" title="write">W</b>
                </span>
              </span>
            </span>
          </button>
        </div>
      </aside>

      <div class="bc-memory-detail">
        <template v-if="selectedUser">
          <header class="bc-memory-user-header">
            <div class="bc-memory-selected-user">
              <span class="bc-memory-avatar is-large">
                <img
                  v-if="selectedUser.avatarUrl && !isAvatarFailed(selectedUser.userKey)"
                  :src="selectedUser.avatarUrl"
                  :alt="selectedUser.label"
                  @error="markAvatarFailed(selectedUser.userKey)"
                >
                <span v-else>{{ avatarFallback(selectedUser) }}</span>
              </span>
              <div>
                <h2>{{ userPrimaryText(selectedUser) }} <span>{{ userNickText(selectedUser) }}</span></h2>
                <p>
                  <span>{{ selectedUser.factCount }} facts</span>
                  <span>{{ selectedUser.episodeCount }} episodes</span>
                  <span>最近更新 {{ formatDateTime(selectedUser.latestSeenAt) }}</span>
                </p>
              </div>
            </div>
            <div class="bc-memory-header-actions">
              <span class="bc-memory-mode-chip" :class="{ 'is-off': !selectedUser.readEnabled }">R 读写</span>
              <span class="bc-memory-mode-chip" :class="{ 'is-off': !selectedUser.writeEnabled }">W 读写</span>
              <button class="bc-btn" type="button" :disabled="memoryLoading" @click="handleRefresh">
                ↻ {{ memoryLoading ? '刷新中' : '刷新' }}
              </button>
            </div>
          </header>

          <div class="bc-memory-controls">
            <div class="bc-memory-tabs" role="tablist" aria-label="记忆类型">
              <button type="button" :class="{ 'is-active': memoryMode === 'fact' }" @click="memoryMode = 'fact'">事实</button>
              <button type="button" :class="{ 'is-active': memoryMode === 'episode' }" @click="memoryMode = 'episode'">事件</button>
              <button type="button" :class="{ 'is-active': memoryMode === 'all' }" @click="memoryMode = 'all'">全部</button>
            </div>
            <div class="bc-memory-filter-row">
              <select v-model="scopeFilter" class="bc-memory-select" title="范围">
                <option value="all">全部范围</option>
                <option value="dm">私聊</option>
                <option value="group">群聊</option>
              </select>
              <select v-model="sortMode" class="bc-memory-select" title="排序">
                <option value="recent">最近更新</option>
                <option value="importance">重要性</option>
                <option value="confidence">置信度</option>
              </select>
              <select v-model="importanceFilter" class="bc-memory-select" title="重要性">
                <option value="all">重要性</option>
                <option value="high">I ≥ 0.75</option>
                <option value="medium">I ≥ 0.50</option>
              </select>
              <select v-model="confidenceFilter" class="bc-memory-select" title="置信度">
                <option value="all">置信度</option>
                <option value="high">C ≥ 0.75</option>
                <option value="medium">C ≥ 0.50</option>
              </select>
              <input
                v-model="recordQuery"
                class="bc-input bc-memory-record-search"
                type="search"
                placeholder="搜索记忆内容"
              >
            </div>
          </div>

          <div class="bc-memory-record-shell">
            <section v-if="memoryMode !== 'episode'" class="bc-memory-record-section">
              <button class="bc-memory-collapse-head" type="button" @click="factsExpanded = !factsExpanded">
                <span>{{ factsExpanded ? '⌄' : '›' }}</span>
                <strong>事实 ({{ visibleFacts.length }})</strong>
              </button>
              <div v-if="factsExpanded" class="bc-memory-record-list">
                <article v-for="{ item } in visibleFacts" :key="`fact-${item.id}`" class="bc-memory-record-card">
                  <div class="bc-memory-record-main">
                    <p>{{ item.content }}</p>
                    <div class="bc-memory-pill-row">
                      <span class="bc-memory-pill">{{ visibilityLabel(item.visibility) }}</span>
                      <span class="bc-memory-pill">{{ sensitivityLabel(item.sensitivity) }}</span>
                      <span class="bc-memory-pill">{{ item.hasEmbedding ? '已向量化' : '待向量化' }}</span>
                    </div>
                  </div>
                  <div class="bc-memory-score-row">
                    <span class="bc-memory-score is-importance" title="重要性">I {{ formatScore(item.importance) }}</span>
                    <span class="bc-memory-score is-confidence" title="置信度">C {{ formatScore(item.confidence) }}</span>
                  </div>
                  <div class="bc-memory-source" :title="item.sourceContextKey">
                    <span>{{ sourceLabel(item.sourceContextKey) }}</span>
                    <span>{{ formatDateTime(item.lastSeenAt) }}</span>
                  </div>
                  <div class="bc-memory-actions">
                    <button type="button" class="bc-memory-gear" title="操作" @click="toggleActionMenu('fact', item.id)">⚙</button>
                    <div v-if="openActionMenu === recordActionKey('fact', item.id)" class="bc-memory-action-menu">
                      <button type="button" @click="handleVisibility('fact', item.id, 'global')">⊕ 全局</button>
                      <button type="button" @click="handleVisibility('fact', item.id, 'private_only')">□ 私密</button>
                      <button type="button" @click="handleVisibility('fact', item.id, 'source_context_only')">▣ 来源</button>
                      <button type="button" class="is-danger" @click="handleForget('fact', item.id)">⌫ 删除</button>
                    </div>
                  </div>
                </article>
                <div v-if="visibleFacts.length === 0" class="bc-memory-empty">没有匹配的事实。</div>
              </div>
            </section>

            <section v-if="memoryMode !== 'fact'" class="bc-memory-record-section">
              <button class="bc-memory-collapse-head" type="button" @click="episodesExpanded = !episodesExpanded">
                <span>{{ episodesExpanded ? '⌄' : '›' }}</span>
                <strong>事件 ({{ visibleEpisodes.length }})</strong>
              </button>
              <div v-if="episodesExpanded" class="bc-memory-record-list">
                <article v-for="{ item } in visibleEpisodes" :key="`episode-${item.id}`" class="bc-memory-record-card">
                  <div class="bc-memory-record-main">
                    <p>{{ item.summary || item.title }}</p>
                    <div class="bc-memory-pill-row">
                      <span class="bc-memory-pill">{{ visibilityLabel(item.visibility) }}</span>
                      <span class="bc-memory-pill">{{ sensitivityLabel(item.sensitivity) }}</span>
                      <span class="bc-memory-pill">{{ item.hasEmbedding ? '已向量化' : '待向量化' }}</span>
                    </div>
                  </div>
                  <div class="bc-memory-score-row">
                    <span class="bc-memory-score is-importance" title="重要性">I {{ formatScore(item.importance) }}</span>
                    <span class="bc-memory-score is-confidence" title="置信度">C {{ formatScore(item.confidence) }}</span>
                  </div>
                  <div class="bc-memory-source" :title="item.sourceContextKey">
                    <span>{{ sourceLabel(item.sourceContextKey) }}</span>
                    <span>{{ formatDateTime(item.lastSeenAt) }}</span>
                  </div>
                  <div class="bc-memory-actions">
                    <button type="button" class="bc-memory-gear" title="操作" @click="toggleActionMenu('episode', item.id)">⚙</button>
                    <div v-if="openActionMenu === recordActionKey('episode', item.id)" class="bc-memory-action-menu">
                      <button type="button" @click="handleVisibility('episode', item.id, 'global')">⊕ 全局</button>
                      <button type="button" @click="handleVisibility('episode', item.id, 'private_only')">□ 私密</button>
                      <button type="button" @click="handleVisibility('episode', item.id, 'source_context_only')">▣ 来源</button>
                      <button type="button" class="is-danger" @click="handleForget('episode', item.id)">⌫ 删除</button>
                    </div>
                  </div>
                </article>
                <div v-if="visibleEpisodes.length === 0" class="bc-memory-empty">没有匹配的事件。</div>
              </div>
            </section>
          </div>
        </template>

        <div v-else class="bc-memory-empty">没有用户记忆。</div>
      </div>
    </div>
  </section>
</template>
