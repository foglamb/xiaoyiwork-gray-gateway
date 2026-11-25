<script setup>
import { computed, shallowRef } from 'vue'
import { compact, exact } from '../composables/useFormat.js'
import { proportionalHeight } from '../lib/logs.js'

const props = defineProps({
  rows: { type: Array, default: () => [] },
  modelNames: { type: Object, default: () => ({}) },
})

const hoveredIndex = shallowRef(null)
const focusedIndex = shallowRef(null)
const selectedIndex = shallowRef(null)
const activeIndex = computed(() => hoveredIndex.value ?? focusedIndex.value ?? selectedIndex.value)

const bars = computed(() => props.rows.map((row) => {
  const cached = Number(row.cached) || 0
  const fresh = Math.max(0, (Number(row.prompt) || 0) - cached)
  const completion = Number(row.completion) || 0
  return {
    id: row.model,
    name: props.modelNames[row.model] || row.model,
    requests: row.requests || 0,
    cached,
    fresh,
    completion,
    total: cached + fresh + completion,
  }
}))
const maxTotal = computed(() => Math.max(1, ...bars.value.map((bar) => bar.total)))
const grandTotal = computed(() => bars.value.reduce((total, bar) => total + bar.total, 0))
const legend = computed(() => [
  { key: 'cached', label: '缓存命中', value: bars.value.reduce((total, bar) => total + bar.cached, 0) },
  { key: 'fresh', label: '未命中输入', value: bars.value.reduce((total, bar) => total + bar.fresh, 0) },
  { key: 'completion', label: '输出', value: bars.value.reduce((total, bar) => total + bar.completion, 0) },
])
const ticks = computed(() => [1, 0.75, 0.5, 0.25, 0].map((fraction) => ({
  fraction,
  value: maxTotal.value * fraction,
})))
const activeBar = computed(() => activeIndex.value === null ? null : bars.value[activeIndex.value] || null)

function barHeight(bar) {
  return proportionalHeight(bar.total, maxTotal.value)
}
function segmentHeight(value, total) {
  return total ? (value / total) * 100 : 0
}
function hover(event, index) {
  if (event.pointerType === 'mouse') hoveredIndex.value = index
}
function select(index) {
  selectedIndex.value = selectedIndex.value === index ? null : index
}
</script>

<template>
  <section class="token-bars card" aria-labelledby="token-bars-title">
    <header class="chart-head">
      <div class="head-copy">
        <span class="kicker">MODEL VOLUME</span>
        <h3 id="token-bars-title">模型 Token 总量</h3>
        <p>竖向堆叠柱 · 柱高按当前窗口最大模型等比</p>
      </div>
      <div class="head-metric">
        <strong :title="exact(grandTotal)">{{ compact(grandTotal) }}</strong>
        <span>窗口总量 · {{ bars.length }} 个模型</span>
      </div>
    </header>

    <div class="legend" aria-label="Token 构成图例">
      <span v-for="item in legend" :key="item.key" class="legend-item">
        <i :class="item.key" aria-hidden="true" />
        <span>{{ item.label }}</span>
        <b :title="exact(item.value)">{{ compact(item.value) }}</b>
      </span>
    </div>

    <div v-if="bars.length" class="chart-scroll">
      <div class="chart-layout" :style="{ '--count': bars.length }">
        <div class="y-axis" aria-hidden="true">
          <span v-for="tick in ticks" :key="tick.fraction">{{ compact(tick.value) }}</span>
        </div>
        <div class="plot">
          <div class="grid" aria-hidden="true">
            <i v-for="tick in ticks" :key="tick.fraction" :style="{ top: `${(1 - tick.fraction) * 100}%` }" />
          </div>
          <div class="columns">
            <button
              v-for="(bar, index) in bars" :key="bar.id" type="button"
              class="column" :class="{ active: activeIndex === index }"
              :aria-pressed="selectedIndex === index"
              :aria-label="`${bar.name}，总 Token ${exact(bar.total)}，${bar.requests} 次请求`"
              @pointerenter="hover($event, index)" @pointerleave="hoveredIndex = null"
              @focus="focusedIndex = index" @blur="focusedIndex = null" @click="select(index)"
            >
              <span class="bar-value" :title="exact(bar.total)">{{ compact(bar.total) }}</span>
              <span class="bar-space">
                <span class="bar-column" :style="{ height: `${barHeight(bar)}%` }">
                  <span class="segment completion" :style="{ height: `${segmentHeight(bar.completion, bar.total)}%` }" />
                  <span class="segment fresh" :style="{ height: `${segmentHeight(bar.fresh, bar.total)}%` }" />
                  <span class="segment cached" :style="{ height: `${segmentHeight(bar.cached, bar.total)}%` }" />
                </span>
              </span>
              <span class="bar-name" :title="bar.id" translate="no">{{ bar.name }}</span>
              <span class="bar-requests">{{ bar.requests }} 次</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="activeBar" class="detail-strip" aria-live="polite">
      <div class="detail-model"><strong>{{ activeBar.name }}</strong><code>{{ activeBar.id }}</code></div>
      <span>缓存 <b>{{ exact(activeBar.cached) }}</b></span>
      <span>未命中 <b>{{ exact(activeBar.fresh) }}</b></span>
      <span>输出 <b>{{ exact(activeBar.completion) }}</b></span>
      <span>合计 <b>{{ exact(activeBar.total) }}</b></span>
    </div>
    <p v-else class="chart-note">悬停、聚焦或点击柱子查看精确 Token；小体量模型不会被放大到与主力模型同高。</p>
    <div v-if="!bars.length" class="empty-state">当前窗口暂无模型 Token 数据</div>
  </section>
</template>

