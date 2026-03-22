<script setup lang="ts">
import { computed } from 'vue'
import { store } from '@koishijs/client'

type AnalyticsSnapshot = {
  userCount: number
  userIncrement: number
  guildCount: number
  guildIncrement: number
  dauHistory: number[]
}

const analytics = computed(() => (store as { analytics?: AnalyticsSnapshot }).analytics ?? null)

const recentAverageDau = computed(() => {
  const history = analytics.value?.dauHistory ?? []
  const recent = history.slice(1)
  if (!recent.length) return 0
  return recent.reduce((sum, value) => sum + value, 0) / recent.length
})

function formatNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '-'
  return value.toLocaleString('zh-CN')
}
</script>

<template>
  <section class="bc-panel">
    <div class="bc-panel-head">
      <div>
        <p class="bc-eyebrow">Analytics</p>
        <h2>数据统计</h2>
        <p class="bc-muted">
          集中查看 Koishi analytics 的用户、群组与消息趋势，不再占用首页默认卡片区。
        </p>
      </div>
    </div>

    <div
      v-if="analytics"
      class="bc-analytics-grid"
    >
      <article class="bc-analytics-card">
        <div class="bc-analytics-card-head">
          <strong>用户数量</strong>
          <span class="bc-badge bc-badge-primary">总量</span>
        </div>
        <p class="bc-analytics-value">{{ formatNumber(analytics.userCount) }}</p>
        <div class="bc-overview-kv">
          <span>昨日新增用户</span>
          <strong>{{ formatNumber(analytics.userIncrement) }}</strong>
        </div>
      </article>

      <article class="bc-analytics-card">
        <div class="bc-analytics-card-head">
          <strong>群组数量</strong>
          <span class="bc-badge bc-badge-success">总量</span>
        </div>
        <p class="bc-analytics-value">{{ formatNumber(analytics.guildCount) }}</p>
        <div class="bc-overview-kv">
          <span>昨日新增群组</span>
          <strong>{{ formatNumber(analytics.guildIncrement) }}</strong>
        </div>
      </article>

      <article class="bc-analytics-card">
        <div class="bc-analytics-card-head">
          <strong>活跃度</strong>
          <span class="bc-badge bc-badge-warning">DAU</span>
        </div>
        <p class="bc-analytics-value">{{ formatNumber(analytics.dauHistory[0] ?? 0) }}</p>
        <div class="bc-overview-kv">
          <span>近期平均 DAU</span>
          <strong>{{ formatNumber(Number(recentAverageDau.toFixed(1))) }}</strong>
        </div>
      </article>
    </div>

    <div
      v-else
      class="bc-analytics-empty"
    >
      当前没有可用的 analytics 数据。请确认 `@koishijs/plugin-analytics` 已启用并完成初始化。
    </div>

    <div
      v-if="analytics"
      class="bc-analytics-charts"
    >
      <k-slot name="analytic-chart" />
    </div>
  </section>
</template>
