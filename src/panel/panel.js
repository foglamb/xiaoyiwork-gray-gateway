const $ = (id) => document.getElementById(id)
const state = { data: null, logs: [], keys: null, keyVisible: false, tab: 'overview', timer: null }
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
    const [data, logData] = await Promise.all([api('/api/state'), api('/api/logs?limit=150')])
    state.data = data
    state.logs = logData.entries
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
  $('base-url').textContent = data.endpoint.baseUrl
  $('base-url').title = data.endpoint.baseUrl
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
  $('stat-latency').textContent = `平均耗时 ${logStats.averageMs === null ? '—' : `${num(logStats.averageMs)} ms`}`
  $('pool-target').textContent = `目标池：${data.gray.pool === 'gray' ? '灰度' : '稳定'}`
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
  $('client-config').textContent = JSON.stringify({ baseURL: data.endpoint.baseUrl, apiKey: state.keys?.apiKey || '点击上方 API Key 的 ◉ 查看' }, null, 2)
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
      return `<article class="tile"><div class="tile-body"><div class="tile-icon ${pool}">${pool === 'stable' ? 'S' : 'G'}</div><div class="tile-text"><div class="tile-title">${esc(account.id)}<span class="badge ${account.hasRefreshToken ? 'ok' : 'mute'}">${account.hasRefreshToken ? '自动续期' : '手动凭据'}</span></div><div class="tile-line"><span>UID</span><b class="mono">${esc(account.uid)}</b></div><div class="tile-line"><span>积分 / 权益</span><b>${quota ? (quota.windows.length ? num(remaining) : '暂无数据') : '—'}</b></div><div class="tile-line"><span>请求数</span><b>${num(account.requests)}</b></div><div class="tile-line"><span>凭据到期</span><b>${esc(expiry)}</b></div></div></div><div class="tile-foot"><button class="link" data-quota="${esc(account.id)}">查询额度</button><span class="grow"></span><button class="link danger" data-delete-account="${esc(account.id)}">删除</button></div></article>`
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

function renderLogs() {
  const stats = state.data.logStats
  $('log-total').textContent = num(stats.last24h)
  $('log-failed').textContent = num(stats.failed24h)
  $('log-tokens').textContent = stats.tokens24h ? num(stats.tokens24h) : '—'
  $('log-average').textContent = stats.averageMs === null ? '—' : `${num(stats.averageMs)} ms`
  $('logs-body').innerHTML = state.logs.length ? state.logs.map((entry) => `<tr><td class="muted">${esc(new Date(entry.at).toLocaleString('zh-CN', { hour12: false }))}</td><td class="mono">${esc(entry.model || '—')}</td><td><span class="badge ${entry.route === 'gray' ? 'gray' : 'ok'}">${entry.route === 'gray' ? '灰度' : '稳定'}</span></td><td>${esc(entry.accountId || '—')}</td><td><span class="badge ${entry.status < 400 ? 'ok' : 'err'}" title="${esc(entry.error)}">${entry.status === 499 ? '客户端取消' : entry.status < 400 ? `成功 ${entry.status}` : `失败 ${entry.status}`}</span></td><td class="mono">${entry.ms === null ? '—' : `${num(entry.ms)} ms`}</td><td class="mono">${entry.totalTokens === null ? '—' : num(entry.totalTokens)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">暂无请求记录。客户端调用后会在这里看到灰度命中情况。</td></tr>'
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
    $('client-config').textContent = JSON.stringify({ baseURL: state.data.endpoint.baseUrl, apiKey: state.keys.apiKey }, null, 2)
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
$('toggle-gray-models').addEventListener('click', async () => {
  const next = !state.data.allowGrayModels
  if (next && !confirm('灰度模型可能尚未正式开放。Kimi K3.1 Pro 消耗为 13x。确认开放？')) return
  try { await api('/_admin/gray', { method: 'POST', body: JSON.stringify({ allowGrayModels: next }) }); toast(next ? '灰度模型已开放' : '灰度模型已关闭'); await refresh({ quiet: true }) }
  catch (error) { toast(error.message, true) }
})
$('add-account').addEventListener('click', () => { $('account-form').reset(); $('account-dialog').showModal() })
$('cancel-account').addEventListener('click', () => $('account-dialog').close())
$('account-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    await api('/api/accounts', { method: 'POST', body: JSON.stringify({ pool: $('account-pool').value, id: $('account-id').value, credential: $('account-credential').value, uid: $('account-uid').value, deviceId: $('account-device').value, refreshToken: $('account-refresh').value }) })
    $('account-dialog').close()
    toast('账号已保存')
    await refresh({ quiet: true })
  } catch (error) { toast(error.message, true) }
})
$('stable-accounts').addEventListener('click', accountAction)
$('gray-accounts').addEventListener('click', accountAction)
async function accountAction(event) {
  const query = event.target.closest('[data-quota]')
  if (query) {
    query.disabled = true
    try { const result = await api(`/api/accounts/${encodeURIComponent(query.dataset.quota)}/quota`, { method: 'POST', body: '{}' }); toast(`已查询 ${result.quota.windows.length} 个额度窗口`); await refresh({ quiet: true }) }
    catch (error) { toast(error.message, true) } finally { query.disabled = false }
  }
  const remove = event.target.closest('[data-delete-account]')
  if (remove && confirm(`确认从网关删除账号 ${remove.dataset.deleteAccount}？不会退出原小艺Work 客户端。`)) {
    try { await api(`/api/accounts/${encodeURIComponent(remove.dataset.deleteAccount)}`, { method: 'DELETE' }); toast('账号已删除'); await refresh({ quiet: true }) }
    catch (error) { toast(error.message, true) }
  }
}
$('clear-logs').addEventListener('click', async () => { if (!confirm('清空全部请求记录？')) return; try { await api('/api/logs/clear', { method: 'POST', body: '{}' }); await refresh({ quiet: true }); toast('请求记录已清空') } catch (error) { toast(error.message, true) } })
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
    $('client-config').textContent = JSON.stringify({ baseURL: state.data.endpoint.baseUrl, apiKey: result.apiKey }, null, 2)
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
    else if (target === 'base-url') await copyText(state.data.endpoint.baseUrl)
    else if (target === 'client-config') await copyText($('client-config').textContent)
  }
  const text = event.target.closest('[data-copy-text]')
  if (text) await copyText(text.dataset.copyText)
})
refresh().then((ok) => { if (ok) state.timer = setInterval(() => { if (!state.grayDirty && !$('account-dialog').open) refresh({ quiet: true }) }, 10000) })
