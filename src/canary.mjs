import { createHash, timingSafeEqual } from 'node:crypto'

export const GRAY_MODELS = new Set(['Kimi_K3.1_Pro_VE'])

export class HttpError extends Error {
  constructor(status, message, code = 'invalid_request_error') {
    super(message)
    this.status = status
    this.code = code
  }
}

export function safeEqual(actual, expected) {
  if (!expected || typeof actual !== 'string') return false
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function apiAuthorized(request, config, admin = false) {
  const authorization = request.headers.authorization || ''
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  return safeEqual(bearer, admin ? config.adminKey : config.apiKey) ||
    safeEqual(String(request.headers['x-admin-key'] || ''), admin ? config.adminKey : '')
}

export function parseCookies(header = '') {
  const cookies = Object.create(null)
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) {
      try { cookies[key] = decodeURIComponent(value) } catch { cookies[key] = value }
    }
  }
  return cookies
}

export function requestIdentity(request) {
  const explicit = String(request.headers['x-gray-key'] || '').trim()
  const authorization = String(request.headers.authorization || '')
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : authorization
  // The explicit key is suitable for per-user routing. Never route by source IP:
  // all clients behind one NAT would otherwise enter the canary together.
  return explicit || (token ? `token:${token}` : 'anonymous')
}

export function bucketFor(identity, salt) {
  const digest = createHash('sha256').update(`${salt}:${identity}`).digest()
  return digest.readUInt32BE(0) % 10000
}

function parseBoolean(value, name) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new HttpError(400, `${name} 必须是 true/false 或 1/0`, 'invalid_canary_override')
}

