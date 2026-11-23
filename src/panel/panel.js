const $ = (id) => document.getElementById(id)
const LOG_PAGE_SIZE = 50
const state = { data: null, logs: [], logPage: 1, logPages: 1, logTotal: 0, logCap: 0, modelStats: [], hourly: [], logStats: null, keys: null, keyVisible: false, tab: 'overview', timer: null, addressMode: 'current', logRenderKey: '' }
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const num = (value) => new Intl.NumberFormat('zh-CN').format(Number(value) || 0)
let toastTimer

function toast(message, error = false) {
  clearTimeout(toastTimer)
  $('toast').textContent = message
  $('toast').className = `toast show${error ? ' error' : ''}`
  toastTimer = setTimeout(() => { $('toast').className = 'toast' }, 3500)
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }
  const key = sessionStorage.getItem('xiaoyi-admin-key')
  if (key) headers.authorization = `Bearer ${key}`
  const response = await fetch(path, { ...options, headers })
  const type = response.headers.get('content-type') || ''
  const body = type.includes('json') ? await response.json() : { error: { message: await response.text() } }
  if (!response.ok) {
    const error = new Error(body.error?.message || `HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return body
}

async function refresh({ quiet = false } = {}) {
  try {
    const session = await api('/api/session')
    if (!session.authenticated) {
      if (!quiet) $('auth-dialog').showModal()
      return false
    }
    const logQuery = `page=${state.logPage}&pageSize=${LOG_PAGE_SIZE}&hours=${state.chartHours || 24}`
    const [data, logData] = await Promise.all([api('/api/state'), api('/api/logs?' + logQuery)])
    state.data = data
    state.logs = logData.entries
    state.logPage = logData.page
    state.logPages = logData.pages
    state.logTotal = logData.total
    state.logCap = logData.maxEntries
    state.modelStats = logData.breakdown?.byModel || []
    state.hourly = logData.breakdown?.byHour || []
    state.bucketMs = logData.breakdown?.bucketMs || 3600000
    state.logStats = logData.stats || data.logStats
    $('auth-dialog').open && $('auth-dialog').close()
    render()
    return true
  } catch (error) {
    if (error.status === 401) {
      sessionStorage.removeItem('xiaoyi-admin-key')
      if (!$('auth-dialog').open) $('auth-dialog').showModal()
      $('auth-error').textContent = '管理密钥不正确，请重新输入。'
    } else if (!quiet) toast(error.message, true)
    return false
  }
}

function render() {
  const data = state.data
  if (!data) return
  $('account-count').textContent = data.accounts.length
  $('model-count').textContent = data.models.length
  $('healthy-accounts').textContent = data.accounts.length
  $('base-url').textContent = endpointUrl()
  $('base-url').title = endpointUrl()
  document.querySelectorAll('[data-address]').forEach((button) => {
    const mode = button.dataset.address
    button.classList.toggle('active', mode === state.addressMode || (state.addressMode === 'current' && ((mode === 'local' && !location.hostname.match(/^192\.|^10\.|^172\./)) || (mode === 'lan' && location.hostname.match(/^192\.|^10\.|^172\./)))))
  })
  $('model-summary').textContent = `${data.models.length} 个模型`
  const stats = data.stats
  const logStats = data.logStats
  $('stat-requests').textContent = num(stats.requests)
  $('stat-stable').textContent = num(stats.stable)
  $('stat-gray').textContent = num(stats.gray)
  const total = stats.stable + stats.gray
  const grayPercent = total ? (stats.gray / total * 100) : 0
  const stablePercent = total ? 100 - grayPercent : 100
  $('stable-percent').textContent = total ? `${stablePercent.toFixed(1)}% 实际请求` : '尚无请求'
  $('gray-percent').textContent = total ? `${grayPercent.toFixed(1)}% 实际请求` : '等待灰度流量'
  $('bar-stable').style.width = `${stablePercent}%`
  $('bar-gray').style.width = `${grayPercent}%`
  $('legend-stable').textContent = `${stablePercent.toFixed(1)}%`
  $('legend-gray').textContent = `${grayPercent.toFixed(1)}%`
  $('stat-success').textContent = logStats.successRate === null ? '—' : `${logStats.successRate}%`
  $('stat-latency').textContent = logStats.averageMs === null ? '—' : `${num(logStats.averageMs)} ms`
  const knownQuota = data.quota || { points: 0, accounts: 0, totalAccounts: data.accounts.length }
  // Token analysis only. No billing figure is shown: the gateway does not bill users.
  $('stat-points').textContent = logStats.tokens24h ? num(logStats.tokens24h) : '—'
  $('stat-spend').textContent = logStats.cacheHitRate === null || logStats.cacheHitRate === undefined ? '缓存命中 —' : `缓存命中 ${formatRate(logStats.cacheHitRate)}`
  $('quota-summary').textContent = knownQuota.accounts
    ? `账户余额 ${num(knownQuota.points)} 点（上游原值，${knownQuota.accounts}/${knownQuota.totalAccounts} 已查）`
    : '账户余额待查询'
  $('spend-summary').textContent = logStats.promptTokens24h ? `24h Token ${num(logStats.tokens24h)}` : '24h Token —'
  // pool target is shown by the legend; no separate element needed.
  if (!state.grayDirty) {
    $('gray-enabled').checked = data.gray.enabled
    $('gray-percentage').value = data.gray.percentage
    updateRange()
  }
  $('gray-state').textContent = data.gray.enabled ? `灰度中 · ${data.gray.percentage}%` : '全量稳定'
  $('gray-state').className = `badge ${data.gray.enabled ? 'brand' : 'mute'}`
  document.querySelectorAll('[data-rollout]').forEach((item) => {
    const target = Number(item.dataset.rollout)
    item.classList.toggle('active', data.gray.enabled && ((target === 1 && data.gray.percentage <= 1) || (target === 5 && data.gray.percentage > 1 && data.gray.percentage <= 10) || (target === 25 && data.gray.percentage > 10 && data.gray.percentage < 100) || (target === 100 && data.gray.percentage === 100)))
  })
  renderAccounts()
  renderModels()
  renderLogs()
  $('request-timeout').value = Math.round(data.requestTimeoutMs / 1000)
  $('allow-header').checked = data.gray.allowHeaderOverride
  $('allow-cookie').checked = data.gray.allowCookieOverride
  $('client-config').textContent = JSON.stringify({ baseURL: endpointUrl(), apiKey: state.keys?.apiKey || '点击上方 API Key 的 ◉ 查看' }, null, 2)
}

function endpointUrl() {
  const endpoint = state.data.endpoint
  if (state.addressMode === 'lan') return endpoint.lanUrls[0] || endpoint.currentUrl
  if (state.addressMode === 'local') return endpoint.baseUrl
  return endpoint.currentUrl || endpoint.baseUrl
}

function updateRange() {
  const value = Number($('gray-percentage').value)
  $('gray-percentage-label').innerHTML = `${value}<span>%</span>`
  $('gray-percentage').style.setProperty('--range', `${value}%`)
  document.querySelectorAll('[data-percentage]').forEach((button) => button.classList.toggle('active', Number(button.dataset.percentage) === value))
}

function renderAccounts() {
  const accounts = state.data.accounts
  for (const pool of ['stable', 'gray']) {
    const list = accounts.filter((account) => account.pool === pool)
    $(`${pool}-count`).textContent = list.length
    $(`${pool}-accounts`).innerHTML = list.length ? list.map((account) => {
      const quota = account.quota
      const remaining = quota?.windows?.reduce((sum, window) => sum + (typeof window.remaining === 'number' ? window.remaining : 0), 0)
      const expiry = account.validTimeSec ? new Date(account.validTimeSec * 1000).toLocaleDateString('zh-CN') : '未记录'
      const quotaText = quota
        ? (quota.windows.length ? `${num(remaining)} 点` : '额度接口无窗口')
        : (account.quotaError ? '查询失败' : '查询中…')
      const quotaTitle = account.quotaError ? `额度查询失败：${account.quotaError}` : (quota?.windows || []).map((window) => `${window.name}: ${window.remaining ?? '—'} ${window.unit || ''}`).join('\n')
      return `<article class="tile"><div class="tile-body"><div class="tile-icon ${pool}">${pool === 'stable' ? 'S' : 'G'}</div><div class="tile-text"><div class="tile-title">${esc(account.displayName || account.id)}<span class="badge ${account.hasRefreshToken ? 'ok' : 'mute'}">${account.hasRefreshToken ? '自动续期' : '手动凭据'}</span>${account.cooling ? '<span class="badge warn" title="请求失败已临时跳过，到期自动恢复">冷却中</span>' : ''}${account.health && !account.health.ok ? `<span class="badge err" title="${esc(account.health.message)}">凭据异常</span>` : account.health?.ok ? '<span class="badge ok">凭据正常</span>' : ''}${account.source === 'oauth' ? '<span class="badge brand">华为登录</span>' : ''}</div><div class="tile-line"><span>UID</span><b class="mono">${esc(account.uid)}</b></div><div class="tile-line" title="${esc(quotaTitle)}"><span>积分余额</span><b>${esc(quotaText)}</b></div><div class="tile-line"><span>请求数</span><b>${num(account.requests)}</b></div><div class="tile-line"><span>凭据到期</span><b>${esc(expiry)}</b></div></div></div><div class="tile-foot"><button class="link" data-quota="${esc(account.id)}" title="重新向上游查询积分与权益包">刷新积分</button><button class="link" data-probe="${esc(account.id)}" title="检测该账号凭据是否仍然有效">检测</button><span class="grow"></span><button class="link danger" data-delete-account="${esc(account.id)}">删除</button></div></article>`
    }).join('') : '<div class="empty">此账号池暂无账号</div>'
  }
}

function renderModels() {
  const keyword = $('model-search').value.trim().toLowerCase()
  const models = state.data.models.filter((model) => !keyword || model.id.toLowerCase().includes(keyword) || model.name.toLowerCase().includes(keyword))
  $('gray-model-state').textContent = state.data.allowGrayModels ? '灰度模型已开放' : '灰度模型保护中'
  $('gray-model-state').className = `badge ${state.data.allowGrayModels ? 'warn' : 'brand'}`
  $('toggle-gray-models').textContent = state.data.allowGrayModels ? '关闭灰度模型' : '开启灰度模型'
  $('models-list').innerHTML = models.map((model, index) => {
    const disabled = model.gray && !state.data.allowGrayModels
    return `<article class="tile"><div class="tile-body"><div class="tile-icon ${model.gray ? 'gray' : index % 3 === 1 ? 'stable' : ''}">${esc(Array.from(model.name)[0])}</div><div class="tile-text"><div class="tile-title">${esc(model.name)}${model.gray ? '<span class="badge gray">灰度</span>' : '<span class="badge ok">稳定</span>'}</div><button class="model-id" data-copy-text="${esc(model.id)}" title="复制模型 ID">${esc(model.id)} ⧉</button><div class="model-meta"><span class="badge ${disabled ? 'mute' : 'brand'}">${disabled ? '默认禁用' : '已开放'}</span><span class="badge ${Number(model.rate) > 1 ? 'warn' : 'mute'}">${esc(model.rate)} 倍率</span>${model.vision ? '<span class="badge mute">图片输入</span>' : ''}</div></div></div></article>`
  }).join('') || '<div class="empty">没有匹配的模型</div>'
}

function formatRate(percent) {
  if (percent === null || percent === undefined) return '—'
  if (percent === 0) return '0%'
  if (percent < 1) return `${percent.toFixed(2)}%`
  return `${Number(percent).toFixed(1)}%`
}

function renderLogs() {
  const stats = state.logStats || state.data.logStats
  $('log-total').textContent = num(stats.last24h)
  $('log-failed').textContent = num(stats.failed24h)
  $('log-cache').textContent = stats.cacheHitRate === null || stats.cacheHitRate === undefined ? '—' : formatRate(stats.cacheHitRate)
  $('log-tokens').textContent = stats.tokens24h ? num(stats.tokens24h) : '—'
  $('log-reasoning').textContent = stats.reasoningTokens24h ? num(stats.reasoningTokens24h) : '—'
  $('log-average').textContent = stats.averageMs === null ? '—' : `${num(stats.averageMs)} ms`
  $('log-page-info').textContent = `第 ${state.logPage}/${state.logPages} 页 · 共 ${state.logTotal} 条`
  $('log-cap').textContent = num(state.logCap || 0)
  $('cache-hint').textContent = stats.cacheHitRate === null || stats.cacheHitRate === undefined
    ? '上游本次未报告缓存 token'
    : `命中 ${num(stats.cachedTokens24h || 0)} / 输入 ${num(stats.promptTokens24h || 0)} token`

  renderTokenChart()
  renderModelStats()

  const key = JSON.stringify(state.logs.map((entry) => [entry.id, entry.status, entry.ms, entry.totalTokens]))
  if (key === state.logRenderKey) return
  state.logRenderKey = key
  $('logs-body').innerHTML = state.logs.length ? state.logs.map((entry) => {
    const cacheRate = entry.promptTokens ? ((entry.cachedTokens || 0) / entry.promptTokens) * 100 : null
    return `<tr><td class="muted">${esc(new Date(entry.at).toLocaleString('zh-CN', { hour12: false }))}</td><td class="mono">${esc(entry.model || '—')}</td><td><span class="badge ${entry.route === 'gray' ? 'gray' : 'ok'}">${entry.route === 'gray' ? '灰度' : '稳定'}</span></td><td>${esc(entry.accountId || '—')}</td><td><span class="badge ${entry.status < 400 ? 'ok' : 'err'}" title="${esc(entry.error)}">${entry.status === 499 ? '取消' : entry.status < 400 ? entry.status : `失败 ${entry.status}`}</span></td><td class="mono">${entry.ms === null ? '—' : `${num(entry.ms)} ms`}</td><td class="mono" title="首字节 ${entry.firstByteMs ?? '—'} ms">${entry.ttftMs === null || entry.ttftMs === undefined ? '—' : `${num(entry.ttftMs)} ms`}</td><td class="mono">${entry.promptTokens === null ? '—' : num(entry.promptTokens)}</td><td class="mono">${entry.cachedTokens === null ? '—' : num(entry.cachedTokens)}</td><td class="mono">${cacheRate === null ? '—' : formatRate(cacheRate)}</td><td class="mono">${entry.completionTokens === null ? '—' : num(entry.completionTokens)}</td><td class="mono">${entry.reasoningTokens === null ? '—' : num(entry.reasoningTokens)}</td><td class="mono">${entry.totalTokens === null ? '—' : num(entry.totalTokens)}</td></tr>`
  }).join('') : '<tr><td colspan="13" class="empty">暂无请求记录。客户端调用后会在这里看到缓存命中、首 token 延迟与 Token 构成。</td></tr>'
}

// Chart state: x axis is time buckets, y axis is the selected metric.
state.chartMetric = 'tokens'
state.chartHours = 24

const SERIES = {
  tokens: [
    { key: 'prompt', label: '输入', color: 'var(--gray)', dash: '' },
    { key: 'cached', label: '缓存命中', color: 'var(--green)', dash: '' },
    { key: 'completion', label: '输出', color: 'var(--accent)', dash: '' },
    { key: 'reasoning', label: '推理', color: 'var(--yellow)', dash: '4 3' },
  ],
  cacheRate: [
    { key: 'cacheRate', label: '缓存命中率 %', color: 'var(--green)', dash: '' },
  ],
  requests: [
    { key: 'requests', label: '请求数', color: 'var(--accent)', dash: '' },
    { key: 'failed', label: '失败数', color: 'var(--red)', dash: '4 3' },
  ],
}

function niceMax(value) {
  if (!value || value <= 0) return 1
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)))
  const scaled = value / magnitude
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
  return step * magnitude
}

function shortNumber(value) {
  const number = Number(value) || 0
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`
  if (number >= 1e3) return `${(number / 1e3).toFixed(number >= 1e4 ? 0 : 1)}k`
  return String(Math.round(number))
}

function timeLabel(at, hours, bucketMs = 3600000) {
  const date = new Date(at)
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (bucketMs < 3600000) return hm
  if (hours > 24) return `${date.getMonth() + 1}/${date.getDate()} ${hm}`
  return hm
}

/** Line chart with time on the x axis, drawn as SVG so there is no chart dependency. */
function renderTokenChart() {
  const host = $('token-chart')
  const hours = state.chartHours
  const raw = (state.hourly || []).slice(-Math.max(1, state.hourly.length))
  // Server picks the bucket width; plot every bucket it returned for this range.
  const buckets = raw
  const series = SERIES[state.chartMetric] || SERIES.tokens
  const totals = buckets.reduce((acc, bucket) => {
    acc.prompt += bucket.prompt || 0
    acc.cached += bucket.cached || 0
    acc.completion += bucket.completion || 0
    acc.reasoning += bucket.reasoning || 0
    acc.requests += bucket.requests || 0
    acc.failed += bucket.failed || 0
    return acc
  }, { prompt: 0, cached: 0, completion: 0, reasoning: 0, requests: 0, failed: 0 })
  if (!totals.requests) {
    host.innerHTML = '<div class="empty">这个时间范围内还没有请求，发一次调用后图表就会有点和线。</div>'
    $('chart-legend').innerHTML = ''
    return
  }

  // For the cache-rate view, per-bucket rate is derived from that hour's tokens.
  const points = buckets.map((bucket) => {
    if (state.chartMetric === 'cacheRate') {
      return { at: bucket.at, cacheRate: bucket.prompt ? (bucket.cached / bucket.prompt) * 100 : 0 }
    }
    return bucket
  })
  const maxValue = state.chartMetric === 'cacheRate'
    ? 100
    : niceMax(Math.max(...points.flatMap((point) => series.map((line) => Number(point[line.key]) || 0))))
  const width = 860
  const height = 260
  const pad = { top: 16, right: 18, bottom: 34, left: 56 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const xAt = (index) => pad.left + (points.length <= 1 ? plotW / 2 : (index / (points.length - 1)) * plotW)
  const yAt = (value) => pad.top + plotH - (Math.min(Number(value) || 0, maxValue) / maxValue) * plotH

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const value = maxValue * fraction
    const y = pad.top + plotH - fraction * plotH
    const label = state.chartMetric === 'cacheRate' ? `${Math.round(value)}%` : shortNumber(value)
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="chart-grid" /><text x="${pad.left - 10}" y="${y + 4}" class="chart-axis" text-anchor="end">${label}</text>`
  }).join('')

  const tickEvery = Math.max(1, Math.ceil(points.length / 8))
  const xTicks = points.map((point, index) => (index % tickEvery === 0 || index === points.length - 1)
    ? `<text x="${xAt(index)}" y="${height - 12}" class="chart-axis" text-anchor="middle">${timeLabel(point.at, hours, state.bucketMs)}</text>` : '').join('')

  const lines = series.map((line) => {
    // Skip isolated zero buckets so the line does not dive to the baseline between samples.
    const segments = []
    let current = []
    points.forEach((point, index) => {
      const hasData = (point.requests || 0) > 0 || state.chartMetric === 'cacheRate'
      if (hasData) current.push(`${xAt(index).toFixed(1)},${yAt(point[line.key]).toFixed(1)}`)
      else if (current.length) { segments.push(current); current = [] }
    })
    if (current.length) segments.push(current)
    let path = segments.map((segment) => segment.map((coordinate, index) => `${index === 0 ? 'M' : 'L'}${coordinate}`).join(' ')).join(' ')
    if (segments.length > 1 && state.chartMetric === 'tokens') {
      // Sparse hours: keep a readable trend by joining all sampled points in order.
      const all = segments.flat()
      path = all.map((coordinate, index) => `${index === 0 ? 'M' : 'L'}${coordinate}`).join(' ')
    }
    const area = state.chartMetric === 'tokens' && series.length > 1
      ? ''
      : `<path d="${path} L${xAt(points.length - 1).toFixed(1)},${pad.top + plotH} L${xAt(0).toFixed(1)},${pad.top + plotH} Z" class="chart-area" style="fill:${line.color}" />`
    const dots = points.map((point, index) => {
      if (state.chartMetric !== 'cacheRate' && (point.requests || 0) === 0) return ''
      const value = Number(point[line.key]) || 0
      const label = state.chartMetric === 'cacheRate' ? `${value.toFixed(1)}%` : shortNumber(value)
      return `<circle cx="${xAt(index).toFixed(1)}" cy="${yAt(value).toFixed(1)}" r="3.2" class="chart-dot" style="fill:${line.color}"><title>${timeLabel(point.at, hours, state.bucketMs)} ${line.label} ${label}</title></circle>`
    }).join('')
    return `${area}<path d="${path}" class="chart-line" style="stroke:${line.color}"${line.dash ? ` stroke-dasharray="${line.dash}"` : ''} />${dots}`
  }).join('')

  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" class="chart-svg" role="img" aria-label="Token 用量趋势">${gridLines}${xTicks}<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" class="chart-axis-line" />${lines}</svg>`
  $('chart-legend').innerHTML = series.map((line) => `<span class="legend-item"><i style="background:${line.color}"></i>${esc(line.label)}<b>${state.chartMetric === 'cacheRate' ? '—' : shortNumber(totals[line.key] || 0)}</b></span>`).join('')
}

function renderModelStats() {
  $('model-stats-body').innerHTML = state.modelStats.length ? state.modelStats.map((row) => `<tr><td class="mono">${esc(row.model)}</td><td class="mono">${num(row.requests)}</td><td class="mono">${num(row.prompt)}</td><td class="mono">${num(row.cached)}</td><td class="mono">${row.cacheHitRate === null ? '—' : formatRate(row.cacheHitRate)}</td><td class="mono">${num(row.completion)}</td><td class="mono">${num(row.reasoning)}</td><td class="mono">${row.completion ? formatRate((row.reasoning / row.completion) * 100) : '—'}</td><td class="mono">${row.averageMs === null ? '—' : `${num(row.averageMs)} ms`}</td></tr>`).join('')
    : '<tr><td colspan="9" class="empty">暂无数据</td></tr>'
}

async function saveGray(patch = null) {
  const button = $('save-gray')
  button.disabled = true
  try {
    await api('/_admin/gray', { method: 'POST', body: JSON.stringify(patch || { enabled: $('gray-enabled').checked, percentage: Number($('gray-percentage').value) }) })
    state.grayDirty = false
    $('gray-save-state').textContent = '已保存并立即生效'
    toast(patch?.percentage === 0 ? '已回滚至全量稳定池' : '灰度配置已生效')
    await refresh({ quiet: true })
  } catch (error) { toast(error.message, true) } finally { button.disabled = false }
}

async function revealKey() {
  try {
    state.keys = await api('/api/keys')
    state.keyVisible = !state.keyVisible
    $('api-key').textContent = state.keyVisible ? state.keys.apiKey : '••••••••••••••••'
    $('api-key').classList.toggle('masked', !state.keyVisible)
    $('client-config').textContent = JSON.stringify({ baseURL: endpointUrl(), apiKey: state.keys.apiKey }, null, 2)
    if (state.keyVisible) toast('API Key 已显示，请勿截图分享')
  } catch (error) { toast(error.message, true) }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板') }
  catch { toast('浏览器不允许剪贴板访问，请手动复制', true) }
}

for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab
    document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item === tab))
    document.querySelectorAll('[data-view]').forEach((view) => view.classList.toggle('active', view.dataset.view === state.tab))
    sessionStorage.setItem('xiaoyi-tab', state.tab)
  })
}
const savedTab = sessionStorage.getItem('xiaoyi-tab')
if (savedTab) document.querySelector(`[data-tab="${savedTab}"]`)?.click()

