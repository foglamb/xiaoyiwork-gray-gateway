<script setup>
import { computed, shallowRef } from 'vue'
import LineChart from './LineChart.vue'
import StatCard from './StatCard.vue'
import CodeBlock from './CodeBlock.vue'
import { state, logStats, hourly, byModel, bucketMs, accounts } from '../composables/useDashboard.js'
import { compact, num, pct, ms } from '../composables/useFormat.js'

const metric = shallowRef('tokens')
const hours = shallowRef(24)

const METRICS = {
  tokens: [
    // Cache hits and unmatched input differ by <2% in this workload, so plot
    // the unmatched part (the tokens that actually cost) instead of raw input.
    { key: 'cached', label: '缓存命中', color: 'var(--green)', width: 2.5 },
    { key: 'fresh', label: '未命中', color: 'var(--blue)' },
    { key: 'completion', label: '输出', color: 'var(--accent-2)' },
  ],
  cache: [{ key: 'cacheRate', label: '缓存命中率', color: 'var(--green)' }],
  requests: [
    { key: 'requests', label: '请求', color: 'var(--accent-2)' },
    { key: 'failed', label: '失败', color: 'var(--red)', dash: '4 3' },
  ],
}

const points = computed(() => hourly.value.map((bucket) => ({
  ...bucket,
  fresh: Math.max(0, (bucket.prompt || 0) - (bucket.cached || 0)),
  cacheRate: bucket.prompt ? (bucket.cached / bucket.prompt) * 100 : 0,
})))
const activeSeries = computed(() => METRICS[metric.value])

const totals = computed(() => hourly.value.reduce((acc, b) => {
  acc.prompt += b.prompt || 0
  acc.cached += b.cached || 0
  acc.completion += b.completion || 0
  acc.requests += b.requests || 0
  acc.failed += b.failed || 0
  return acc
}, { prompt: 0, cached: 0, completion: 0, requests: 0, failed: 0 }))

const cacheRate = computed(() => (totals.value.prompt ? (totals.value.cached / totals.value.prompt) * 100 : 0))
const shownHours = computed(() => [6, 24, 72])
const endpoint = computed(() => state.value?.endpoint?.currentUrl || '')

const segs = computed(() => {
  const fresh = Math.max(0, totals.value.prompt - totals.value.cached)
  const total = totals.value.prompt + totals.value.completion || 1
  return [
    { label: '缓存命中', value: totals.value.cached, tone: 'green', share: (totals.value.cached / total) * 100 },
    { label: '未命中输入', value: fresh, tone: 'blue', share: (fresh / total) * 100 },
    { label: '输出', value: totals.value.completion, tone: 'accent', share: (totals.value.completion / total) * 100 },
  ]
})

const toneClass = { green: 'var(--green)', blue: 'var(--blue)', accent: 'var(--accent-2)' }
</script>

