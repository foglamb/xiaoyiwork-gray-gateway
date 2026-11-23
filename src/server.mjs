import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AccountPool, MODEL_LIST } from './pool.mjs'
import { GRAY_MODELS, HttpError, apiAuthorized, publicConfig, routeGray, validateConfig } from './canary.mjs'

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
  let updateChain = Promise.resolve()

  async function handle(request, response) {
    const requestId = `xy-${crypto.randomUUID()}`
    response.setHeader('x-request-id', requestId)
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    const url = new URL(request.url || '/', 'http://localhost')

    if (request.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
      sendJson(response, 200, { status: 'ok', time: new Date().toISOString(), uptime: Math.floor(process.uptime()) })
      return
    }

    const admin = url.pathname.startsWith('/_admin/')
    if (!apiAuthorized(request, runtime.config, admin)) {
      sendJson(response, 401, errorBody(new HttpError(401, admin ? '需要 Bearer ADMIN_KEY 或 x-admin-key' : '需要 Bearer API_KEY', 'authentication_error'), requestId), { 'www-authenticate': 'Bearer' })
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
      const previous = runtime.pool
      runtime = runtimeFrom(candidate, configPath, fetchImpl, persistConfig)
      runtime.pool.stats = previous.stats
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
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error('上游请求超时')), runtime.config.requestTimeoutMs)
      timeout.unref?.()
      response.once('close', () => {
        if (!response.writableEnded) controller.abort(new Error('客户端断开连接'))
      })
      try {
        const upstreamResponse = await runtime.pool.chat(body, route, { signal: controller.signal, configPath })
        response.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers))
        if (upstreamResponse.body) {
          for await (const chunk of upstreamResponse.body) {
            if (!response.write(chunk)) await new Promise((resolveDrain) => response.once('drain', resolveDrain))
          }
        }
        response.end()
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
