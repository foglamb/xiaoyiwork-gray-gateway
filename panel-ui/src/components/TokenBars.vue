<script setup>
import { computed } from 'vue'
import { compact, exact } from '../composables/useFormat.js'

const props = defineProps({ rows: { type: Array, default: () => [] } })

const maxTotal = computed(() => Math.max(1, ...props.rows.map((row) => (Number(row.prompt) || 0) + (Number(row.completion) || 0))))
const bars = computed(() => props.rows.map((row) => {
  const cached = Number(row.cached) || 0
  const fresh = Math.max(0, (Number(row.prompt) || 0) - cached)
  const completion = Number(row.completion) || 0
  const total = cached + fresh + completion
  return {
    model: row.model,
    requests: row.requests,
    cached,
    fresh,
    completion,
    total,
    totalHeight: Math.max(total > 0 ? 1 : 0, (total / maxTotal.value) * 100),
    cachedHeight: total ? (cached / total) * 100 : 0,
    freshHeight: total ? (fresh / total) * 100 : 0,
    completionHeight: total ? (completion / total) * 100 : 0,
  }
}))
</script>

<template>
  <div class="token-bars card">
    <header class="mini-head">
      <span class="kicker">Total Tokens</span>
      <h3>模型 Token 总量</h3>
      <div class="bar-legend">
        <span><i class="cached" />缓存</span>
        <span><i class="fresh" />未命中</span>
        <span><i class="completion" />输出</span>
      </div>
    </header>

    <div v-if="bars.length" class="bar-scroll">
      <div class="bar-grid" :style="{ '--count': bars.length }">
        <div v-for="bar in bars" :key="bar.model" class="bar-item">
          <div class="bar-total" :title="exact(bar.total)">{{ compact(bar.total) }}</div>
          <div
            class="bar-track"
            :title="`${bar.model}\n缓存 ${exact(bar.cached)}\n未命中 ${exact(bar.fresh)}\n输出 ${exact(bar.completion)}\n合计 ${exact(bar.total)}`"
          >
            <div class="bar-stack" :style="{ height: `${bar.totalHeight}%` }">
              <div class="bar-segment completion" :style="{ height: `${bar.completionHeight}%` }" />
              <div class="bar-segment fresh" :style="{ height: `${bar.freshHeight}%` }" />
              <div class="bar-segment cached" :style="{ height: `${bar.cachedHeight}%` }" />
            </div>
          </div>
          <div class="bar-name" :title="bar.model">{{ bar.model }}</div>
          <div class="bar-requests">{{ bar.requests }} 次</div>
        </div>
      </div>
    </div>
    <div v-else class="empty-state">当前窗口暂无模型 Token 数据</div>
    <p class="bar-note">柱高按当前窗口最大模型总量等比；柱顶显示实际 Token，悬停查看精确构成。</p>
  </div>
</template>

<style scoped>
.token-bars { padding: 19px 20px 15px; min-width: 0; }
.mini-head h3 { margin-top: 4px; font-size: 15px; font-weight: 640; }
.bar-legend { display: flex; gap: 11px; margin-top: 10px; font-size: 10.5px; color: var(--dim); }
.bar-legend span { display: inline-flex; align-items: center; gap: 5px; }
.bar-legend i { width: 7px; height: 7px; border-radius: 2px; }
.cached { background: var(--green); }
.fresh { background: var(--blue); }
.completion { background: var(--accent-2); }
.bar-scroll { overflow-x: auto; margin-top: 12px; padding-bottom: 3px; }
.bar-grid {
  display: grid;
  grid-template-columns: repeat(var(--count), minmax(64px, 1fr));
  gap: 10px;
  min-width: min(100%, calc(var(--count) * 72px));
  height: 202px;
}
.bar-item { display: grid; grid-template-rows: 18px 1fr 29px 14px; gap: 4px; min-width: 0; text-align: center; }
.bar-total { font-family: var(--font-mono); font-size: 10px; color: var(--text-2); font-weight: 620; }
.bar-track {
  align-self: end; justify-self: center;
  width: min(58px, 72%); height: 142px;
  display: flex; flex-direction: column; justify-content: flex-end;
  background: var(--surface-2); border: 1px solid var(--line-soft);
  border-radius: 7px 7px 4px 4px; overflow: hidden;
}
.bar-stack { width: 100%; display: flex; flex-direction: column; justify-content: flex-end; overflow: hidden; border-radius: 6px 6px 3px 3px; transition: height var(--dur-3) var(--ease-out); }
.bar-segment { width: 100%; flex: none; min-height: 0; }
.bar-segment.cached { background: linear-gradient(180deg, var(--green), color-mix(in srgb, var(--green) 72%, var(--surface))); }
.bar-segment.fresh { background: var(--blue); }
.bar-segment.completion { background: var(--accent-2); }
.bar-name { font-family: var(--font-mono); font-size: 9.5px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-requests { font-size: 9px; color: var(--dim-2); }
.bar-note { margin-top: 9px; font-size: 10px; color: var(--dim-2); line-height: 1.5; }

@media (max-width: 720px) {
  .token-bars { padding: 15px 14px 12px; }
  .bar-grid { grid-template-columns: repeat(var(--count), minmax(58px, 1fr)); gap: 6px; }
  .bar-track { width: min(48px, 76%); }
}
</style>
