<script setup>
import { computed, shallowRef } from 'vue'
import LineChart from './LineChart.vue'
import TokenBars from './TokenBars.vue'
import StatCard from './StatCard.vue'
import CodeBlock from './CodeBlock.vue'
import AppIcon from './AppIcon.vue'
import { state, logStats, hourly, byModel, bucketMs, accounts, windowHours, loadLogs } from '../composables/useDashboard.js'
import { compact, exact, num, pct, ms } from '../composables/useFormat.js'
import { notify } from '../composables/useToast.js'

const metric = shallowRef('tokens')
const modelNames = computed(() => Object.fromEntries((state.value?.models || []).map((model) => [model.id, model.name || model.id])))
const hours = windowHours
const switching = shallowRef(false)

/** Changing the range refetches the window; the chart and KPIs both follow it. */
async function setHours(value) {
  if (value === hours.value) return
  hours.value = value
  switching.value = true
  try {
    await loadLogs({ page: 1, pageSize: 50, hours: value })
  } catch (error) {
    notify(error.message, 'err')
  } finally {
    switching.value = false
  }
}

const METRICS = {
  tokens: [
    { key: 'cached', label: '缓存命中', color: 'var(--green)', width: 2.4 },
    { key: 'fresh', label: '未命中', color: 'var(--blue)' },
    { key: 'completion', label: '输出', color: 'var(--accent-2)' },
  ],
  cache: [{ key: 'cacheRate', label: '缓存命中率', color: 'var(--green)', width: 2.4 }],
  requests: [
    { key: 'requests', label: '请求', color: 'var(--accent-2)', width: 2.4 },
    { key: 'failed', label: '失败', color: 'var(--red)', dash: '4 3' },
  ],
}

const points = computed(() => hourly.value.map((b) => ({
  ...b,
  fresh: Math.max(0, (b.prompt || 0) - (b.cached || 0)),
  cacheRate: b.prompt ? (b.cached / b.prompt) * 100 : 0,
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

const freshTokens = computed(() => Math.max(0, totals.value.prompt - totals.value.cached))
const endpoint = computed(() => state.value?.endpoint?.currentUrl || '')
const coverageText = computed(() => {
  const oldest = logStats.value?.oldestAt
  const newest = logStats.value?.newestAt
  if (!oldest || !newest) return `当前 ${hours.value}h 窗口暂无日志`
  const span = Math.max(0, (newest - oldest) / 3600000)
  return `日志覆盖 ${span.toFixed(1)}h / 当前窗口 ${hours.value}h`
})

const legendValue = (key) => (key === 'fresh' ? freshTokens.value : totals.value[key] || 0)
</script>

<template>
  <div class="stack">
    <section class="hero card card-elev">
      <div class="hero-main">
        <div class="hero-copy">
          <span class="kicker">OpenAI 兼容入口</span>
          <h2>把请求接到小艺账号池</h2>
          <p>客户端填入下方地址即可，无需改动对话内容。</p>
        </div>
        <div class="hero-badges">
          <span class="badge ok"><span class="dot" />{{ accounts.length }} 个账号</span>
          <span class="badge accent">灰度 {{ state?.gray?.percentage ?? 0 }}%</span>
          <span class="badge">{{ state?.models?.length || 0 }} 个模型</span>
        </div>
      </div>
      <div class="hero-endpoint"><CodeBlock :code="endpoint" label="Base URL" /></div>
    </section>

    <section class="stats">
      <StatCard :label="`近 ${hours} 小时请求`" :value="num(logStats.last24h || 0)" :hint="`成功率 ${pct(logStats.successRate)}`" icon="pulse" />
      <StatCard label="缓存命中率" :value="pct(logStats.cacheHitRate)" hint="命中 / 输入 Token" tone="ok" icon="spark" />
      <StatCard
        label="总 Token" :value="compact(logStats.tokens24h || 0)"
        :hint="`输入 ${compact(logStats.promptTokens24h)} + 输出 ${compact(logStats.completionTokens24h)}`"
        :title="`输入 ${exact(logStats.promptTokens24h)} + 输出 ${exact(logStats.completionTokens24h)} = ${exact(logStats.tokens24h)}`"
        tone="accent" icon="box"
      />
      <StatCard
        label="累计总 Token" :value="compact(logStats.allTimeTokens || 0)"
        :hint="`输入 ${compact(logStats.allTimePromptTokens)} + 输出 ${compact(logStats.allTimeCompletionTokens)}`"
        :title="`保留日志累计：${exact(logStats.allTimePromptTokens)} + ${exact(logStats.allTimeCompletionTokens)} = ${exact(logStats.allTimeTokens)}`"
        icon="box"
      />
      <StatCard label="推理 Token" :value="compact(logStats.reasoningTokens24h || 0)" hint="思考链消耗" icon="spark" />
      <StatCard
        label="平均耗时" :value="ms(logStats.averageMs)"
        :hint="`失败 ${num(logStats.failed24h)} 次`"
        :tone="(logStats.failed24h || 0) > 0 ? 'err' : ''" icon="clock"
      />
    </section>

    <section class="card chart-card">
      <header class="card-head">
        <div>
          <span class="kicker">Token &amp; Cache</span>
          <h3>用量趋势</h3>
        </div>
        <div class="controls">
          <div class="seg">
            <button v-for="(_, key) in METRICS" :key="key" type="button" :class="{ on: metric === key }" @click="metric = key">
              {{ key === 'tokens' ? 'Token' : key === 'cache' ? '命中率' : '请求' }}
            </button>
          </div>
          <div class="seg">
            <button
              v-for="h in [6, 24, 72]" :key="h" type="button"
              :class="{ on: hours === h }" :disabled="switching" @click="setHours(h)"
            >{{ h }}h</button>
          </div>
        </div>
      </header>

      <div class="legend">
        <span v-for="line in activeSeries" :key="line.key" class="legend-item">
          <i :style="{ background: line.color }" />
          <span class="legend-name">{{ line.label }}</span>
          <b v-if="metric !== 'cache'">{{ compact(legendValue(line.key)) }}</b>
        </span>
        <span class="grow" />
        <span class="legend-note">{{ coverageText }}</span>
      </div>

      <div class="chart-body">
        <LineChart
          :points="points" :series="activeSeries" :bucket-ms="bucketMs" :hours="hours"
          :y-format="metric === 'cache' ? 'percent' : 'number'" :max-y="metric === 'cache' ? 100 : null"
        />
      </div>
    </section>

    <TokenBars :rows="byModel" :model-names="modelNames" />

    <section class="card models-card">
        <header class="mini-head row">
          <div>
            <span class="kicker">Per Model</span>
            <h3>模型消耗</h3>
          </div>
          <span class="grow" />
          <span class="muted tiny">近 {{ hours }} 小时</span>
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
                <td class="right num" :class="{ good: row.cacheHitRate >= 50 }">{{ pct(row.cacheHitRate) }}</td>
                <td class="right num">{{ ms(row.averageMs) }}</td>
              </tr>
              <tr v-if="!byModel.length"><td colspan="5" class="empty-state">暂无数据</td></tr>
            </tbody>
          </table>
        </div>
    </section>
  </div>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: 16px; }

.hero {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 460px);
  gap: 22px; align-items: center;
  padding: 22px 24px;
  background-image: var(--hero);
}
.hero-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.hero-copy h2 { margin-top: 5px; font-size: 20px; font-weight: 660; line-height: 1.28; }
.hero-copy p { margin-top: 5px; font-size: 12.5px; color: var(--dim); }
.hero-badges { display: flex; gap: 7px; flex-wrap: wrap; }
.hero-endpoint { min-width: 0; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(164px, 1fr)); gap: 11px; }

.chart-card { padding-bottom: 16px; }
.card-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 14px; padding: 19px 20px 0; flex-wrap: wrap;
}
.card-head h3 { margin-top: 4px; font-size: 15px; font-weight: 640; }
.controls { display: flex; gap: 8px; flex-wrap: wrap; }
.seg {
  display: inline-flex; padding: 2px; gap: 2px;
  background: var(--surface-2); border: 1px solid var(--line);
  border-radius: var(--r-sm);
}
.seg button {
  border: 0; background: transparent; color: var(--dim);
  font-size: 11.5px; font-weight: 550; padding: 4px 11px; border-radius: var(--r-xs);
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}
.seg button:hover { color: var(--text-2); }
.seg button.on { background: var(--surface-3); color: var(--text); font-weight: 620; box-shadow: var(--shadow-xs); }

