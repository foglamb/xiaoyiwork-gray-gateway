<script setup>
import { computed, ref, shallowRef } from 'vue'
import { compact } from '../composables/useFormat.js'

const props = defineProps({
  points: { type: Array, required: true },
  series: { type: Array, required: true },
  bucketMs: { type: Number, default: 3600000 },
  hours: { type: Number, default: 24 },
  yFormat: { type: String, default: 'number' },
  maxY: { type: Number, default: null },
  height: { type: Number, default: 260 },
})

const W = 900
const PAD = { top: 14, right: 16, bottom: 30, left: 52 }

const hover = shallowRef(null)
const svgEl = ref(null)

const plotW = W - PAD.left - PAD.right
const plotH = computed(() => props.height - PAD.top - PAD.bottom)

const visible = computed(() => props.points.filter((point) => (point.requests || 0) > 0 || props.yFormat === 'percent'))

function nice(value) {
  if (!value || value <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(value))
  const scaled = value / mag
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * mag
}

const yMax = computed(() => {
  if (props.maxY) return props.maxY
  const peak = Math.max(...visible.value.flatMap((point) => props.series.map((line) => Number(point[line.key]) || 0)), 0)
  return nice(peak)
})

const xAt = (index, total) => PAD.left + (total <= 1 ? plotW / 2 : (index / (total - 1)) * plotW)
const yAt = (value) => PAD.top + plotH.value - (Math.min(Number(value) || 0, yMax.value) / yMax.value) * plotH.value

function label(at) {
  const date = new Date(at)
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (props.bucketMs < 3600000) return hm
  if (props.hours > 24) return `${date.getMonth() + 1}/${date.getDate()} ${hm}`
  return hm
}

function fmt(value) {
  return props.yFormat === 'percent' ? `${Math.round(value)}%` : compact(value)
}

const grid = computed(() => [0, 0.25, 0.5, 0.75, 1].map((f) => {
  const value = yMax.value * f
  return { y: PAD.top + plotH.value - f * plotH.value, text: fmt(value) }
}))

const tickEvery = computed(() => Math.max(1, Math.ceil(visible.value.length / 7)))

function pathFor(line) {
  const list = visible.value
  return list.map((point, index) => `${index === 0 ? 'M' : 'L'}${xAt(index, list.length).toFixed(1)},${yAt(point[line.key]).toFixed(1)}`).join(' ')
}

function areaFor(line) {
  const list = visible.value
  if (!list.length) return ''
  const last = xAt(list.length - 1, list.length).toFixed(1)
  const first = xAt(0, list.length).toFixed(1)
  return `${pathFor(line)} L${last},${PAD.top + plotH.value} L${first},${PAD.top + plotH.value} Z`
}

function onMove(event) {
  const list = visible.value
  if (!list.length || !svgEl.value) return
  const rect = svgEl.value.getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * W
  const ratio = Math.min(1, Math.max(0, (x - PAD.left) / plotW))
  const index = list.length <= 1 ? 0 : Math.round(ratio * (list.length - 1))
  hover.value = { index, point: list[index], left: (xAt(index, list.length) / W) * 100 }
}

const hoverRows = computed(() => {
  if (!hover.value) return []
  return props.series.map((line) => ({
    label: line.label,
    color: line.color,
    value: props.yFormat === 'percent' ? `${(Number(hover.value.point[line.key]) || 0).toFixed(1)}%` : compact(hover.value.point[line.key]),
  }))
})
</script>

<template>
  <div class="chart" @mouseleave="hover = null">
    <svg ref="svgEl" :viewBox="`0 0 ${W} ${height}`" class="chart-svg" @mousemove="onMove">
      <g>
        <line v-for="(line, i) in grid" :key="i" :x1="PAD.left" :x2="W - PAD.right" :y1="line.y" :y2="line.y" class="grid" />
        <text v-for="(line, i) in grid" :key="`t${i}`" :x="PAD.left - 9" :y="line.y + 3.5" class="axis" text-anchor="end">{{ line.text }}</text>
      </g>
      <g v-if="visible.length">
        <rect v-if="hover" :x="(hover.left / 100) * W - 1" :y="PAD.top" width="2" :height="plotH" class="cursor" />
        <template v-for="line in series" :key="line.key">
          <path v-if="series.length === 1" :d="areaFor(line)" class="area" :style="{ fill: line.color }" />
          <path
            :d="pathFor(line)" class="line"
            :style="{
              stroke: line.color,
              strokeDasharray: line.dash || '',
              strokeWidth: line.width || 2,
              opacity: line.opacity ?? 1,
            }"
          />
        </template>
        <circle
          v-for="line in series" :key="`d${line.key}`"
          v-show="hover"
          :cx="hover ? xAt(hover.index, visible.length) : 0"
          :cy="hover ? yAt(hover.point[line.key]) : 0"
          r="4" class="dot" :style="{ fill: line.color }"
        />
      </g>
      <g>
        <text
          v-for="(point, index) in visible" :key="`x${index}`"
          v-show="index % tickEvery === 0 || index === visible.length - 1"
          :x="xAt(index, visible.length)" :y="height - 9" class="axis" text-anchor="middle"
        >{{ label(point.at) }}</text>
      </g>
    </svg>
    <div v-if="hover" class="tip" :style="{ left: `${hover.left}%` }">
      <div class="tip-time">{{ label(hover.point.at) }}</div>
      <div v-for="row in hoverRows" :key="row.label" class="tip-row">
        <i :style="{ background: row.color }" /><span>{{ row.label }}</span><b>{{ row.value }}</b>
      </div>
      <div v-if="hover.point.requests !== undefined" class="tip-row tip-muted">
        <span>请求</span><b>{{ hover.point.requests }}</b>
      </div>
    </div>
    <div v-if="!visible.length" class="empty-state">这个时间范围还没有请求</div>
  </div>
</template>

<style scoped>
.chart { position: relative; }
.chart-svg { width: 100%; height: auto; display: block; overflow: visible; }
.grid { stroke: var(--line-soft); stroke-width: 1; }
.axis { fill: var(--dim-2); font-size: 10px; font-family: var(--font-mono); }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.area { opacity: 0.12; }
.dot { stroke: var(--surface); stroke-width: 2; }
.cursor { fill: var(--line); }
.tip {
  position: absolute; top: 6px; transform: translateX(-50%);
  min-width: 132px; padding: 8px 10px;
  background: var(--surface-2); border: 1px solid var(--line);
  border-radius: var(--r-sm); box-shadow: var(--shadow);
  font-size: 11px; pointer-events: none; z-index: 3;
}
.tip-time { color: var(--dim); font-family: var(--font-mono); margin-bottom: 5px; }
.tip-row { display: flex; align-items: center; gap: 6px; line-height: 1.7; }
.tip-row i { width: 7px; height: 7px; border-radius: 2px; flex: none; }
.tip-row span { color: var(--dim); }
.tip-row b { margin-left: auto; color: var(--text); font-family: var(--font-mono); font-weight: 600; }
.tip-muted { border-top: 1px solid var(--line-soft); margin-top: 4px; padding-top: 4px; }
</style>
