<script setup>
import { computed, shallowRef, watch } from 'vue'
import { logs, logStats, refreshAll, loadLogs, windowHours } from '../composables/useDashboard.js'
import { api } from '../composables/useApi.js'
import { notify } from '../composables/useToast.js'
import AppIcon from './AppIcon.vue'
import { num, ms, clock, pct, compact, exact, ago } from '../composables/useFormat.js'

const props = defineProps({ polling: { type: Boolean, default: true } })
const emit = defineEmits(['update:polling'])

const PAGE_SIZE = 50
const page = shallowRef(1)
const total = shallowRef(0)
const busy = shallowRef(false)
const expanded = shallowRef(null)

const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

async function load() {
  busy.value = true
  try {
    // Follow the shared window so switching ranges on the overview keeps the
    // numbers consistent when coming back to this page.
    const data = await loadLogs({ page: page.value, pageSize: PAGE_SIZE, hours: windowHours.value })
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
</script>

<template>
  <div class="stack">
    <div class="stats">
      <div class="mini card"><span>请求</span><b>{{ num(logStats.last24h || 0) }}</b></div>
      <div class="mini card"><span>失败</span><b :class="{ bad: (logStats.failed24h || 0) > 0 }">{{ num(logStats.failed24h || 0) }}</b></div>
      <div class="mini card"><span>缓存命中率</span><b class="good">{{ pct(logStats.cacheHitRate) }}</b></div>
      <div class="mini card" :title="`输入 ${exact(logStats.promptTokens24h)} + 输出 ${exact(logStats.completionTokens24h)}`">
        <span>总 Token</span><b>{{ compact(logStats.tokens24h || 0) }}</b>
      </div>
      <div class="mini card"><span>平均耗时</span><b>{{ ms(logStats.averageMs) }}</b></div>
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
              <th class="right" style="width: 80px">输出</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="entry in logs" :key="entry.id">
              <tr class="row-click" @click="expanded = expanded === entry.id ? null : entry.id">
                <td class="num muted">{{ clock(entry.at) }}</td>
                <td class="truncate mono">{{ entry.model }}</td>
                <td><span class="badge" :class="entry.route === 'gray' ? 'accent' : ''">{{ entry.route === 'gray' ? '灰度' : '稳定' }}</span></td>
                <td><span class="badge" :class="statusTone(entry)">{{ entry.status ?? '进行中' }}</span></td>
                <td class="right num">{{ ms(entry.ms) }}</td>
                <td class="right num muted">{{ ms(entry.ttftMs) }}</td>
                <td class="right num">{{ num(entry.promptTokens) }}</td>
                <td class="right num" :class="{ good: (hitRate(entry) || 0) >= 50 }">{{ hitRate(entry) === null ? '—' : pct(hitRate(entry)) }}</td>
                <td class="right num">{{ num(entry.completionTokens) }}</td>
              </tr>
              <tr v-if="expanded === entry.id" class="detail-row">
                <td colspan="9">
                  <div class="detail">
                    <div class="detail-item"><span>请求 ID</span><code>{{ entry.id }}</code></div>
                    <div class="detail-item"><span>账号</span><code>{{ entry.accountId || '—' }}</code></div>
                    <div class="detail-item"><span>灰度原因</span><code>{{ entry.reason || '—' }}</code></div>
                    <div class="detail-item"><span>首字节</span><code>{{ ms(entry.firstByteMs) }}</code></div>
                    <div class="detail-item"><span>缓存 Token</span><code>{{ num(entry.cachedTokens) }}</code></div>
                    <div class="detail-item"><span>推理 Token</span><code>{{ num(entry.reasoningTokens) }}</code></div>
                    <div v-if="entry.error" class="detail-item wide"><span>错误</span><code class="err-text">{{ entry.error }}</code></div>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="!logs.length"><td colspan="9" class="empty-state">还没有请求记录</td></tr>
          </tbody>
        </table>
      </div>

      <footer class="pager">
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
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.mini { padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; border-radius: var(--r-md); }
.mini span { font-size: 10.5px; color: var(--dim); }
.mini b { font-size: 18px; font-family: var(--font-mono); font-weight: 640; }
.mini b.mini b.bad { color: var(--red); }
.table-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 17px 19px 13px; flex-wrap: wrap; }
.table-head h3 { margin-top: 5px; font-size: 15px; font-weight: 640; }
.toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dim); cursor: pointer; user-select: none; }
.toggle input { accent-color: var(--accent); }
.row-click { cursor: pointer; }
.detail-row td { background: var(--surface-2); padding: 0; }
.detail { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px 20px; padding: 14px 18px; }
.detail-item { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.detail-item.wide { grid-column: 1 / -1; }
.detail-item span { font-size: 10px; color: var(--dim-2); text-transform: uppercase; letter-spacing: 0.05em; }
.detail-item code { font-size: 11px; color: var(--text-2); word-break: break-all; }
.err-text { color: var(--red) !important; }
.pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 18px; border-top: 1px solid var(--line-soft); flex-wrap: wrap; }
.good { color: var(--green); }
.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg) } }
.page-now {
  min-width: 34px; text-align: center; font-family: var(--font-mono);
  font-size: 11.5px; color: var(--text-2); font-weight: 600;
}
.mini { border-radius: var(--r-md); }
.mini b { letter-spacing: -0.02em; }