.legend { display: flex; align-items: center; gap: 16px; padding: 12px 20px 2px; flex-wrap: wrap; font-size: 11px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.legend-item i { width: 8px; height: 8px; border-radius: 2.5px; flex: none; }
.legend-name { color: var(--dim); }
.legend-item b { color: var(--text-2); font-family: var(--font-mono); font-weight: 620; }
.legend-note { color: var(--dim-2); font-family: var(--font-mono); font-size: 10.5px; }
.chart-body { padding: 6px 16px 0; }

.two-col { display: grid; grid-template-columns: minmax(0, 330px) minmax(0, 1fr); gap: 16px; align-items: start; }
.composition { padding: 19px 20px; }
.mini-head { margin-bottom: 14px; }
.mini-head h3 { margin-top: 4px; font-size: 15px; font-weight: 640; }
.stackbar {
  display: flex; height: 10px; border-radius: 999px; overflow: hidden;
  background: var(--surface-3); box-shadow: var(--inner-top);
}
.seg-fill { transition: width var(--dur-3) var(--ease-out); }
.compo { display: flex; flex-direction: column; gap: 9px; margin-top: 16px; }
.compo-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); }
.compo-row i { width: 8px; height: 8px; border-radius: 2.5px; flex: none; }
.compo-row b { margin-left: auto; font-family: var(--font-mono); color: var(--text); font-weight: 620; }
.compo-row em {
  font-style: normal; width: 50px; text-align: right;
  color: var(--dim); font-family: var(--font-mono); font-size: 10.5px;
}
.note {
  display: flex; align-items: flex-start; gap: 6px;
  margin-top: 16px; padding-top: 13px;
  border-top: 1px solid var(--line-soft);
  font-size: 10.5px; color: var(--dim-2); line-height: 1.6;
}
.note svg { margin-top: 2px; flex: none; }
.models-card { padding-top: 19px; }
.models-card .mini-head { padding: 0 20px; }
.models-card .table-wrap { margin-top: 2px; }
.good { color: var(--green); }

@media (max-width: 1080px) {
  .hero { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .two-col { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 720px) {
  .hero { padding: 17px 16px; gap: 14px; }
  .hero-copy h2 { font-size: 17px; }
  .hero-copy p { font-size: 11.5px; }
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
  .stats > :last-child:nth-child(odd) { grid-column: 1 / -1; }
  .card-head { padding: 15px 14px 0; gap: 10px; }
  .card-head h3 { font-size: 14px; }
  .controls { width: 100%; justify-content: space-between; }
  .seg button { padding: 4px 9px; font-size: 11px; }
  .legend { padding: 10px 14px 0; gap: 11px; }
  .legend-note { display: none; }
  .chart-body { padding: 4px 6px 0; }
  .composition { padding: 15px 16px; }
  .models-card .mini-head { padding: 0 16px; }
}
</style>