<style scoped>
.token-bars { min-width: 0; padding: 22px 24px 16px; }
.chart-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.head-copy { min-width: 0; }
.head-copy h3 { margin-top: 5px; font-size: 16px; font-weight: 660; letter-spacing: -0.02em; text-wrap: balance; }
.head-copy p { margin-top: 5px; color: var(--dim); font-size: 11px; }
.head-metric { flex: none; text-align: right; }
.head-metric strong { display: block; font-family: var(--font-mono); font-size: 25px; line-height: 1.1; letter-spacing: -0.05em; font-variant-numeric: tabular-nums; }
.head-metric span { display: block; margin-top: 6px; color: var(--dim); font-size: 10px; }
.legend { display: flex; flex-wrap: wrap; gap: 9px 18px; margin-top: 18px; padding: 10px 12px; border: 1px solid var(--line-soft); border-radius: var(--r-sm); background: var(--surface-2); }
.legend-item { display: inline-flex; align-items: center; gap: 6px; color: var(--dim); font-size: 10.5px; }
.legend-item i { width: 8px; height: 8px; border-radius: 2px; }
.legend-item b { color: var(--text-2); font-family: var(--font-mono); font-weight: 600; font-variant-numeric: tabular-nums; }
.cached { background: var(--green); }
.fresh { background: var(--blue); }
.completion { background: var(--accent-2); }
.chart-scroll { overflow-x: auto; overscroll-behavior-x: contain; margin-top: 16px; }
.chart-layout { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 10px; min-width: min(100%, calc(var(--count) * 92px)); }
.y-axis { margin-top: 24px; height: 220px; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; padding-bottom: 1px; color: var(--dim-2); font-family: var(--font-mono); font-size: 9px; font-variant-numeric: tabular-nums; }
.plot { position: relative; min-width: 0; height: 282px; }
.grid { position: absolute; top: 24px; left: 0; right: 0; height: 220px; pointer-events: none; }
.grid i { position: absolute; left: 0; right: 0; height: 1px; background: var(--line-soft); }
.grid i:last-child { background: var(--line); }
.columns { position: relative; display: grid; grid-template-columns: repeat(var(--count), minmax(72px, 1fr)); gap: 8px; height: 282px; }
.column {
  min-width: 0; height: 282px; padding: 0 3px; display: grid;
  grid-template-rows: 20px 220px 17px 13px; gap: 4px;
  color: inherit; background: transparent; border: 0; border-radius: 9px;
  cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
  transition: background-color var(--dur-1) var(--ease), opacity var(--dur-1) var(--ease);
}
.column:hover, .column.active { background: var(--surface-2); }
.column:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.bar-value { align-self: center; color: var(--text-2); font-family: var(--font-mono); font-size: 10px; font-weight: 650; font-variant-numeric: tabular-nums; }
.bar-space { height: 220px; display: flex; align-items: flex-end; justify-content: center; }
.bar-column {
  width: min(62px, 68%); min-height: 0; display: flex; flex-direction: column; justify-content: flex-end;
  overflow: hidden; border-radius: 8px 8px 3px 3px;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 8%), 0 6px 16px rgb(15 23 42 / 8%);
  transform-origin: center bottom; transition: height var(--dur-3) var(--ease-out), filter var(--dur-1) var(--ease), transform var(--dur-1) var(--ease);
}
.column:hover .bar-column, .column.active .bar-column { filter: saturate(1.12) brightness(1.04); transform: scaleX(1.04); }
.segment { width: 100%; flex: none; min-height: 0; }
.segment.cached { background: linear-gradient(180deg, color-mix(in srgb, var(--green) 90%, white), var(--green)); }
.segment.fresh { background: linear-gradient(180deg, color-mix(in srgb, var(--blue) 88%, white), var(--blue)); }
.segment.completion { background: linear-gradient(180deg, color-mix(in srgb, var(--accent-2) 88%, white), var(--accent-2)); }
.bar-name { overflow: hidden; color: var(--text-2); font-size: 10px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.bar-requests { color: var(--dim-2); font-size: 9px; font-variant-numeric: tabular-nums; }
.detail-strip { display: flex; align-items: center; flex-wrap: wrap; gap: 9px 20px; margin-top: 12px; padding: 11px 13px; border: 1px solid var(--line-soft); border-radius: var(--r-sm); background: var(--surface-2); color: var(--dim); font-size: 10.5px; }
.detail-model { display: flex; align-items: baseline; gap: 8px; min-width: 180px; margin-right: auto; }
.detail-model strong { color: var(--text); font-size: 12px; }
.detail-model code { max-width: 210px; overflow: hidden; color: var(--dim-2); font-size: 9px; text-overflow: ellipsis; }
.detail-strip b { color: var(--text-2); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.chart-note { margin-top: 12px; color: var(--dim-2); font-size: 10.5px; line-height: 1.55; }

@media (max-width: 720px) {
  .token-bars { padding: 17px 14px 13px; }
  .chart-head { gap: 12px; }
  .head-copy p { max-width: 210px; line-height: 1.5; }
  .head-metric strong { font-size: 20px; }
  .legend { gap: 8px 12px; padding: 9px 10px; }
  .legend-item { font-size: 9.5px; }
  .chart-layout { grid-template-columns: 38px minmax(0, 1fr); gap: 6px; min-width: calc(var(--count) * 74px); }
  .columns { grid-template-columns: repeat(var(--count), minmax(64px, 1fr)); gap: 3px; }
  .bar-column { width: min(48px, 72%); }
  .detail-strip { gap: 7px 12px; }
  .detail-model { width: 100%; min-width: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .column, .bar-column { transition: none; }
  .column:hover .bar-column, .column.active .bar-column { transform: none; }
}
</style>
