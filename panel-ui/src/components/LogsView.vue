<script setup>
import { computed, onMounted, shallowRef } from 'vue'
import { state, refreshAll } from '../composables/useDashboard.js'
import { logQuery, tableData, tableEntries as logs, tableStats as logStats, tableBusy as busy, tableError, loadTableLogs as load, updateLogQuery, resumeLatestLogs } from '../composables/useLogs.js'
import { latencyStages, stageStyle, logsCsv, measuredOutputTps } from '../lib/logs.js'
import { api } from '../composables/useApi.js'
import { notify } from '../composables/useToast.js'
import AppIcon from './AppIcon.vue'
import { num, ms, clock, pct, compact, exact, tps } from '../composables/useFormat.js'

const props = defineProps({ polling: { type: Boolean, default: true } })
const emit = defineEmits(['update:polling'])
const expanded = shallowRef(null)
const search = shallowRef(logQuery.value.q)
const page = computed(() => logQuery.value.page)
const pageSize = computed(() => logQuery.value.pageSize)
const total = computed(() => tableData.value?.total || 0)
const pages = computed(() => tableData.value?.pages || 1)
const modelNames = computed(() => Object.fromEntries((state.value?.models || []).map((model) => [model.id, model.name || model.id])))
const modelName = (id) => modelNames.value[id] || id || '—'