/* phone: collapse the table into compact cards */
@media (max-width: 720px) {
  .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .mini { padding: 10px 11px; }
  .mini span { font-size: 9.5px; }
  .mini b { font-size: 15px; }
  .table-head { padding: 13px 13px 10px; gap: 8px; }
  .table-head .row { width: 100%; justify-content: space-between; }
  .table-wrap { overflow-x: visible; }
  thead { display: none; }

  tbody tr.row-click {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    grid-template-areas:
      'time  status dur'
      'model route  route';
    align-items: center;
    gap: 3px 10px;
    padding: 11px 13px;
    border-bottom: 1px solid var(--line-soft);
  }
  tbody tr.row-click td { padding: 0; border: 0; }
  tbody tr.row-click td:nth-child(1) { grid-area: time; font-size: 10.5px; color: var(--dim-2); }
  tbody tr.row-click td:nth-child(2) { grid-area: model; font-size: 12px; font-weight: 600; }
  tbody tr.row-click td:nth-child(3) { grid-area: route; justify-self: start; }
  tbody tr.row-click td:nth-child(4) { grid-area: status; justify-self: end; }
  tbody tr.row-click td:nth-child(5) { grid-area: dur; justify-self: end; font-size: 11px; color: var(--text-2); }
  tbody tr.row-click td:nth-child(6) { display: none; }
  tbody tr.row-click td:nth-child(7),
  tbody tr.row-click td:nth-child(8) { display: none; }
  tbody tr.row-click td:nth-child(9) { display: none; }
  tbody tr.row-click td:nth-child(5)::before { content: ''; }

  .detail-row, .detail-row td { display: block; }
  .pager { padding: 9px 13px; }
  .pager .muted { order: 2; width: 100%; text-align: center; }
}
.good { color: var(--green); }
.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg) } }
.page-now {
  min-width: 34px; text-align: center; font-family: var(--font-mono);
  font-size: 11.5px; color: var(--text-2); font-weight: 600;
}
.mini { border-radius: var(--r-md); }
.mini b { letter-spacing: -0.02em; }

/* phone: collapse the table into compact cards */
@media (max-width: 720px) {
  .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .mini { padding: 10px 11px; }
  .mini span { font-size: 9.5px; }
  .mini b { font-size: 15px; }
  .table-head { padding: 13px 13px 10px; gap: 8px; }
  .table-head .row { width: 100%; justify-content: space-between; }
  .table-wrap { overflow-x: visible; }
  thead { display: none; }

  tbody tr.row-click {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    grid-template-areas:
      'time  status dur'
      'model route  route';
    align-items: center;
    gap: 3px 10px;
    padding: 11px 13px;
    border-bottom: 1px solid var(--line-soft);
  }
  tbody tr.row-click td { padding: 0; border: 0; }
  tbody tr.row-click td:nth-child(1) { grid-area: time; font-size: 10.5px; color: var(--dim-2); }
  tbody tr.row-click td:nth-child(2) { grid-area: model; font-size: 12px; font-weight: 600; }
  tbody tr.row-click td:nth-child(3) { grid-area: route; justify-self: start; }
  tbody tr.row-click td:nth-child(4) { grid-area: status; justify-self: end; }
  tbody tr.row-click td:nth-child(5) { grid-area: dur; justify-self: end; font-size: 11px; color: var(--text-2); }
  tbody tr.row-click td:nth-child(6) { display: none; }
  tbody tr.row-click td:nth-child(7),
  tbody tr.row-click td:nth-child(8) { display: none; }
  tbody tr.row-click td:nth-child(9) { display: none; }
  tbody tr.row-click td:nth-child(5)::before { content: ''; }

  .detail-row, .detail-row td { display: block; }
  .pager { padding: 9px 13px; }
  .pager .muted { order: 2; width: 100%; text-align: center; }
}
</style>
