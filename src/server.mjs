import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AccountPool } from './pool.mjs'
import { ModelCatalog } from './models.mjs'
import { GRAY_MODELS, HttpError, apiAuthorized, publicConfig, routeGray, validateConfig } from './canary.mjs'
import { RequestLog } from './requestlog.mjs'
import { isLoopbackAddress, lanUrls, panelAuthorized } from './network.mjs'
import { OAuthManager, OAUTH } from './oauth.mjs'

export const PANEL_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

const DEFAULT_CONFIG_PATH = resolve(process.env.XIAOYI_PROXY_CONFIG || 'config/config.json')

function errorBody(error, requestId) {
  return {
    error: {
      message: error.message || '服务器内部错误',
      type: error.code || 'server_error',
      ...(error.status === 429 ? { retry_after: 1 } : {}),
    },
    request_id: requestId,
  }
}

function sendJson(response, status, value, extraHeaders = {}) {
  const payload = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  response.end(payload)
}

async function readJsonBody(request, maxBytes) {
  const declared = Number(request.headers['content-length'] || 0)
  if (declared > maxBytes) throw new HttpError(413, `请求体超过 ${maxBytes} 字节`, 'request_too_large')
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > maxBytes) {
      request.destroy()
      throw new HttpError(413, `请求体超过 ${maxBytes} 字节`, 'request_too_large')
    }
    chunks.push(chunk)
  }
  if (!length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw new HttpError(400, '请求体必须是合法 JSON', 'invalid_json')
  }
}

function runtimeFrom(config, configPath, fetchImpl, persistConfig) {
  const pool = new AccountPool(config, { fetchImpl, configPath, persistConfig })
  return { config, pool }
}

