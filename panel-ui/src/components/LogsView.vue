<script setup>
import { computed, onMounted, shallowRef, watch } from 'vue'
import { logs, logStats, refreshAll, loadLogs, windowHours, state } from '../composables/useDashboard.js'
import { api } from '../composables/useApi.js'
import { notify } from '../composables/useToast.js'
import AppIcon from './AppIcon.vue'
import { num, ms, clock, pct, compact, exact, ago, tps } from '../composables/useFormat.js'

const props = defineProps({ polling: { type: Boolean, default: true } })
const emit = defineEmits(['update:polling'])

const pageSize = shallowRef(20)
const page = shallowRef(1)
const total = shallowRef(0)
const busy = shallowRef(false)
const expanded = shallowRef(null)

const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const modelNames = computed(() => Object.fromEntries((state.value?.models || []).map((model) => [model.id, model.name || model.id])))
const modelName = (id) => modelNames.value[id] || id || '—'

function latencyStages(entry) {
  const total = Number(entry.ms) || 0
  const firstByte = Math.max(0, Math.min(total, Number(entry.firstByteMs) || 0))
  const firstToken = Math.max(firstByte, Math.min(total, Number(entry.ttftMs) || firstByte))
  return [
    { key: 'network', label: '接入 / 首字节', value: firstByte },
    { key: 'prefill', label: '预填充', value: Math.max(0, firstToken - firstByte) },
    { key: 'generation', label: '生成', value: Math.max(0, total - firstToken) },
  ]
}
function stageWidth(stage, entry) {
  const total = Number(entry.ms) || 0
  if (!total || !stage.value) return 0
  return Math.max(1.2, (stage.value / total) * 100)
}
function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"` }
function exportCsv() {
  const columns = ['time', 'request_id', 'model', 'route', 'account', 'status', 'total_ms', 'first_byte_ms', 'ttft_ms', 'generation_ms', 'prompt_tokens', 'cached_tokens', 'reasoning_tokens', 'completion_tokens', 'total_tokens', 'prefill_tps', 'output_tps', 'error']
  const rows = logs.value.map((entry) => [new Date(entry.at).toISOString(), entry.id, entry.model, entry.route, entry.accountId, entry.status, entry.ms, entry.firstByteMs, entry.ttftMs, entry.generationMs, entry.promptTokens, entry.cachedTokens, entry.reasoningTokens, entry.completionTokens, entry.totalTokens, entry.prefillTps, entry.outputTps, entry.error])
  const csv = '\ufeff' + [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `xiaoyi-requests-page-${page.value}-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.csv`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  notify(`已导出本页 ${rows.length} 条详细指标`, 'ok')
}

async function load() {
  busy.value = true
  try {
    // Follow the shared window so switching ranges on the overview keeps the
    // numbers consistent when coming back to this page.
    const data = await loadLogs({ page: page.value, pageSize: pageSize.value, hours: windowHours.value })
    total.value = data.total || 0
  } catch (error) {
    notify(error.message, 'err')
  } finally {
    busy.value = false
  }
}

function go(next) {
  const target = Math.min(pages.value, Math.max(1, next))
  if (target === page.value) return
  page.value = target
  load()
}

async function clearAll() {
  if (!window.confirm('清空全部请求记录？此操作不可恢复。')) return
  try {
    await api('/api/logs/clear', { method: 'POST', body: {} })
    page.value = 1
    await refreshAll()
    await load()
    notify('记录已清空', 'ok')
  } catch (error) {
    notify(error.message, 'err')
  }
}

function statusTone(entry) {
  if (entry.status === null || entry.status === undefined) return 'info'
  if (entry.status >= 500) return 'err'
  if (entry.status >= 400) return 'warn'
  return 'ok'
}

function hitRate(entry) {
  if (!entry.promptTokens) return null
  return ((entry.cachedTokens || 0) / entry.promptTokens) * 100
}

watch(() => logs.value, () => { total.value = Math.max(total.value, logs.value.length) })
watch(pageSize, () => { page.value = 1; expanded.value = null; load() })
onMounted(load)
</script>

<template>
  <div class="stack">
    <div class="stats">
      <div class="mini card"><span>请求 / 失败</span><b>{{ num(logStats.last24h || 0) }} <small>/ {{ num(logStats.failed24h || 0) }}</small></b></div>
      <div class="mini card metric-primary"><span>聚合输出速度</span><b>{{ tps(logStats.outputTps) }}</b><em>输出 ÷ 生成时间</em></div>
      <div class="mini card"><span>P50 / P95 耗时</span><b>{{ ms(logStats.p50Ms) }} <small>/ {{ ms(logStats.p95Ms) }}</small></b></div>
      <div class="mini card"><span>平均首 Token</span><b>{{ ms(logStats.averageFirstTokenMs) }}</b><em>首字节 {{ ms(logStats.averageFirstByteMs) }}</em></div>
      <div class="mini card"><span>缓存命中率</span><b class="good">{{ pct(logStats.cacheHitRate) }}</b></div>
      <div class="mini card" :title="`输入 ${exact(logStats.promptTokens24h)} + 输出 ${exact(logStats.completionTokens24h)}`"><span>总 Token</span><b>{{ compact(logStats.tokens24h || 0) }}</b></div>
    </div>

    <div class="card">
      <header class="table-head">
        <div>
          <span class="kicker">REQUEST LOG</span>
          <h3>请求记录</h3>
        </div>
        <div class="row">
          <label class="toggle">
            <input type="checkbox" :checked="polling" @change="emit('update:polling', $event.target.checked)" />
            <span>自动刷新</span>
          </label>
          <button class="btn btn-sm" type="button" :disabled="busy" @click="load">
            <AppIcon name="refresh" :size="12" :class="{ spin: busy }" /> 刷新
          </button>
          <button class="btn btn-sm" type="button" :disabled="!logs.length" @click="exportCsv">
            <AppIcon name="download" :size="12" /> 导出本页
          </button>
          <button class="btn btn-sm btn-danger" type="button" @click="clearAll">
            <AppIcon name="trash" :size="12" /> 清空
          </button>
        </div>
      </header>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width: 84px">时间</th>
              <th>模型</th>
              <th style="width: 74px">池</th>
              <th style="width: 76px">结果</th>
              <th class="right" style="width: 76px">耗时</th>
              <th class="right" style="width: 84px">首 token</th>
              <th class="right" style="width: 88px">输入</th>
              <th class="right" style="width: 82px">命中率</th>
              <th class="right" style="width: 78px">输出</th>
              <th class="right" style="width: 100px">速度</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="entry in logs" :key="entry.id">
              <tr class="row-click" tabindex="0" @click="expanded = expanded === entry.id ? null : entry.id" @keydown.enter="expanded = expanded === entry.id ? null : entry.id" @keydown.space.prevent="expanded = expanded === entry.id ? null : entry.id">
                <td class="num muted">{{ clock(entry.at) }}</td>
                <td class="model-cell"><strong class="truncate">{{ modelName(entry.model) }}</strong><code class="truncate">{{ entry.model }}</code></td>
                <td><span class="badge" :class="entry.route === 'gray' ? 'accent' : ''">{{ entry.route === 'gray' ? '灰度' : '稳定' }}</span></td>
                <td><span class="badge" :class="statusTone(entry)">{{ entry.status ?? '进行中' }}</span></td>
                <td class="right num">{{ ms(entry.ms) }}</td>
                <td class="right num muted">{{ ms(entry.ttftMs) }}</td>
                <td class="right num">{{ num(entry.promptTokens) }}</td>
                <td class="right num" :class="{ good: (hitRate(entry) || 0) >= 50 }">{{ hitRate(entry) === null ? '—' : pct(hitRate(entry)) }}</td>
                <td class="right num">{{ num(entry.completionTokens) }}</td>
                <td class="right speed-cell" :title="entry.generationMs ? `生成 ${ms(entry.generationMs)}` : ''">{{ tps(entry.outputTps) }}</td>
              </tr>
              <tr v-if="expanded === entry.id" class="detail-row">
                <td colspan="10">
                  <div class="request-detail">
                    <div class="detail-meta">
                      <span><small>请求 ID</small><code>{{ entry.id }}</code></span>
                      <span><small>账号</small><code>{{ entry.accountId || '—' }}</code></span>
                      <span><small>灰度原因</small><code>{{ entry.reason || '—' }}</code></span>
                      <span><small>模式</small><code>{{ entry.stream ? '流式' : '非流式' }}</code></span>
                    </div>
                    <div class="waterfall">
                      <div class="section-label"><span>请求时间瀑布</span><b>{{ ms(entry.ms) }}</b></div>
                      <div class="waterfall-track" aria-label="请求耗时分布">
                        <i v-for="stage in latencyStages(entry)" :key="stage.key" :class="stage.key" :style="{ width: `${stageWidth(stage, entry)}%` }" />
                      </div>
                      <div class="waterfall-legend">
                        <span v-for="stage in latencyStages(entry)" :key="stage.key"><i :class="stage.key" />{{ stage.label }} <b>{{ ms(stage.value) }}</b></span>
                      </div>
                    </div>
                    <div class="detail">
                      <div class="detail-item"><span>首字节 / 首 Token</span><code>{{ ms(entry.firstByteMs) }} / {{ ms(entry.ttftMs) }}</code></div>
                      <div class="detail-item"><span>生成耗时</span><code>{{ ms(entry.generationMs) }}</code></div>
                      <div class="detail-item"><span>输入等效 / 输出速度</span><code>{{ tps(entry.prefillTps) }} / {{ tps(entry.outputTps) }}</code></div>
                      <div class="detail-item"><span>输入 Token</span><code>{{ num(entry.promptTokens) }}</code></div>
                      <div class="detail-item"><span>未命中 / 缓存</span><code>{{ num(Math.max(0, (entry.promptTokens || 0) - (entry.cachedTokens || 0))) }} / {{ num(entry.cachedTokens) }}</code></div>
                      <div class="detail-item"><span>输出 / 推理</span><code>{{ num(entry.completionTokens) }} / {{ num(entry.reasoningTokens) }}</code></div>
                      <div class="detail-item"><span>总 Token</span><code>{{ num(entry.totalTokens) }}</code></div>
                      <div v-if="entry.error" class="detail-item wide"><span>错误</span><code class="err-text">{{ entry.error }}</code></div>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="!logs.length"><td colspan="10" class="empty-state">还没有请求记录</td></tr>
          </tbody>
        </table>
      </div>

      <footer class="pager">
        <label class="page-size">每页
          <select v-model.number="pageSize" aria-label="每页条数">
            <option :value="10">10</option><option :value="20">20</option>
            <option :value="50">50</option><option :value="100">100</option>
          </select>
          条
        </label>
        <span class="muted tiny">第 {{ page }} / {{ pages }} 页 · 共 {{ num(total) }} 条</span>
        <div class="row">
          <button class="btn btn-sm btn-icon" type="button" title="首页" :disabled="page <= 1" @click="go(1)"><AppIcon name="chevronsLeft" :size="13" /></button>
          <button class="btn btn-sm btn-icon" type="button" title="上一页" :disabled="page <= 1" @click="go(page - 1)"><AppIcon name="chevronLeft" :size="13" /></button>
          <span class="page-now">{{ page }}</span>
          <button class="btn btn-sm btn-icon" type="button" title="下一页" :disabled="page >= pages" @click="go(page + 1)"><AppIcon name="chevronRight" :size="13" /></button>
          <button class="btn btn-sm btn-icon" type="button" title="末页" :disabled="page >= pages" @click="go(pages)"><AppIcon name="chevronsRight" :size="13" /></button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: 14px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 10px; }