$('theme-toggle').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme
  $('theme-label').textContent = theme === 'dark' ? '深色' : '浅色'
  localStorage.setItem('xiaoyi-theme', theme)
})
const savedTheme = localStorage.getItem('xiaoyi-theme')
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.dataset.theme = savedTheme
  $('theme-label').textContent = savedTheme === 'dark' ? '深色' : '浅色'
}
$('gray-percentage').addEventListener('input', () => { state.grayDirty = true; updateRange(); $('gray-save-state').textContent = '尚未保存' })
$('gray-enabled').addEventListener('change', () => { state.grayDirty = true; $('gray-save-state').textContent = '尚未保存' })
document.querySelector('.presets').addEventListener('click', (event) => {
  const button = event.target.closest('[data-percentage]')
  if (!button) return
  $('gray-percentage').value = button.dataset.percentage
  $('gray-enabled').checked = Number(button.dataset.percentage) > 0
  state.grayDirty = true
  updateRange()
})
$('save-gray').addEventListener('click', () => saveGray())
$('rollback').addEventListener('click', () => { if (confirm('确认立即将全部流量切回稳定池？')) saveGray({ enabled: false, percentage: 0 }) })
$('btn-refresh').addEventListener('click', () => refresh())
$('reveal-key').addEventListener('click', revealKey)
$('model-search').addEventListener('input', renderModels)
$('chart-metric').addEventListener('click', (event) => {
  const button = event.target.closest('[data-metric]')
  if (!button) return
  state.chartMetric = button.dataset.metric
  document.querySelectorAll('[data-metric]').forEach((item) => item.classList.toggle('sel', item === button))
  renderTokenChart()
})
$('chart-range').addEventListener('click', (event) => {
  const button = event.target.closest('[data-hours]')
  if (!button) return
  state.chartHours = Number(button.dataset.hours)
  document.querySelectorAll('[data-hours]').forEach((item) => item.classList.toggle('sel', item === button))
  refresh({ quiet: true })
})
document.querySelectorAll('[data-address]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.address === 'lan' && !state.data.endpoint.lanUrls.length) return toast('未检测到可用的局域网网卡', true)
  state.addressMode = button.dataset.address
  $('base-url').textContent = endpointUrl()
  $('client-config').textContent = JSON.stringify({ baseURL: endpointUrl(), apiKey: state.keys?.apiKey || '点击上方 API Key 的 ◉ 查看' }, null, 2)
  document.querySelectorAll('[data-address]').forEach((item) => item.classList.toggle('active', item === button))
}))
$('toggle-gray-models').addEventListener('click', async () => {
  const next = !state.data.allowGrayModels
  if (next && !confirm('灰度模型可能尚未正式开放。Kimi K3.1 Pro 消耗为 13x。确认开放？')) return
  try { await api('/_admin/gray', { method: 'POST', body: JSON.stringify({ allowGrayModels: next }) }); toast(next ? '灰度模型已开放' : '灰度模型已关闭'); await refresh({ quiet: true }) }
  catch (error) { toast(error.message, true) }
})
$('add-account').addEventListener('click', () => {
  resetOauth()
  $('account-dialog').showModal()
})
$('cancel-account').addEventListener('click', () => { cancelOauth().catch(() => {}); $('account-dialog').close() })