export function routeGray(request, config, body = {}) {
  const gray = config.gray
  const identity = requestIdentity(request)
  const bucket = bucketFor(identity, gray.salt)
  const headers = request.headers
  const cookies = parseCookies(headers.cookie)
  const forced = String(headers['x-gray-force'] || '').toLowerCase()
  let selected = false
  let reason = 'stable'

  if (!gray.enabled) {
    reason = 'disabled'
  } else if (gray.denylist.includes(identity)) {
    reason = 'denylist'
  } else if (gray.allowlist.includes(identity)) {
    selected = true
    reason = 'allowlist'
  } else if (forced === '1' || forced === '0') {
    if (!gray.allowHeaderOverride) throw new HttpError(403, '服务端禁用了 Header 灰度覆盖', 'canary_override_disabled')
    selected = forced === '1'
    reason = 'header'
  } else if (headers['x-gray-enabled'] !== undefined) {
    if (!gray.allowHeaderOverride) throw new HttpError(403, '服务端禁用了 Header 灰度覆盖', 'canary_override_disabled')
    selected = parseBoolean(String(headers['x-gray-enabled']), 'x-gray-enabled')
    reason = 'header'
  } else if (cookies.xiaoyi_gray !== undefined) {
    if (!gray.allowCookieOverride) throw new HttpError(403, '服务端禁用了 Cookie 灰度覆盖', 'canary_override_disabled')
    selected = parseBoolean(cookies.xiaoyi_gray, 'xiaoyi_gray Cookie')
    reason = 'cookie'
  } else {
    selected = bucket < Math.round(gray.percentage * 100)
    reason = selected ? 'percentage' : 'stable'
  }

  const grayModels = new Set([...GRAY_MODELS, ...(config.grayModels || []), ...(gray.models || [])])
  const wantsGrayModel = grayModels.has(body.model)
  if (wantsGrayModel) {
    if (!config.allowGrayModels) {
      throw new HttpError(403, `模型 ${body.model} 默认禁用；确认灰度范围和倍率后设置 allowGrayModels=true`, 'gray_model_disabled')
    }
    selected = true
    reason = 'gray-model'
  }

  return {
    selected,
    reason,
    bucket,
    bucketPercent: bucket / 100,
    pool: selected ? gray.pool : 'stable',
    // Only a keyed hash is returned: credentials and bearer tokens are never logged.
    identityHash: createHash('sha256').update(identity).digest('hex').slice(0, 12),
    forced: ['header', 'cookie', 'allowlist', 'denylist'].includes(reason),
    wantsGrayModel,
  }
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, '配置必须是 JSON 对象')
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new HttpError(400, 'port 必须是 1..65535 的整数')
  for (const key of ['apiKey', 'adminKey']) {
    if (typeof input[key] !== 'string' || input[key].length < 16 || input[key].startsWith('CHANGE_ME')) {
      throw new HttpError(400, `${key} 至少 16 字符，不能使用示例值`)
    }
  }
  if (input.apiKey === input.adminKey) throw new HttpError(400, 'apiKey 与 adminKey 必须不同')
  const url = new URL(input.upstreamUrl)
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new HttpError(400, '非本机 upstreamUrl 必须使用 HTTPS')
  }
  const gray = input.gray
  if (!gray || !Number.isFinite(gray.percentage) || gray.percentage < 0 || gray.percentage > 100) {
    throw new HttpError(400, 'gray.percentage 必须在 0..100 之间')
  }
  if (!['gray', 'stable'].includes(gray.pool)) throw new HttpError(400, 'gray.pool 仅支持 gray 或 stable')
  if (typeof gray.salt !== 'string' || !gray.salt) throw new HttpError(400, 'gray.salt 不能为空')
  for (const key of ['enabled', 'allowHeaderOverride', 'allowCookieOverride', 'shadow']) {
    if (typeof gray[key] !== 'boolean') throw new HttpError(400, `gray.${key} 必须是布尔值`)
  }
  if (typeof input.allowGrayModels !== 'boolean') throw new HttpError(400, 'allowGrayModels 必须是布尔值')
  if (input.allowPanelFromLan !== undefined && typeof input.allowPanelFromLan !== 'boolean') throw new HttpError(400, 'allowPanelFromLan 必须是布尔值')
  for (const key of ['allowlist', 'denylist', 'models']) {
    if (!Array.isArray(gray[key]) || gray[key].some((value) => typeof value !== 'string')) {
      throw new HttpError(400, `gray.${key} 必须是字符串数组`)
    }
  }
  if (!Array.isArray(input.grayModels) || input.grayModels.some((value) => typeof value !== 'string')) {
    throw new HttpError(400, 'grayModels 必须是字符串数组')
  }
  if (new Set([...(input.accounts?.stable || []), ...(input.accounts?.gray || [])].map((account) => account.id)).size !==
      (input.accounts?.stable?.length || 0) + (input.accounts?.gray?.length || 0)) {
    throw new HttpError(400, '所有账号池内 account.id 不能重复')
  }
  if (!Number.isInteger(input.maxBodyBytes) || input.maxBodyBytes < 1024) throw new HttpError(400, 'maxBodyBytes 无效')
  if (!Number.isFinite(input.requestTimeoutMs) || input.requestTimeoutMs < 1000) throw new HttpError(400, 'requestTimeoutMs 无效')
  for (const key of ['kimiCompatibility', 'normalizeToolSchemas', 'upstreamErrorFastFail']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new HttpError(400, `${key} 必须是布尔值`)
  }
  if (input.modelCatalogMinutes !== undefined && (!Number.isFinite(input.modelCatalogMinutes) || input.modelCatalogMinutes < 0)) {
    throw new HttpError(400, 'modelCatalogMinutes 必须是非负数字')
  }
  if (input.upstreamBodyLimitBytes !== undefined && (!Number.isInteger(input.upstreamBodyLimitBytes) || input.upstreamBodyLimitBytes < 65536 || input.upstreamBodyLimitBytes > 4718592)) {
    throw new HttpError(400, 'upstreamBodyLimitBytes 必须在 65536–4718592 之间')
  }
  for (const pool of ['stable', 'gray']) {
    if (!Array.isArray(input.accounts?.[pool])) throw new HttpError(400, `accounts.${pool} 必须是数组`)
    for (const account of input.accounts[pool]) {
      if (!account.id || !account.credential || !account.uid || !account.deviceId) {
        throw new HttpError(400, `accounts.${pool} 每项需要 id/credential/uid/deviceId`)
      }
    }
  }
  return input
}

export function publicConfig(config, stats) {
  return {
    listen: config.listen,
    port: config.port,
    upstreamHost: new URL(config.upstreamUrl).host,
    allowGrayModels: config.allowGrayModels,
    gray: config.gray,
    accounts: Object.fromEntries(['stable', 'gray'].map((pool) => [pool, config.accounts[pool].map((account) => ({
      id: account.id,
      uid: account.uid,
      deviceId: `${String(account.deviceId).slice(0, 8)}…`,
      hasRefreshToken: Boolean(account.refreshToken),
      validTimeSec: account.validTimeSec || null,
    }))])),
    stats,
  }
}