.mini { min-width: 0; padding: 13px 14px; display: flex; flex-direction: column; gap: 3px; border-radius: var(--r-md); }
.mini span { color: var(--dim); font-size: 10.5px; }
.mini b { overflow-wrap: anywhere; font-family: var(--font-mono); font-size: 18px; font-weight: 650; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.mini b small { color: var(--dim); font-size: 12px; font-weight: 550; }
.mini em { color: var(--dim-2); font-size: 9.5px; font-style: normal; }
.mini.metric-primary { border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); background: var(--accent-soft); }
.mini.metric-primary b { color: var(--accent); }
.good { color: var(--green); }
.table-head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 17px 19px 13px; }
.table-head h3 { margin-top: 4px; font-size: 15px; font-weight: 650; }
.table-head .row { flex-wrap: wrap; }
.table-wrap { overflow-x: auto; overscroll-behavior-x: contain; }
table { width: 100%; min-width: 1060px; border-collapse: collapse; font-size: 11.5px; }
th { padding: 10px; color: var(--dim); border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); font-size: 10px; font-weight: 560; text-align: left; white-space: nowrap; }
td { padding: 9px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; white-space: nowrap; }
th:first-child, td:first-child { padding-left: 19px; }
th:last-child, td:last-child { padding-right: 19px; }
.row-click { cursor: pointer; transition: background-color var(--dur-1) var(--ease); }
.row-click:hover { background: var(--surface-2); }
.row-click:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.model-cell { max-width: 205px; }
.model-cell strong, .model-cell code { display: block; overflow: hidden; text-overflow: ellipsis; }
.model-cell strong { color: var(--text); font-size: 11.5px; font-weight: 610; }
.model-cell code { margin-top: 2px; color: var(--dim-2); font-size: 9px; }
.num, .speed-cell { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.speed-cell { color: var(--accent); font-size: 11px; font-weight: 650; }
.detail-row { background: var(--surface-2); }
.detail-row td { padding: 0 19px 18px; white-space: normal; }
.request-detail { padding: 16px; border: 1px solid var(--line-soft); border-radius: var(--r-md); background: var(--surface); box-shadow: var(--shadow-sm); }
.detail-meta { display: grid; grid-template-columns: minmax(220px, 1.4fr) repeat(3, minmax(110px, 1fr)); gap: 10px; }
.detail-meta span { min-width: 0; padding: 8px 10px; border-radius: var(--r-xs); background: var(--surface-2); }
.detail-meta small, .detail-meta code { display: block; }
.detail-meta small { margin-bottom: 4px; color: var(--dim); font-size: 9px; }
.detail-meta code { overflow: hidden; color: var(--text-2); font-size: 10px; text-overflow: ellipsis; }
.waterfall { margin-top: 14px; padding: 12px; border: 1px solid var(--line-soft); border-radius: var(--r-sm); }
.section-label { display: flex; justify-content: space-between; gap: 12px; color: var(--dim); font-size: 10px; }
.section-label b { color: var(--text-2); font-family: var(--font-mono); }
.waterfall-track { display: flex; width: 100%; height: 10px; margin-top: 10px; overflow: hidden; border-radius: 6px; background: var(--surface-2); }
.waterfall-track i { height: 100%; min-width: 0; }
.network { background: var(--blue); }
.prefill { background: var(--amber); }
.generation { background: var(--green); }
.waterfall-legend { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 9px; color: var(--dim); font-size: 9.5px; }
.waterfall-legend span { display: inline-flex; align-items: center; gap: 5px; }
.waterfall-legend i { width: 7px; height: 7px; border-radius: 2px; }
.waterfall-legend b { color: var(--text-2); font-family: var(--font-mono); font-weight: 560; }
.detail { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 9px; margin-top: 12px; }
.detail-item { min-width: 0; padding: 9px 10px; border: 1px solid var(--line-soft); border-radius: var(--r-xs); }
.detail-item span, .detail-item code { display: block; }
.detail-item span { margin-bottom: 4px; color: var(--dim); font-size: 9.5px; }
.detail-item code { overflow-wrap: anywhere; color: var(--text-2); font-size: 10.5px; }
.detail-item.wide { grid-column: 1 / -1; }
.err-text { color: var(--red) !important; }
.pager { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 12px 19px; border-top: 1px solid var(--line-soft); }
.page-size { display: inline-flex; align-items: center; gap: 5px; margin-right: auto; color: var(--dim); font-size: 11px; }
.page-size select { height: 28px; padding: 0 6px; color: var(--text-2); background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-xs); }
.page-now { min-width: 34px; color: var(--text-2); font-family: var(--font-mono); font-size: 11.5px; font-weight: 600; text-align: center; }
.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg) } }