let oauth = null
function resetOauth() {
  oauth = null
  $('oauth-status').hidden = true
  $('oauth-fallback').hidden = true
  $('start-oauth').disabled = false
  $('oauth-callback-url').value = ''
  $('oauth-url').textContent = '—'
  $('oauth-step-text').textContent = '等待授权…'
}
async function cancelOauth() {
  if (!oauth) return
  const state = oauth.state
  oauth = null
  clearInterval(oauthPoll)
  await api('/api/auth/oauth/cancel', { method: 'POST', body: JSON.stringify({ state }) }).catch(() => {})
  resetOauth()
}
let oauthPoll = null
$('start-oauth').addEventListener('click', async () => {
  const pool = $('account-pool').value
  $('start-oauth').disabled = true
  try {
    oauth = await api('/api/auth/oauth/start', { method: 'POST', body: JSON.stringify({ pool }) })
    // No automatic window.open: the user must be able to copy the URL and use
    // their own browser, since the callback points at this machine only.
    $('oauth-open-link').href = oauth.url
    $('oauth-url').textContent = oauth.url
    $('oauth-url').title = oauth.url
    $('oauth-status').hidden = false
    $('oauth-fallback').hidden = false
    $('oauth-step-text').textContent = '等待授权…（本机浏览器可直接完成；远程设备请用下方回调粘贴）'
    clearInterval(oauthPoll)
    oauthPoll = setInterval(pollOauth, 2000)
  } catch (error) {
    $('start-oauth').disabled = false
    toast(error.message, true)
  }
})
async function pollOauth() {
  if (!oauth) return
  try {
    const result = await api(`/api/auth/oauth/status?state=${encodeURIComponent(oauth.state)}`)
    if (result.status === 'failed') {
      clearInterval(oauthPoll)
      $('oauth-step-text').textContent = `登录失败：${result.error}`
      $('oauth-fallback').hidden = false
      $('start-oauth').disabled = false
      return
    }
    if (result.status === 'success') {
      clearInterval(oauthPoll)
      toast(`账号 ${result.account.id} 已加入${result.account.pool === 'gray' ? '灰度池' : '稳定池'}`)
      oauth = null
      $('account-dialog').close()
      resetOauth()
      await refresh({ quiet: true })
    }
  } catch (error) {
    if (error.status === 404 || error.status === 410) { clearInterval(oauthPoll); $('oauth-step-text').textContent = '登录流程已过期，请重新发起。'; $('start-oauth').disabled = false }
  }
}
$('copy-oauth-url').addEventListener('click', () => { if (oauth) copyText(oauth.url); else toast('请先生成登录链接', true) })
$('submit-callback').addEventListener('click', async () => {
  if (!oauth) return toast('请先点击“使用华为账号登录”', true)
  try {
    await api('/api/auth/oauth/complete', { method: 'POST', body: JSON.stringify({ state: oauth.state, callbackUrl: $('oauth-callback-url').value }) })
    $('oauth-step-text').textContent = '回调已接收，正在签发并添加账号…'
    await pollOauth()
  } catch (error) { toast(error.message, true) }
})
$('import-account').addEventListener('click', async () => {
  try {
    const result = await api('/api/auth/import', { method: 'POST', body: JSON.stringify({ text: $('import-text').value, pool: $('account-pool').value }) })
    toast(`账号 ${result.account.id} 已导入`)
    $('account-dialog').close()
    resetOauth()
    await refresh({ quiet: true })
  } catch (error) { toast(error.message, true) }
})
$('stable-accounts').addEventListener('click', accountAction)
$('gray-accounts').addEventListener('click', accountAction)
async function accountAction(event) {
  const probe = event.target.closest('[data-probe]')
  if (probe) {
    probe.disabled = true
    try {
      const result = await api('/api/accounts/probe', { method: 'POST', body: '{}' })
      const mine = result.results.find((row) => row.id === probe.dataset.probe)
      toast(mine ? (mine.ok ? `${mine.id} 凭据正常` : `${mine.id} 异常：${mine.message}`) : '探测完成', !mine?.ok)
      await refresh({ quiet: true })
    } catch (error) { toast(error.message, true) } finally { probe.disabled = false }
    return
  }
  const query = event.target.closest('[data-quota]')
  if (query) {
    query.disabled = true
    try { const result = await api(`/api/accounts/${encodeURIComponent(query.dataset.quota)}/quota`, { method: 'POST', body: '{}' }); toast(`已查询 ${result.quota.windows.length} 个额度窗口`); await refresh({ quiet: true }) }
    catch (error) { toast(error.message, true) } finally { query.disabled = false }
  }
  const remove = event.target.closest('[data-delete-account]')
  if (remove) {
    let force = false
    if (confirm(`确认从网关删除账号 ${remove.dataset.deleteAccount}？不会退出原小艺Work 客户端。`)) {
      if (state.data.accounts.length === 1) force = confirm('这是唯一账号，删除后聊天接口将不可用。确认继续？')
      else if (!confirm('如果这是所在池的唯一账号，删除后该池不可用。确认继续？')) return
    } else return
    try { await api(`/api/accounts/${encodeURIComponent(remove.dataset.deleteAccount)}`, { method: 'DELETE', body: JSON.stringify({ force }) }); toast('账号已删除'); await refresh({ quiet: true }) }
    catch (error) { toast(error.message, true) }
  }
}
$('clear-logs').addEventListener('click', async () => { if (!confirm('清空全部请求记录？')) return; try { await api('/api/logs/clear', { method: 'POST', body: '{}' }); state.logPage = 1; state.logRenderKey = ''; await refresh({ quiet: true }); toast('请求记录已清空') } catch (error) { toast(error.message, true) } })
$('log-prev').addEventListener('click', () => { if (state.logPage <= 1) return; state.logPage--; state.logRenderKey = ''; refresh({ quiet: true }) })
$('log-next').addEventListener('click', () => { if (state.logPage >= state.logPages) return; state.logPage++; state.logRenderKey = ''; refresh({ quiet: true }) })
$('log-latest').addEventListener('click', () => { state.logPage = 1; state.logRenderKey = ''; refresh({ quiet: true }) })
$('auto-refresh').addEventListener('change', (event) => {
  if (event.target.checked) startAutoRefresh()
  else { clearInterval(state.timer); state.timer = null; toast('已暂停自动刷新，避免日志过多时页面卡顿') }
})
$('save-keys').addEventListener('click', async () => {
  const apiKey = $('settings-api-key').value.trim()
  const adminKey = $('settings-admin-key').value.trim()
  if (!apiKey && !adminKey) return toast('请输入需要修改的密钥', true)
  try {
    const result = await api('/api/keys', { method: 'POST', body: JSON.stringify({ ...(apiKey ? { apiKey } : {}), ...(adminKey ? { adminKey } : {}) }) })
    sessionStorage.setItem('xiaoyi-admin-key', result.adminKey)
    state.keys = result
    state.keyVisible = false
    $('api-key').textContent = '••••••••••••••••'
    $('client-config').textContent = JSON.stringify({ baseURL: endpointUrl(), apiKey: result.apiKey }, null, 2)
    $('settings-api-key').value = ''
    $('settings-admin-key').value = ''
    toast('密钥已更新，管理会话已切换至新密钥')
    await refresh({ quiet: true })
  } catch (error) { toast(error.message, true) }
})
$('save-settings').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ requestTimeoutMs: Number($('request-timeout').value) * 1000 }) })
    await api('/_admin/gray', { method: 'POST', body: JSON.stringify({ allowHeaderOverride: $('allow-header').checked, allowCookieOverride: $('allow-cookie').checked }) })
    toast('运行参数已保存')
    await refresh({ quiet: true })
  } catch (error) { toast(error.message, true) }
})
$('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  sessionStorage.setItem('xiaoyi-admin-key', $('admin-key-input').value)
  $('auth-error').textContent = ''
  if (await refresh()) toast('管理密钥验证成功')
})
document.addEventListener('click', async (event) => {
  const copy = event.target.closest('[data-copy]')
  if (copy) {
    const target = copy.dataset.copy
    if (target === 'api-key') { if (!state.keys) state.keys = await api('/api/keys'); await copyText(state.keys.apiKey) }
    else if (target === 'base-url') await copyText(endpointUrl())
    else if (target === 'client-config') await copyText($('client-config').textContent)
  }
  const text = event.target.closest('[data-copy-text]')
  if (text) await copyText(text.dataset.copyText)
})
function startAutoRefresh() {
  clearInterval(state.timer)
  // Only the visible page is fetched, and rendering is skipped when nothing changed.
  state.timer = setInterval(() => {
    if (state.grayDirty || $('account-dialog').open || document.hidden) return
    refresh({ quiet: true })
  }, 15000)
}
refresh().then((ok) => { if (ok) startAutoRefresh() })
document.addEventListener('visibilitychange', () => { if (document.hidden) clearInterval(state.timer); else if ($('auto-refresh').checked) startAutoRefresh() })
