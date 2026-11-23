<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useId } from 'vue'
import { compact } from '../composables/useFormat.js'

const props = defineProps({
  points: { type: Array, required: true },
  series: { type: Array, required: true },
  bucketMs: { type: Number, default: 3600000 },
  hours: { type: Number, default: 24 },
  yFormat: { type: String, default: 'number' },
  maxY: { type: Number, default: null },
  height: { type: Number, default: 250 },
  area: { type: Boolean, default: true },
})

const uid = useId()
const hover = shallowRef(null)
const svgEl = ref(null)

// Match the SVG coordinate space to the real width so nothing is horizontally squashed.
const narrow = shallowRef(false)
const mq = typeof window !== 'undefined' ? window.matchMedia('(max-width: 720px)') : null
function syncNarrow(event) { narrow.value = event.matches }
onMounted(() => {
  if (!mq) return
  narrow.value = mq.matches
  mq.addEventListener('change', syncNarrow)
})
onBeforeUnmount(() => mq?.removeEventListener('change', syncNarrow))

const W = computed(() => (narrow.value ? 420 : 960))
const height = computed(() => (narrow.value ? 190 : props.height))
const PAD = computed(() => (narrow.value
  ? { top: 12, right: 10, bottom: 26, left: 40 }
  : { top: 16, right: 18, bottom: 30, left: 54 }))

const plotW = computed(() => W.value - PAD.value.left - PAD.value.right)
const plotH = computed(() => height.value - PAD.value.top - PAD.value.bottom)

const visible = computed(() => props.points.filter((p) => (p.requests || 0) > 0 || props.yFormat === 'percent'))

function nice(value) {
  if (!value || value <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(value))
  const scaled = value / mag
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10) * mag
}

const yMax = computed(() => {
  if (props.maxY) return props.maxY
  const peak = Math.max(...visible.value.flatMap((p) => props.series.map((l) => Number(p[l.key]) || 0)), 0)
  return nice(peak * 1.08)
})

const xAt = (i, total) => PAD.value.left + (total <= 1 ? plotW.value / 2 : (i / (total - 1)) * plotW.value)
const yAt = (v) => PAD.value.top + plotH.value - (Math.min(Number(v) || 0, yMax.value) / yMax.value) * plotH.value

/** Catmull-Rom → cubic bezier: smooth trend line without overshoot artefacts. */
function smoothPath(values) {
  if (!values.length) return ''
  if (values.length === 1) return `M${values[0].x},${values[0].y}`
  let d = `M${values[0].x.toFixed(1)},${values[0].y.toFixed(1)}`
  for (let i = 0; i < values.length - 1; i++) {
    const p0 = values[i - 1] || values[i]
    const p1 = values[i]
    const p2 = values[i + 1]
    const p3 = values[i + 2] || p2
    const t = 0.18
    const c1x = p1.x + (p2.x - p0.x) * t
    const c1y = p1.y + (p2.y - p0.y) * t
    const c2x = p2.x - (p3.x - p1.x) * t
    const c2y = p2.y - (p3.y - p1.y) * t
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
  }
  return d
}

function coordsFor(line) {
  const list = visible.value
  return list.map((point, i) => ({ x: xAt(i, list.length), y: yAt(point[line.key]) }))
}

function pathFor(line) {
  return smoothPath(coordsFor(line))
}

function areaFor(line) {
  const coords = coordsFor(line)
  if (!coords.length) return ''
  const base = PAD.value.top + plotH.value
  return `${smoothPath(coords)} L${coords[coords.length - 1].x.toFixed(1)},${base} L${coords[0].x.toFixed(1)},${base} Z`
}

function label(at) {
  const date = new Date(at)
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (props.bucketMs < 3600000) return hm
  if (props.hours > 24) return `${date.getMonth() + 1}/${date.getDate()} ${hm}`
  return hm
}

function fmt(v) {
  return props.yFormat === 'percent' ? `${Math.round(v)}%` : compact(v)
}

const grid = computed(() => [0, 0.25, 0.5, 0.75, 1].map((f) => ({
  y: PAD.value.top + plotH.value - f * plotH.value,
  text: fmt(yMax.value * f),
})))

const tickEvery = computed(() => Math.max(1, Math.ceil(visible.value.length / 7)))

function onMove(event) {
  const list = visible.value
  if (!list.length || !svgEl.value) return
  const rect = svgEl.value.getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * W
  const ratio = Math.min(1, Math.max(0, (x - PAD.value.left) / plotW.value))
  const index = list.length <= 1 ? 0 : Math.round(ratio * (list.length - 1))
  hover.value = { index, point: list[index], pct: (xAt(index, list.length) / W.value) * 100 }
}