@media (max-width: 720px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .mini { padding: 11px 12px; }
  .mini b { font-size: 16px; }
  .table-head { padding: 14px 13px 11px; }
  .table-head > .row { width: 100%; justify-content: flex-end; }
  table { min-width: 0; display: block; }
  thead { display: none; }
  tbody { display: block; }
  .row-click {
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
    grid-template-areas: "time model model status" "route route duration duration" "ttft input output speed";
    gap: 9px 6px; margin: 8px 10px; padding: 12px;
    border: 1px solid var(--line-soft); border-radius: var(--r-md); background: var(--surface);
  }
  .row-click td { min-width: 0; padding: 0; border: 0; }
  .row-click td:nth-child(1) { grid-area: time; font-size: 10px; }
  .row-click td:nth-child(2) { grid-area: model; max-width: none; }
  .row-click td:nth-child(2) code { display: none; }
  .row-click td:nth-child(3) { grid-area: route; align-self: center; }
  .row-click td:nth-child(4) { grid-area: status; justify-self: end; }
  .row-click td:nth-child(5) { grid-area: duration; align-self: center; justify-self: end; }
  .row-click td:nth-child(6) { grid-area: ttft; }
  .row-click td:nth-child(7) { grid-area: input; }
  .row-click td:nth-child(8) { display: none; }
  .row-click td:nth-child(9) { grid-area: output; }
  .row-click td:nth-child(10) { grid-area: speed; }
  .row-click td:nth-child(6), .row-click td:nth-child(7), .row-click td:nth-child(9), .row-click td:nth-child(10) { padding-top: 8px; border-top: 1px solid var(--line-soft); font-size: 10px; }
  .row-click td:nth-child(6)::before, .row-click td:nth-child(7)::before, .row-click td:nth-child(9)::before, .row-click td:nth-child(10)::before { display: block; margin-bottom: 3px; color: var(--dim-2); font-family: var(--font-sans); font-size: 8.5px; }
  .row-click td:nth-child(6)::before { content: '首 Token'; }
  .row-click td:nth-child(7)::before { content: '输入'; }
  .row-click td:nth-child(9)::before { content: '输出'; }
  .row-click td:nth-child(10)::before { content: '输出速度'; }
  .detail-row, .detail-row td { display: block; }
  .detail-row { margin: -4px 10px 10px; }
  .detail-row td { padding: 0 0 10px; }
  .request-detail { padding: 12px; }
  .detail-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .detail { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .detail-item.wide { grid-column: 1 / -1; }
  .pager { padding: 10px 13px; }
  .page-size { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .row-click, .spin { transition: none; animation: none; }
}
</style>