<template>
  <div class="stack">
    <section class="hero card">
      <div class="hero-copy">
        <span class="kicker">OpenAI 兼容入口</span>
        <h2>把请求接到小艺账号池</h2>
        <p>客户端用下方地址即可，不需要在对话里做任何改动。</p>
      </div>
      <CodeBlock :code="endpoint" label="Base URL" />
      <div class="hero-meta">
        <span class="badge info"><span class="dot" />{{ accounts.length }} 个账号在线</span>
        <span class="badge accent">灰度 {{ state?.gray?.percentage ?? 0 }}%</span>
        <span class="badge">{{ state?.models?.length || 0 }} 个模型</span>
      </div>
    </section>

    <section class="stats">
      <StatCard label="近 24 小时请求" :value="num(logStats.last24h || 0)" :hint="`成功率 ${pct(logStats.successRate)}`" />
      <StatCard label="缓存命中率" :value="pct(logStats.cacheHitRate)" hint="命中 / 输入 Token" tone="ok" />
      <StatCard label="总 Token" :value="compact(logStats.tokens24h || 0)" :hint="`输入 ${compact(logStats.promptTokens24h)}`" accent />
      <StatCard label="推理 Token" :value="compact(logStats.reasoningTokens24h || 0)" hint="思考链消耗" />
      <StatCard label="平均耗时" :value="ms(logStats.averageMs)" :hint="`失败 ${num(logStats.failed24h)} 次`" :tone="(logStats.failed24h || 0) > 0 ? 'err' : ''" />
    </section>

    <section class="card chart-card">
      <header class="card-head">
        <div>
          <span class="kicker">TOKEN &amp; CACHE</span>
          <h3>用量趋势</h3>
        </div>
        <div class="row wrap">
          <div class="seg">
            <button v-for="(_, key) in METRICS" :key="key" type="button" :class="{ on: metric === key }" @click="metric = key">
              {{ key === 'tokens' ? 'Token' : key === 'cache' ? '命中率' : '请求' }}
            </button>
          </div>
          <div class="seg">
            <button v-for="h in shownHours" :key="h" type="button" :class="{ on: hours === h }" @click="hours = h">{{ h }}h</button>
          </div>
        </div>
      </header>
      <div class="legend">
        <span v-for="line in activeSeries" :key="line.key" class="legend-item">
          <i :style="{ background: line.color }" />{{ line.label }}
          <b v-if="metric === 'tokens'">{{ compact(line.key === 'fresh' ? totals.prompt - totals.cached : totals[line.key] || 0) }}</b>
          <b v-else-if="metric === 'requests'">{{ compact(totals[line.key] || 0) }}</b>
        </span>
        <span class="grow" />
        <span class="muted tiny">命中 {{ compact(totals.cached) }} / 输入 {{ compact(totals.prompt) }}</span>
      </div>
      <LineChart
        :points="points" :series="activeSeries" :bucket-ms="bucketMs" :hours="hours"
        :y-format="metric === 'cache' ? 'percent' : 'number'" :max-y="metric === 'cache' ? 100 : null"
      />
    </section>

    <section class="two-col">
      <div class="card card-pad">
        <span class="kicker">COMPOSITION</span>
        <h3 class="mt">Token 构成</h3>
        <div class="stackbar">
          <div v-for="seg in segs" :key="seg.label" class="stackbar-seg" :style="{ width: `${Math.max(seg.share, 0)}%`, background: toneClass[seg.tone] }" />
        </div>
        <div class="compo">
          <div v-for="seg in segs" :key="seg.label" class="compo-row">
            <i :style="{ background: toneClass[seg.tone] }" />
            <span>{{ seg.label }}</span>
            <b>{{ compact(seg.value) }}</b>
            <em>{{ seg.share.toFixed(1) }}%</em>
          </div>
        </div>
        <p class="note">缓存按前缀复用；对话越长越稳定，命中率越高。</p>
      </div>

      <div class="card">
        <header class="card-head">
          <div>
            <span class="kicker">PER MODEL</span>
            <h3>模型消耗</h3>
          </div>
          <span class="muted tiny">近 24 小时</span>
        </header>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>模型</th><th class="right">请求</th><th class="right">输入</th><th class="right">命中率</th><th class="right">平均</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in byModel" :key="row.model">
                <td class="mono truncate">{{ row.model }}</td>
                <td class="right num">{{ num(row.requests) }}</td>
                <td class="right num">{{ compact(row.prompt) }}</td>
                <td class="right num" :class="{ ok: row.cacheHitRate >= 50 }">{{ pct(row.cacheHitRate) }}</td>
                <td class="right num">{{ ms(row.averageMs) }}</td>
              </tr>
              <tr v-if="!byModel.length"><td colspan="5" class="empty-state">暂无数据</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: 16px; }
.hero {
  display: flex; flex-direction: column; gap: 14px; padding: 22px 24px;
  background-image: var(--grad-hero);
}
.hero-copy h2 { margin-top: 6px; font-size: 19px; font-weight: 650; letter-spacing: -0.02em; }
.hero-copy p { margin-top: 4px; font-size: 12px; color: var(--dim); }
.hero-meta { display: flex; gap: 8px; flex-wrap: wrap; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 11px; }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 18px 20px 0; flex-wrap: wrap; }
.card-head h3 { margin-top: 4px; font-size: 14.5px; font-weight: 640; letter-spacing: -0.01em; }
.chart-card { padding-bottom: 14px; }
.chart-card :deep(.chart) { padding: 8px 18px 0; }
.seg { display: inline-flex; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 2px; }
.seg button {
  border: 0; background: transparent; color: var(--dim);
  font-size: 11.5px; padding: 4px 11px; border-radius: 6px; font-weight: 500;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.seg button.on { background: var(--surface-3); color: var(--text); font-weight: 600; }
.legend { display: flex; align-items: center; gap: 14px; padding: 10px 20px 0; flex-wrap: wrap; font-size: 11px; color: var(--dim); }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.legend-item i { width: 8px; height: 8px; border-radius: 2px; }
.legend-item b { color: var(--text-2); font-family: var(--font-mono); font-weight: 600; }
.two-col { display: grid; grid-template-columns: minmax(0, 340px) minmax(0, 1fr); gap: 16px; }
.mt { margin-top: 4px; font-size: 14.5px; font-weight: 640; }
.stackbar { display: flex; height: 9px; border-radius: 999px; overflow: hidden; margin: 16px 0 14px; background: var(--surface-3); }
.stackbar-seg { transition: width var(--dur) var(--ease); }
.compo { display: flex; flex-direction: column; gap: 8px; }
.compo-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); }
.compo-row i { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.compo-row b { margin-left: auto; font-family: var(--font-mono); color: var(--text); }
.compo-row em { font-style: normal; width: 52px; text-align: right; color: var(--dim); font-family: var(--font-mono); font-size: 11px; }
.note { margin-top: 14px; font-size: 11px; color: var(--dim-2); line-height: 1.6; }
.ok { color: var(--green); }
@media (max-width: 1080px) { .two-col { grid-template-columns: 1fr; } }
</style>