const hoverRows = computed(() => {
  if (!hover.value) return []
  return props.series.map((line) => ({
    label: line.label,
    color: line.color,
    value: props.yFormat === 'percent'
      ? `${(Number(hover.value.point[line.key]) || 0).toFixed(1)}%`
      : compact(hover.value.point[line.key]),
  }))
})
</script>

<template>
  <div class="chart" @mouseleave="hover = null">
    <svg
      ref="svgEl" :viewBox="`0 0 ${W} ${height}`" class="chart-svg"
      @mousemove="onMove" @touchmove.passive="onMove"
    >
      <defs>
        <linearGradient v-for="(line, i) in series" :id="`g-${uid}-${i}`" :key="line.key" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :stop-color="line.color" stop-opacity="0.26" />
          <stop offset="100%" :stop-color="line.color" stop-opacity="0" />
        </linearGradient>
      </defs>

      <g class="grid-group">
        <line v-for="(line, i) in grid" :key="i" :x1="PAD.left" :x2="W - PAD.right" :y1="line.y" :y2="line.y" class="grid" />
        <text v-for="(line, i) in grid" :key="`t${i}`" :x="PAD.left - 8" :y="line.y + 3.5" class="axis" text-anchor="end">{{ line.text }}</text>
      </g>

      <g v-if="visible.length">
        <template v-for="(line, i) in series" :key="line.key">
          <path v-if="area && series.length === 1" :d="areaFor(line)" :fill="`url(#g-${uid}-${i})`" />
          <path
            :d="pathFor(line)" class="line"
            :style="{ stroke: line.color, strokeDasharray: line.dash || '', strokeWidth: line.width || 2, opacity: line.opacity ?? 1 }"
          />
        </template>

        <template v-if="hover">
          <line :x1="xAt(hover.index, visible.length)" :x2="xAt(hover.index, visible.length)" :y1="PAD.top" :y2="PAD.top + plotH" class="cursor" />
          <g v-for="line in series" :key="`h${line.key}`">
            <circle :cx="xAt(hover.index, visible.length)" :cy="yAt(hover.point[line.key])" r="5.5" class="dot-halo" :fill="line.color" />
            <circle :cx="xAt(hover.index, visible.length)" :cy="yAt(hover.point[line.key])" r="2.8" class="dot" :fill="line.color" />
          </g>
        </template>
      </g>

      <g>
        <text
          v-for="(point, index) in visible" :key="`x${index}`"
          v-show="index % tickEvery === 0 || index === visible.length - 1"
          :x="xAt(index, visible.length)" :y="height - 9" class="axis" text-anchor="middle"
        >{{ label(point.at) }}</text>
      </g>
    </svg>

    <div v-if="hover" class="tip" :style="{ left: `${hover.pct}%` }">
      <div class="tip-time">{{ label(hover.point.at) }}</div>
      <div v-for="row in hoverRows" :key="row.label" class="tip-row">
        <i :style="{ background: row.color }" /><span>{{ row.label }}</span><b>{{ row.value }}</b>
      </div>
      <div v-if="hover.point.requests !== undefined" class="tip-row muted-row">
        <span>请求</span><b>{{ hover.point.requests }}</b>
      </div>
    </div>

    <div v-if="!visible.length" class="empty-state">这个时间范围还没有请求</div>
  </div>
</template>

<style scoped>
.chart { position: relative; }
.chart-svg { width: 100%; height: auto; display: block; overflow: visible; touch-action: pan-y; }
.grid { stroke: var(--line-soft); stroke-width: 1; vector-effect: non-scaling-stroke; }
.axis { fill: var(--dim-2); font-size: 10px; font-family: var(--font-mono); letter-spacing: -0.02em; }
.line { fill: none; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.cursor { stroke: var(--line-strong); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.dot { stroke: var(--surface); stroke-width: 1.6; }
.dot-halo { opacity: 0.22; }
.tip {
  position: absolute; top: 4px; transform: translateX(-50%);
  min-width: 136px; padding: 9px 11px;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  box-shadow: var(--shadow);
  font-size: 11px; pointer-events: none; z-index: 4;
  backdrop-filter: blur(10px);
}
.tip-time { color: var(--dim); font-family: var(--font-mono); margin-bottom: 6px; font-size: 10.5px; }
.tip-row { display: flex; align-items: center; gap: 7px; line-height: 1.75; }
.tip-row i { width: 7px; height: 7px; border-radius: 2px; flex: none; }
.tip-row span { color: var(--dim); }
.tip-row b { margin-left: auto; color: var(--text); font-family: var(--font-mono); font-weight: 620; }
.muted-row { border-top: 1px solid var(--line-soft); margin-top: 5px; padding-top: 5px; }

@media (max-width: 720px) {
  .tip { font-size: 10.5px; min-width: 118px; padding: 7px 9px; }
  .axis { font-size: 9.5px; }
}
</style>