export function createProxyServer(config, {
  configPath = null,
  fetchImpl = fetch,
  logger = console,
  oauthManager = null,
  persistConfig = async (next) => {
    if (!configPath) throw new HttpError(503, '未配置 configPath，运行态更新不会写入磁盘', 'config_persistence_disabled')
    const { writeFile, rename } = await import('node:fs/promises')
    const temporary = `${configPath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, configPath)
  },
} = {}) {
  let runtime = runtimeFrom(config, configPath, fetchImpl, persistConfig)
  const requestLog = new RequestLog({ configPath, persist: Boolean(configPath), maxEntries: config.logMaxEntries || 1000 })
  const modelCatalog = new ModelCatalog({ fetchImpl, logger, configPath })
  const observedModels = new Set(requestLog.modelIds())
  const modelList = () => modelCatalog.list(runtime.config, [...observedModels])
  const catalogAccount = () => runtime.config.accounts.gray[0] || runtime.config.accounts.stable[0] || null
  modelCatalog.refresh({ account: catalogAccount() }).catch(() => {})
  const quotaCache = new Map()
  const quotaInflight = new Map()
  const quotaError = new Map()
  // Token accounting only; no monetary/points estimation is performed here.
  const spend = { totalTokens: 0, byModel: {}, byRoute: { stable: 0, gray: 0 }, lastAt: null, billed: 0 }

  /** Fetch quota once per account, with a short cache and de-duplicated in-flight calls. */
  async function refreshQuota(account, { force = false, maxAgeMs = 120000 } = {}) {
    const cached = quotaCache.get(account.id)
    if (!force && cached && Date.now() - cached.at < maxAgeMs) return cached
    if (quotaInflight.has(account.id)) return quotaInflight.get(account.id)
    const task = runtime.pool.quota(account)
      .then((quota) => {
        quotaCache.set(account.id, quota)
        quotaError.delete(account.id)
        return quota
      })
      .catch((error) => {
        quotaError.set(account.id, { message: error.message, at: Date.now() })
        throw error
      })
      .finally(() => quotaInflight.delete(account.id))
    quotaInflight.set(account.id, task)
    return task
  }

  /**
   * Usage only. The gateway never estimates billing: the upstream does not report a
   * per-request charge, and for some models (e.g. Kimi K3.1 Pro on this account)
   * there is no deduction at all. Reporting a computed number would be a fabricated fee.
   */
  function recordUsage({ model, route, usage }) {
    const tokens = Number(usage?.total_tokens || 0)
    spend.totalTokens = (spend.totalTokens || 0) + tokens
    spend.byModel[model] = (spend.byModel[model] || 0) + tokens
    spend.byRoute[route] = (spend.byRoute[route] || 0) + tokens
    spend.lastAt = Date.now()
    return tokens
  }

  const oauth = oauthManager || new OAuthManager({ fetchImpl, logger, listen: config.listen === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1' })

  /** Periodic health probe: catches dead credentials before a user request does. */
  let probeTimer = null
  const probeIntervalMs = Math.max(60000, Number(config.accountProbeMinutes || 15) * 60000)
  async function probeAll() {
    const accounts = [...runtime.config.accounts.stable, ...runtime.config.accounts.gray]
    const results = []
    for (const account of accounts) {
      const state = await runtime.pool.probe(account).catch((error) => ({ ok: false, message: error.message }))
      results.push({ id: account.id, ok: state.ok, status: state.status, message: state.message })
      if (!state.ok) logger.warn(`[probe] account=${account.id} unhealthy: ${state.message}`)
    }
    return results
  }
  function startProbing() {
    // Opt-in: probing performs real upstream calls, so it must be explicit.
    // Set accountProbeMinutes (e.g. 15) to enable the scheduled health check.
    if (!(Number(config.accountProbeMinutes) > 0)) return
    clearInterval(probeTimer)
    probeAll().catch(() => {})
    probeTimer = setInterval(() => { probeAll().catch(() => {}) }, probeIntervalMs)
    probeTimer.unref?.()
  }
  let panelHtml
  // Built Vue panel: index.html + app.js + app.css (no inline script, no eval).
  const panelMime = {
    '/app.js': 'text/javascript; charset=utf-8',
    '/app.css': 'text/css; charset=utf-8',
    '/panel.js': 'text/javascript; charset=utf-8',
    '/panel.css': 'text/css; charset=utf-8',
  }
  const panelAssets = ['/app.js', '/app.css', '/panel.js', '/panel.css']
  let updateChain = Promise.resolve()

  function installRuntime(candidate) {
    const previous = runtime.pool
    runtime = runtimeFrom(candidate, configPath, fetchImpl, persistConfig)
    runtime.pool.stats = previous.stats
  }

  async function persistRuntimeConfig(candidate) {
    const update = updateChain.then(() => persistConfig(candidate))
    updateChain = update.catch(() => {})
    await update
    installRuntime(candidate)
  }

  async function addAccount(input) {
    if (!['stable', 'gray'].includes(input.pool)) throw new HttpError(400, 'pool 必须为 stable 或 gray')
    const account = normalizeAccountInput(input)
    const candidate = structuredClone(runtime.config)
    const accounts = candidate.accounts[input.pool]
    const sameUidIndex = input.allowDuplicate === true ? -1 : accounts.findIndex((item) => item.uid === account.uid)
    let replaced = false
    let savedId = account.id

    if (sameUidIndex >= 0) {
      // Re-login/import for the same uid is a credential replacement, not a
      // duplicate-account error. Keep the stable id so logs and quota caches
      // remain associated with the same account.
      const existing = accounts[sameUidIndex]
      savedId = existing.id
      accounts[sameUidIndex] = { ...existing, ...account, id: existing.id }
      replaced = true
    } else {
      if (accounts.some((item) => item.id === account.id)) {
        throw new HttpError(409, `账号 ID ${account.id} 已属于另一个 UID`, 'account_id_conflict')
      }
      const sameUidOtherPool = Object.entries(candidate.accounts)
        .filter(([pool]) => pool !== input.pool)
        .flatMap(([, list]) => list)
        .find((item) => item.uid === account.uid)
      if (sameUidOtherPool && input.allowDuplicate !== true) {
        throw new HttpError(409, `UID ${account.uid} 已配置为 ${sameUidOtherPool.id}；如需跨池移动请先删除旧账号`, 'duplicate_uid')
      }
      accounts.push(account)
    }

    validateConfig(candidate)
    await persistRuntimeConfig(candidate)
    if (replaced) {
      quotaCache.delete(savedId)
      quotaError.delete(savedId)
    }
    return {
      id: savedId,
      uid: account.uid,
      pool: input.pool,
      replaced,
      hasRefreshToken: Boolean(account.refreshToken),
      source: account.source || 'manual',
    }
  }

  async function handle(request, response) {
    const requestId = `xy-${crypto.randomUUID()}`
    response.setHeader('x-request-id', requestId)
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('x-frame-options', 'DENY')
    const url = new URL(request.url || '/', 'http://localhost')

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || panelAssets.includes(url.pathname))) {
      if (!panelAuthorized(request, runtime.config)) throw new HttpError(403, '管理面板默认仅允许本机访问；需显式配置 allowPanelFromLan', 'panel_local_only')
      response.setHeader('content-security-policy', PANEL_CSP)
      // Hashed/immutable assets could cache, but the panel is small and must never show stale logic.
      response.setHeader('cache-control', 'no-store')
      if (panelMime[url.pathname]) {
        const content = await readFile(new URL(`./panel${url.pathname}`, import.meta.url), 'utf8')
        response.writeHead(200, { 'content-type': panelMime[url.pathname] }).end(content)
      } else {
        panelHtml ??= await readFile(new URL('./panel/index.html', import.meta.url), 'utf8')
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(panelHtml)
      }
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/session') {
      if (!panelAuthorized(request, runtime.config)) throw new HttpError(403, '管理面板仅允许本机访问', 'panel_local_only')
      sendJson(response, 200, { authenticated: apiAuthorized(request, runtime.config, true), local: isLoopbackAddress(request.socket.remoteAddress) })
      return
    }

    if (request.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
      sendJson(response, 200, { status: 'ok', time: new Date().toISOString(), uptime: Math.floor(process.uptime()) })
      return
    }

    const admin = url.pathname.startsWith('/_admin/') || url.pathname.startsWith('/api/')
    if (url.pathname.startsWith('/api/') && !panelAuthorized(request, runtime.config)) {
      throw new HttpError(403, '管理接口默认仅允许本机访问', 'panel_local_only')
    }
    if (!apiAuthorized(request, runtime.config, admin)) {
      sendJson(response, 401, errorBody(new HttpError(401, admin ? '需要 Bearer ADMIN_KEY 或 x-admin-key' : '需要 Bearer API_KEY', 'authentication_error'), requestId), { 'www-authenticate': 'Bearer' })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      const configView = publicConfig(runtime.config, runtime.pool.stats)
      const accounts = Object.entries(runtime.config.accounts).flatMap(([pool, list]) => list.map((account) => ({
        id: account.id, pool, uid: account.uid,
        deviceId: `${String(account.deviceId).slice(0, 10)}…`,
        hasRefreshToken: Boolean(account.refreshToken),
        validTimeSec: account.validTimeSec || null,
        requests: runtime.pool.stats.byAccount[account.id] || 0,
        quota: quotaCache.get(account.id) || null,
        quotaError: quotaError.get(account.id)?.message || null,
        source: account.source || 'manual',
        displayName: account.displayName || null,
        cooling: runtime.pool.isCooling(account),
        coolingUntil: runtime.pool.cooldownUntil.get(account.id) || null,
        health: runtime.pool.healthOf(account),
      })))
      // Refresh quota for accounts that have never been queried or are stale, without blocking the panel.
      for (const account of [...runtime.config.accounts.stable, ...runtime.config.accounts.gray]) {
        const cached = quotaCache.get(account.id)
        if (!cached || Date.now() - cached.at > 120000) refreshQuota(account).catch(() => {})
      }
      const requestHost = String(request.headers.host || `127.0.0.1:${runtime.config.port}`)
      const validHost = /^[A-Za-z0-9.\-:[\]]+$/.test(requestHost) ? requestHost : `127.0.0.1:${runtime.config.port}`
      sendJson(response, 200, {
        service: { name: '小艺Work 灰度网关', version: '2.0.0', listen: runtime.config.listen, port: runtime.config.port, startedAt: runtime.pool.stats.startedAt },
        endpoint: { baseUrl: `http://127.0.0.1:${runtime.config.port}/v1`, lanUrls: lanUrls(runtime.config.port), currentUrl: `http://${validHost}/v1` },
        gray: configView.gray, allowGrayModels: configView.allowGrayModels, grayModels: runtime.config.grayModels,
        accounts, stats: runtime.pool.stats, logStats: requestLog.stats(), spend,
        failover: { cooldownSeconds: 60, maxAttempts: 6, cooling: [...runtime.pool.cooldownUntil.keys()] },
        quota: {
          points: [...quotaCache.values()].reduce((sum, item) => sum + (item.windows || []).reduce((n, w) => n + (typeof w.remaining === 'number' ? w.remaining : 0), 0), 0),
          accounts: quotaCache.size,
          totalAccounts: runtime.config.accounts.stable.length + runtime.config.accounts.gray.length,
        },
        models: modelList(), modelCatalog: modelCatalog.publicStatus(),
        requestTimeoutMs: runtime.config.requestTimeoutMs,
        settings: {
          maxBodyBytes: runtime.config.maxBodyBytes,
          allowPanelFromLan: runtime.config.allowPanelFromLan,
          accountProbeMinutes: runtime.config.accountProbeMinutes ?? 0,
          streamHeartbeatMs: runtime.config.streamHeartbeatMs ?? 15000,
          logMaxEntries: runtime.config.logMaxEntries ?? 1000,
          grayModelIds: runtime.config.grayModels || [],
        },
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/keys') {
      sendJson(response, 200, { apiKey: runtime.config.apiKey, adminKey: runtime.config.adminKey })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/keys') {
      const patch = await readJsonBody(request, 16384)
      const candidate = structuredClone(runtime.config)
      if (patch.apiKey !== undefined) candidate.apiKey = patch.apiKey
      if (patch.adminKey !== undefined) candidate.adminKey = patch.adminKey
      validateConfig(candidate)
      await persistRuntimeConfig(candidate)
      sendJson(response, 200, { apiKey: runtime.config.apiKey, adminKey: runtime.config.adminKey })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/oauth/start') {
      const input = await readJsonBody(request, 16384)
      const session = oauth.begin(input)
      const callbackListening = await oauth.startCallbackServer()
      logger.log(`[oauth] started pool=${session.pool}; automaticCallback=${callbackListening}`)
      sendJson(response, 200, { ...oauth.status(session.state), url: session.url, redirectUri: OAUTH.redirectUri, callbackListening, platform: process.platform })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/auth/oauth/status') {
      const state = url.searchParams.get('state') || ''
      const status = oauth.status(state)
      if (status.status === 'success') {
        const session = oauth.consume(state)
        try {
          const account = await addAccount({ ...session.account, pool: session.pool })
          sendJson(response, 200, { ...status, account })
        } catch (error) {
          session.status = 'failed'
          session.error = error.message
          throw error
        }
      } else sendJson(response, 200, status)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/oauth/complete') {
      const input = await readJsonBody(request, 64 * 1024)
      const callbackUrl = parseOauthCallback(input.callbackUrl)
      if (callbackUrl.searchParams.get('state') !== input.state) throw new HttpError(400, '回调网址与当前登录流程不匹配，请复制本次登录的网址', 'oauth_state_mismatch')
      await oauth.receiveCallback(callbackUrl)
      sendJson(response, 200, { ...oauth.status(input.state), message: '华为授权已完成，正在添加账号' })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/oauth/cancel') {
      const input = await readJsonBody(request, 16384)
      oauth.cancel(input.state)
      sendJson(response, 200, { ok: true })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/import') {
      const input = await readJsonBody(request, 256 * 1024)
      const imported = importAccount(input.text)
      const account = await addAccount({ ...imported, pool: input.pool, label: input.label, source: 'import' })
      sendJson(response, 201, { ok: true, account })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/accounts') {
      const input = await readJsonBody(request, 256 * 1024)
      if (!['stable', 'gray'].includes(input.pool)) throw new HttpError(400, 'pool 必须为 stable 或 gray')
      const account = await addAccount(input)
      sendJson(response, 201, { ok: true, id: account.id, pool: input.pool, replaced: account.replaced })
      return
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/accounts/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/accounts/'.length))
      const candidate = structuredClone(runtime.config)
      const pool = Object.keys(candidate.accounts).find((key) => candidate.accounts[key].some((account) => account.id === id))
      if (!pool) throw new HttpError(404, '账号不存在', 'account_not_found')
      if (candidate.accounts[pool].length === 1) {
        const input = await readJsonBody(request, 1024)
        if (input.force !== true) throw new HttpError(409, '这是当前唯一账号。停用后反代将没有可用账号；确认后可在删除请求传 force=true', 'last_account')
      }
      candidate.accounts[pool] = candidate.accounts[pool].filter((account) => account.id !== id)
      await persistRuntimeConfig(candidate)
      quotaCache.delete(id)
      sendJson(response, 200, { ok: true, id })
      return
    }
    if (request.method === 'POST' && /^\/api\/accounts\/[^/]+\/quota$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3])
      const account = [...runtime.config.accounts.stable, ...runtime.config.accounts.gray].find((item) => item.id === id)
      if (!account) throw new HttpError(404, '账号不存在', 'account_not_found')
      try {
        const quota = await runtime.pool.quota(account)
        quotaCache.set(id, quota)
        quotaError.delete(id)
        sendJson(response, 200, { ok: true, quota })
      } catch (error) {
        quotaInflight.delete(id)
        quotaError.set(id, { message: error.message, at: Date.now() })
        // 502 with the upstream reason beats a blank "服务器内部错误".
        throw error.status ? error : new HttpError(502, `额度查询失败：${error.message}`, 'quota_unavailable')
      }
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/quota/refresh') {
      const results = []
      for (const account of [...runtime.config.accounts.stable, ...runtime.config.accounts.gray]) {
        try {
          const quota = await refreshQuota(account, { force: true })
          results.push({ id: account.id, ok: true, windows: quota.windows.length })
        } catch (error) {
          results.push({ id: account.id, ok: false, error: error.message })
        }
      }
      sendJson(response, 200, { ok: true, results, spend, points: [...quotaCache.values()].reduce((sum, item) => sum + (item.windows || []).reduce((n, w) => n + (typeof w.remaining === 'number' ? w.remaining : 0), 0), 0) })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/accounts/probe') {
      const results = await probeAll()
      sendJson(response, 200, { ok: true, results })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/logs') {
      const page = requestLog.page({ page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize') })
      const hours = url.searchParams.get('hours')
      sendJson(response, 200, {
        ...page,
        stats: requestLog.stats(hours),
        breakdown: requestLog.breakdown(hours),
        windowHours: Math.max(1, Math.min(Number(hours) || 24, 168)),
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/logs/clear') {
      requestLog.clear()
      sendJson(response, 200, { ok: true })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/settings') {
      const input = await readJsonBody(request, 16384)
      const candidate = structuredClone(runtime.config)
      // Runtime-tunable keys. Port/listen/upstream need a restart, so they stay out.
      for (const key of ['requestTimeoutMs', 'maxBodyBytes', 'allowPanelFromLan']) {
        if (input[key] !== undefined) candidate[key] = input[key]
      }
      for (const key of ['accountProbeMinutes', 'streamHeartbeatMs', 'logMaxEntries']) {
        if (input[key] !== undefined) {
          const value = Number(input[key])
          if (!Number.isFinite(value) || value < 0) throw new HttpError(400, `${key} 必须是非负数字`, 'invalid_config_patch')
          candidate[key] = value
        }
      }
      if (input.grayModels !== undefined) {
        if (!Array.isArray(input.grayModels) || input.grayModels.some((v) => typeof v !== 'string')) {
          throw new HttpError(400, 'grayModels 必须是字符串数组', 'invalid_config_patch')
        }
        candidate.grayModels = input.grayModels
      }
      validateConfig(candidate)
      await persistRuntimeConfig(candidate)
      installRuntime(candidate)
      sendJson(response, 200, {
        ok: true,
        requestTimeoutMs: candidate.requestTimeoutMs,
        maxBodyBytes: candidate.maxBodyBytes,
        allowPanelFromLan: candidate.allowPanelFromLan,
        accountProbeMinutes: candidate.accountProbeMinutes ?? 0,
        streamHeartbeatMs: candidate.streamHeartbeatMs ?? 15000,
        logMaxEntries: candidate.logMaxEntries ?? 1000,
        grayModels: candidate.grayModels || [],
        restartRequired: [],
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/_admin/config') {
      sendJson(response, 200, publicConfig(runtime.config, runtime.pool.stats))
      return
    }
    if (request.method === 'GET' && url.pathname === '/_admin/stats') {
      sendJson(response, 200, runtime.pool.stats)
      return
    }
    if (request.method === 'POST' && url.pathname === '/_admin/gray') {
      const patch = await readJsonBody(request, Math.min(runtime.config.maxBodyBytes, 64 * 1024))
      const allowed = ['enabled', 'percentage', 'salt', 'allowHeaderOverride', 'allowCookieOverride', 'allowlist', 'denylist', 'pool', 'models', 'shadow', 'allowGrayModels']
      for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw new HttpError(400, `不允许热更新字段 ${key}`, 'invalid_config_patch')
      const candidate = structuredClone(runtime.config)
      Object.assign(candidate.gray, patch)
      delete candidate.gray.allowGrayModels
      if (patch.percentage !== undefined) candidate.gray.percentage = Number(patch.percentage)
      if (patch.allowGrayModels !== undefined) candidate.allowGrayModels = patch.allowGrayModels
      validateConfig(candidate)
      // Serialize updates and install the new config only after its durable write succeeds.
      // A failed update must not poison the queue for subsequent valid updates.
      const update = updateChain.then(() => persistConfig(candidate))
      updateChain = update.catch(() => {})
      await update
      installRuntime(candidate)
      logger.log(`[canary] enabled=${candidate.gray.enabled} percentage=${candidate.gray.percentage} pool=${candidate.gray.pool}`)
      sendJson(response, 200, publicConfig(runtime.config, runtime.pool.stats))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/models/session') {
      const input = await readJsonBody(request, 65536)
      await modelCatalog.importSession(input)
      const status = await modelCatalog.refresh({ force: true, account: catalogAccount() })
      sendJson(response, 200, { ok: status.ok, status, models: modelList() })
      return
    }
    if (request.method === 'DELETE' && url.pathname === '/api/models/session') {
      const status = modelCatalog.clearSession()
      sendJson(response, 200, { ok: true, status, models: modelList() })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/models/refresh') {
      const status = await modelCatalog.refresh({ force: true, account: catalogAccount() })
      sendJson(response, 200, { ok: status.ok, status, models: modelList() })
      return
    }
    if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      const enabled = new Set([...GRAY_MODELS, ...(runtime.config.grayModels || []), ...(runtime.config.gray.models || [])])
      const data = modelList().filter((model) => runtime.config.allowGrayModels || !enabled.has(model.id)).map((model) => ({
        id: model.id, object: 'model', created: 0, owned_by: 'xiaoyiwork', display_name: model.name,
      }))
      sendJson(response, 200, { object: 'list', data })
      return
    }
    if (request.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      const body = await readJsonBody(request, runtime.config.maxBodyBytes)
      if (typeof body.model !== 'string' || !body.model || !Array.isArray(body.messages)) {
        throw new HttpError(400, '需要非空 model 字符串和 messages 数组', 'invalid_request_error')
      }
      if (body.stream !== undefined && typeof body.stream !== 'boolean') {
        throw new HttpError(400, 'stream 必须是布尔值', 'invalid_request_error')
      }
      observedModels.add(body.model)
      const route = routeGray(request, runtime.config, body)
      requestLog.begin({ id: requestId, model: body.model, stream: body.stream !== false, route })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error('上游请求超时')), runtime.config.requestTimeoutMs)
      timeout.unref?.()
      response.once('close', () => {
        if (!response.writableEnded) {
          requestLog.finish(requestId, { status: 499, error: '客户端断开' })
          controller.abort(new Error('客户端断开连接'))
        }
      })
      let usage
      let accountId = ''
      let upstreamError = null
      try {
        let firstTokenAt = 0
        const upstreamResponse = await runtime.pool.chat(body, route, {
          signal: controller.signal,
          configPath,
          onUsage: (value) => { usage = value },
          onFirstToken: () => { if (!firstTokenAt) firstTokenAt = Date.now() },
          onError: (error) => { upstreamError = error },
        })
        accountId = upstreamResponse.headers.get('x-xiaoyi-account') || ''
        response.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers))
        if (upstreamResponse.body) {
          for await (const chunk of upstreamResponse.body) {
            if (!response.write(chunk)) await new Promise((resolveDrain) => response.once('drain', resolveDrain))
          }
        }
        response.end()
        recordUsage({ model: body.model, route: route.selected ? 'gray' : 'stable', usage })
        requestLog.finish(requestId, {
          status: upstreamError ? 502 : upstreamResponse.status,
          accountId, usage, rate: 0,
          error: upstreamError?.message || undefined,
          marks: { firstByteAt: runtime.pool.lastFirstByteAt || null, firstTokenAt: firstTokenAt || null },
        })
      } catch (error) {
        requestLog.finish(requestId, { status: error.status || (controller.signal.aborted ? 499 : 500), error: controller.signal.aborted && !response.writableEnded ? '客户端断开' : error.message })
        throw error
      } finally {
        clearTimeout(timeout)
      }
      return
    }
    throw new HttpError(404, `未知路径 ${url.pathname}`, 'not_found')
  }

  const server = http.createServer(async (request, response) => {
    try {
      await handle(request, response)
    } catch (error) {
      const status = error.status || (error.name === 'AbortError' ? 504 : 500)
      if (!response.headersSent) {
        sendJson(response, status, errorBody(status === 500 && !error.status ? new Error('服务器内部错误') : error, response.getHeader('x-request-id')))
      } else if (!response.writableEnded) {
        response.end()
      }
      if (!error.status || status === 500) logger.error(`[proxy] ${error.stack || error}`)
    }
  })
  startProbing()
  server.on('close', () => { clearInterval(probeTimer); oauth.close?.() })
  server.requestTimeout = 0 // Streaming lifetime is controlled by the upstream AbortController.
  server.headersTimeout = 60000
  server.keepAliveTimeout = 5000
  server.maxRequestsPerSocket = 10000
  return server
}

