import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AccountPool, MODEL_LIST } from './pool.mjs'
import { GRAY_MODELS, HttpError, apiAuthorized, publicConfig, routeGray, validateConfig } from './canary.mjs'
import { RequestLog } from './requestlog.mjs'
import { isLoopbackAddress, lanUrls, panelAuthorized } from './network.mjs'

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
  persistConfig = async (next) => {
    if (!configPath) throw new HttpError(503, '未配置 configPath，运行态更新不会写入磁盘', 'config_persistence_disabled')
    const { writeFile, rename } = await import('node:fs/promises')
    const temporary = `${configPath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, configPath)
  },
} = {}) {
  let runtime = runtimeFrom(config, configPath, fetchImpl, persistConfig)
  const requestLog = new RequestLog({ configPath, persist: Boolean(configPath) })
  const quotaCache = new Map()
  let panelHtml
  let panelJs
  let panelCss
  const panelMime = { '/panel.js': 'text/javascript; charset=utf-8', '/panel.css': 'text/css; charset=utf-8' }
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

  async function handle(request, response) {
    const requestId = `xy-${crypto.randomUUID()}`
    response.setHeader('x-request-id', requestId)
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('x-frame-options', 'DENY')
    const url = new URL(request.url || '/', 'http://localhost')

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/panel.js' || url.pathname === '/panel.css')) {
      if (!panelAuthorized(request, runtime.config)) throw new HttpError(403, '管理面板默认仅允许本机访问；需显式配置 allowPanelFromLan', 'panel_local_only')
      response.setHeader('content-security-policy', PANEL_CSP)
      response.setHeader('cache-control', 'no-store')
      if (panelMime[url.pathname]) {
        const content = url.pathname === '/panel.js'
          ? (panelJs ??= await readFile(new URL('./panel/panel.js', import.meta.url), 'utf8'))
          : (panelCss ??= await readFile(new URL('./panel/panel.css', import.meta.url), 'utf8'))
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
      })))
      sendJson(response, 200, {
        service: { name: '小艺Work 灰度网关', version: '2.0.0', listen: runtime.config.listen, port: runtime.config.port, startedAt: runtime.pool.stats.startedAt },
        endpoint: { baseUrl: `http://127.0.0.1:${runtime.config.port}/v1`, lanUrls: lanUrls(runtime.config.port) },
        gray: configView.gray, allowGrayModels: configView.allowGrayModels, grayModels: runtime.config.grayModels,
        accounts, stats: runtime.pool.stats, logStats: requestLog.stats(),
        models: MODEL_LIST.map(([id, name]) => ({ id, name, gray: GRAY_MODELS.has(id) || runtime.config.grayModels.includes(id), rate: modelRate(id), vision: modelVision(id) })),
        requestTimeoutMs: runtime.config.requestTimeoutMs,
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
    if (request.method === 'POST' && url.pathname === '/api/accounts') {
      const input = await readJsonBody(request, 256 * 1024)
      if (!['stable', 'gray'].includes(input.pool)) throw new HttpError(400, 'pool 必须为 stable 或 gray')
      const account = normalizeAccountInput(input)
      const candidate = structuredClone(runtime.config)
      if (candidate.accounts[input.pool].some((item) => item.id === account.id)) throw new HttpError(409, `账号 ${account.id} 已存在`, 'account_exists')
      candidate.accounts[input.pool].push(account)
      validateConfig(candidate)
      await persistRuntimeConfig(candidate)
      sendJson(response, 201, { ok: true, id: account.id, pool: input.pool })
      return
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/accounts/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/accounts/'.length))
      const candidate = structuredClone(runtime.config)
      const pool = Object.keys(candidate.accounts).find((key) => candidate.accounts[key].some((account) => account.id === id))
      if (!pool) throw new HttpError(404, '账号不存在', 'account_not_found')
      if (candidate.accounts[pool].length === 1) throw new HttpError(409, `${pool} 池至少保留一个账号；请先添加替代账号`, 'last_account')
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
      const quota = await runtime.pool.quota(account)
      quotaCache.set(id, quota)
      sendJson(response, 200, { ok: true, quota })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/logs') {
      sendJson(response, 200, { entries: requestLog.recent(url.searchParams.get('limit')), stats: requestLog.stats() })
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
      for (const key of ['requestTimeoutMs', 'maxBodyBytes', 'allowPanelFromLan']) {
        if (input[key] !== undefined) candidate[key] = input[key]
      }
      validateConfig(candidate)
      await persistRuntimeConfig(candidate)
      sendJson(response, 200, { ok: true, requestTimeoutMs: candidate.requestTimeoutMs, maxBodyBytes: candidate.maxBodyBytes, allowPanelFromLan: candidate.allowPanelFromLan })
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
    if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      const enabled = new Set([...GRAY_MODELS, ...(runtime.config.grayModels || []), ...(runtime.config.gray.models || [])])
      const data = MODEL_LIST.filter(([id]) => runtime.config.allowGrayModels || !enabled.has(id)).map(([id, name]) => ({
        id, object: 'model', created: 0, owned_by: 'xiaoyiwork', display_name: name,
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
      try {
        const upstreamResponse = await runtime.pool.chat(body, route, { signal: controller.signal, configPath, onUsage: (value) => { usage = value } })
        accountId = upstreamResponse.headers.get('x-xiaoyi-account') || ''
        response.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers))
        if (upstreamResponse.body) {
          for await (const chunk of upstreamResponse.body) {
            if (!response.write(chunk)) await new Promise((resolveDrain) => response.once('drain', resolveDrain))
          }
        }
        response.end()
        requestLog.finish(requestId, { status: upstreamResponse.status, accountId, usage })
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
  const id = String(input.id || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) throw new HttpError(400, '账号 id 需为 1–64 位字母、数字、点、下划线或横线', 'invalid_account')
  const account = {
    id,
    credential: String(input.credential || '').trim(),
    uid: String(input.uid || '').trim(),
    deviceId: String(input.deviceId || '').trim(),
  }
  if (input.refreshToken) account.refreshToken = String(input.refreshToken).trim()
  if (input.validTimeSec !== undefined && input.validTimeSec !== null && input.validTimeSec !== '') {
    account.validTimeSec = Number(input.validTimeSec)
  }
  return account
}

function modelRate(id) {
  return ({ 'LLM_GLM5.3': '8x', 'GLM_5.3_FLASH_VE': '0.8x', 'Kimi_K3.1_Pro_VE': '13x' })[id] || (id === 'Auto-Model' ? '—' : '1x')
}

function modelVision(id) {
  return ['DeepSeek_V4.1_Flash_VE', 'GLM_5.3_FLASH_VE', 'Kimi_K3.1_Pro_VE', 'MiniMax_M3.1_Flash'].includes(id)
}