function change(patch) {
  expanded.value = null
  return updateLogQuery(patch)
}
function go(next) { return change({ page: Math.min(pages.value, Math.max(1, next)) }) }
function latest() { expanded.value = null; return resumeLatestLogs() }
function exportCsv() {
  const url = URL.createObjectURL(new Blob([logsCsv(logs.value)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `xiaoyi-requests-page-${page.value}-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.csv`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  notify(`已导出本页 ${logs.value.length} 条详细指标`, 'ok')
}
async function clearAll() {
  if (!window.confirm('清空全部请求记录？此操作不可恢复。')) return
  try {
    await api('/api/logs/clear', { method: 'POST', body: {} })
    await Promise.all([refreshAll(), latest()])
    notify('记录已清空', 'ok')
  } catch (error) { notify(error.message, 'err') }
}
function statusTone(entry) {
  if (entry.status === null || entry.status === undefined) return 'info'
  if (entry.status >= 500) return 'err'
  if (entry.status >= 400) return 'warn'
  return 'ok'
}
function hitRate(entry) {
  return entry.promptTokens ? ((entry.cachedTokens || 0) / entry.promptTokens) * 100 : null
}
onMounted(load)
</script>

<template>
  <div class="stack">
    <div class="stats">
      <div class="mini card"><span>请求 / 失败</span><b>{{ num(logStats.last24h || 0) }} <small>/ {{ num(logStats.failed24h || 0) }}</small></b></div>
      <div class="mini card metric-primary"><span>聚合输出速度</span><b>{{ tps(logStats.outputTps) }}</b><em>输出 ÷ 输出阶段 · {{ num(logStats.outputTpsSamples) }} 个有效样本</em></div>
      <div class="mini card"><span>P50 / P95 耗时</span><b>{{ ms(logStats.p50Ms) }} <small>/ {{ ms(logStats.p95Ms) }}</small></b></div>
      <div class="mini card"><span>平均首 Token</span><b>{{ ms(logStats.averageFirstTokenMs) }}</b><em>{{ num(logStats.ttftSamples) }} 个有效样本 · 首字节 {{ ms(logStats.averageFirstByteMs) }}</em></div>
      <div class="mini card"><span>端到端输出速度</span><b>{{ tps(logStats.endToEndTps) }}</b><em>{{ num(logStats.endToEndTpsSamples) }} 个有效样本 · 含等待</em></div>
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

      <form class="filters" @submit.prevent="change({ q: search })">
        <label>时间窗口<select :value="logQuery.hours" @change="change({ hours: Number($event.target.value) })"><option v-for="h in [6, 24, 72]" :key="h" :value="h">近 {{ h }} 小时</option></select></label>
        <label>模型<select :value="logQuery.model" @change="change({ model: $event.target.value })"><option value="">全部模型</option><option v-if="logQuery.model && !modelNames[logQuery.model]" :value="logQuery.model">{{ logQuery.model }}</option><option v-for="model in state?.models || []" :key="model.id" :value="model.id">{{ model.name || model.id }}</option></select></label>
        <label>账号<select :value="logQuery.accountId" @change="change({ accountId: $event.target.value })"><option value="">全部账号</option><option v-for="account in state?.accounts || []" :key="account.id" :value="account.id">{{ account.label || account.id }}</option></select></label>
        <label>结果<select :value="logQuery.status" @change="change({ status: $event.target.value })"><option value="all">全部</option><option value="success">成功</option><option value="error">失败</option></select></label>
        <label>排序<select :value="logQuery.sort" @change="change({ sort: $event.target.value })"><option value="at">时间</option><option value="ms">耗时</option><option value="outputTps">输出速度</option><option value="totalTokens">总 Token</option></select></label>
        <label>方向<select :value="logQuery.order" @change="change({ order: $event.target.value })"><option value="desc">降序</option><option value="asc">升序</option></select></label>
        <label class="search-field">搜索<input v-model="search" type="search" placeholder="请求 / 模型 / 账号 / 错误" /></label><button class="btn btn-sm" type="submit">搜索</button>
      </form>
      <div class="query-note muted tiny">
        <span v-if="logQuery.until">历史快照截至 {{ new Date(logQuery.until).toLocaleString('zh-CN') }} · 翻页、筛选与刷新保持快照</span><span v-else>最新记录 · 翻页时固定快照</span>
        <button v-if="logQuery.until" class="btn btn-sm" type="button" @click="latest">恢复最新</button>
        <span>统计与表格使用相同筛选条件</span>
      </div>
      <p v-if="tableError" class="query-note err-text" role="alert">{{ tableError }} · 请刷新重试</p>
      <div class="table-wrap" :aria-busy="busy">
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
                <td class="right speed-cell" :title="entry.generationMs ? `生成 ${ms(entry.generationMs)}` : ''">{{ tps(measuredOutputTps(entry)) }}</td>
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
                      <div class="section-label"><span>请求阶段（未知显示 —；等待包含排队、传输等，非精确预填充）</span><b>{{ ms(entry.ms) }}</b></div>
                      <div class="waterfall-track" aria-label="请求耗时分布">
                        <i v-for="stage in latencyStages(entry)" :key="stage.key" :class="stage.key" :style="stageStyle(stage, entry)" />
                      </div>
                      <div class="waterfall-legend">
                        <span v-for="stage in latencyStages(entry)" :key="stage.key"><i :class="stage.key" />{{ stage.label }} <b>{{ ms(stage.value) }}</b></span>
                      </div>
                    </div>
                    <div class="detail">
                      <div class="detail-item"><span>响应头等待</span><code>{{ ms(entry.responseHeadersMs) }}</code></div>
                      <div class="detail-item"><span>响应体首字节 / 首 Token</span><code>{{ ms(entry.firstByteMeaning === 'body_byte' ? entry.firstByteMs : null) }} / {{ ms(entry.ttftMs) }}</code></div>
                      <div v-if="entry.firstByteMeaning === 'historical_response_headers'" class="detail-item"><span>历史响应头计时（旧 firstByteMs）</span><code>{{ ms(entry.firstByteMs) }}</code></div>
                      <div class="detail-item"><span>输出阶段耗时</span><code>{{ ms(entry.generationMs) }}</code></div>
                      <div class="detail-item"><span>输入等效（非实测预填充） / 输出速度</span><code>{{ tps(entry.prefillTps) }} / {{ tps(measuredOutputTps(entry)) }}</code></div>
                      <div class="detail-item"><span>端到端输出速度</span><code>{{ tps(entry.endToEndTps) }}</code></div>
                      <div class="detail-item"><span>错误类型</span><code>{{ entry.errorType || '—' }}</code></div>
                      <div class="detail-item"><span>输入 Token</span><code>{{ num(entry.promptTokens) }}</code></div>
                      <div class="detail-item"><span>未命中 / 缓存</span><code>{{ num(Math.max(0, (entry.promptTokens || 0) - (entry.cachedTokens || 0))) }} / {{ num(entry.cachedTokens) }}</code></div>
                      <div class="detail-item"><span>输出 / 推理</span><code>{{ num(entry.completionTokens) }} / {{ num(entry.reasoningTokens) }}</code></div>
                      <div class="detail-item"><span>总 Token</span><code>{{ num(entry.totalTokens) }}</code></div>
                      <div v-if="entry.error" class="detail-item wide"><span>错误</span><code class="err-text">{{ entry.error }}</code></div>
                    </div>
                    <div class="attempts">
                      <h4>重试 / 续期尝试链</h4>
                      <ol v-if="entry.attempts?.length">
                        <li v-for="(attempt, index) in entry.attempts" :key="`${attempt.index}-${index}`">
                          <b>#{{ attempt.index ?? index + 1 }} · {{ attempt.action || '—' }}</b>
                          <span>账号 <code>{{ attempt.accountId || '—' }}</code></span>
                          <span>状态 {{ attempt.status ?? '—' }} · {{ ms(attempt.durationMs) }}</span>
                          <span>错误类型 <code>{{ attempt.errorType || '—' }}</code></span>
                          <span>Trace <code>{{ attempt.traceId || '—' }}</code></span>
                        </li>
                      </ol>
                      <p v-else class="muted tiny">— 暂无尝试链数据</p>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="!logs.length"><td colspan="10" class="empty-state">{{ busy ? '正在加载…' : tableError ? '查询失败，请重试' : '当前条件没有请求记录' }}</td></tr>
          </tbody>
        </table>
      </div>

      <footer class="pager">
        <label class="page-size">每页
          <select :value="pageSize" @change="change({ pageSize: Number($event.target.value) })" aria-label="每页条数">
            <option :value="10">10</option><option :value="20">20</option>
            <option :value="50">50</option><option :value="100">100</option>
          </select>
          条
        </label>
        <span v-if="tableData" class="muted tiny">第 {{ page }} / {{ pages }} 页 · 共 {{ num(total) }} 条</span>
        <span v-else class="muted tiny">{{ busy ? '查询中…' : '暂无查询结果' }}</span>
        <div class="row">
          <button class="btn btn-sm btn-icon" type="button" title="首页" :disabled="busy || !tableData || page <= 1" @click="go(1)"><AppIcon name="chevronsLeft" :size="13" /></button>
          <button class="btn btn-sm btn-icon" type="button" title="上一页" :disabled="busy || !tableData || page <= 1" @click="go(page - 1)"><AppIcon name="chevronLeft" :size="13" /></button>
          <span class="page-now">{{ page }}</span>
          <button class="btn btn-sm btn-icon" type="button" title="下一页" :disabled="busy || !tableData || page >= pages" @click="go(page + 1)"><AppIcon name="chevronRight" :size="13" /></button>
          <button class="btn btn-sm btn-icon" type="button" title="末页" :disabled="busy || !tableData || page >= pages" @click="go(pages)"><AppIcon name="chevronsRight" :size="13" /></button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; align-items: end; flex-wrap: wrap; gap: 10px; padding: 0 19px 12px; }
.filters label { display: flex; flex-direction: column; gap: 5px; color: var(--dim); font-size: 10px; }
.filters select, .filters input { min-height: 32px; max-width: 210px; padding: 5px 8px; color: var(--text); background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-xs); }
.query-note { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 0 19px 12px; }
.attempts { margin-top: 14px; }
.attempts h4 { margin-bottom: 8px; font-size: 11px; }
.attempts ol { list-style: none; padding: 0; }
.attempts li { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 6px; padding: 10px; border: 1px solid var(--line-soft); font-size: 10px; overflow-wrap: anywhere; }
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
.waterfall-track { position: relative; display: flex; width: 100%; height: 10px; margin-top: 10px; overflow: hidden; border-radius: 6px; background: var(--surface-2); }
.waterfall-track i { position: absolute; height: 100%; min-width: 0; }
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