export async function startFromFile(path = DEFAULT_CONFIG_PATH) {
  const configPath = resolve(path)
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')))
  const server = createProxyServer(config, { configPath })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.listen, resolveListen)
  })
  console.log(`[xiaoyi-proxy] http://${config.listen}:${config.port} gray=${config.gray.percentage}% grayModels=${config.allowGrayModels}`)
  const shutdown = () => {
    server.closeAllConnections?.()
    server.close(() => process.exit(0))
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  return server
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startFromFile().catch((error) => {
    console.error(`[xiaoyi-proxy] 启动失败：${error.message}`)
    process.exitCode = 1
  })
}

function normalizeAccountInput(input) {
  const uid = String(input.uid || '').trim()
  const credential = String(input.credential || '').trim()
  const deviceId = String(input.deviceId || '').trim()
  if (!/^\d{6,32}$/.test(uid)) throw new HttpError(400, 'UID 必须是 6–32 位数字（华为账号 uid）', 'invalid_account')
  if (credential.length < 8 || credential.length > 8192) throw new HttpError(400, 'businessCredential 长度无效', 'invalid_account')
  if (!/^[A-Za-z0-9_.:-]{8,512}$/.test(deviceId)) throw new HttpError(400, 'Device ID 格式无效：需要小艺Work 已登记设备的 ID', 'invalid_account')
  const id = String(input.id || `account-${uid.slice(-6)}`).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) throw new HttpError(400, '账号 id 需为 1–64 位字母、数字、点、下划线或横线', 'invalid_account')
  const account = { id, credential, uid, deviceId }
  if (input.refreshToken) account.refreshToken = String(input.refreshToken).trim()
  if (input.validTimeSec !== undefined && input.validTimeSec !== null && input.validTimeSec !== '') {
    account.validTimeSec = Number(input.validTimeSec)
  }
  if (input.source === 'oauth' || input.source === 'import') account.source = input.source
  if (input.displayName) account.displayName = String(input.displayName).slice(0, 64)
  return account
}

/** Parse a pasted OAuth callback URL. Only the fixed loopback callback is accepted. */
function parseOauthCallback(raw) {
  let url
  try { url = new URL(String(raw || '').trim()) } catch {
    throw new HttpError(400, '请粘贴完整回调网址（以 http://127.0.0.1:17355/auth/callback 开头）', 'oauth_callback_invalid')
  }
  if (url.origin !== 'http://127.0.0.1:17355' || url.pathname !== '/auth/callback') {
    throw new HttpError(400, '回调地址必须是 http://127.0.0.1:17355/auth/callback', 'oauth_callback_invalid')
  }
  if (url.searchParams.get('error')) {
    throw new HttpError(400, `华为授权被拒绝：${url.searchParams.get('error')}`, 'oauth_denied')
  }
  const code = url.searchParams.get('code') || ''
  if (!code) throw new HttpError(400, '回调网址里没有 code，请重新登录', 'oauth_callback_invalid')
  return url
}

/**
 * Import an existing XiaoyiWork login state. Accepts the magpie plugin-auth value,
 * the gateway's own account JSON, or a plain credential string.
 */
function importAccount(text) {
  const raw = String(text || '').trim()
  if (!raw) throw new HttpError(400, '请粘贴登录态 JSON 或凭据', 'invalid_import')
  if (raw.startsWith('{') || raw.startsWith('[')) {
    let parsed
    try { parsed = JSON.parse(raw) } catch { throw new HttpError(400, '登录态 JSON 无法解析', 'invalid_import') }
    const item = Array.isArray(parsed) ? parsed[0] : parsed
    const credential = item?.credential || item?.businessCredential || item?.key || item?.access
    const uid = item?.uid || item?.accountId || item?.metadata?.uid
    const deviceId = item?.deviceId || item?.metadata?.deviceId
    const refreshToken = item?.refreshToken || item?.refresh || item?.metadata?.refreshToken
    if (!credential || !uid) throw new HttpError(400, '登录态缺少 credential 或 uid；请确认是从自己的小艺Work/magpie 配置导出', 'invalid_import')
    if (!deviceId) throw new HttpError(400, '登录态缺少 deviceId：小艺上游要求已登记设备，请一并在导出内容里提供', 'invalid_import')
    return { credential, uid, deviceId, refreshToken, validTimeSec: item.validTimeSec || item.expires || undefined }
  }
  throw new HttpError(400, '只接受 JSON 登录态；不支持手工填接口凭据', 'invalid_import')
}

