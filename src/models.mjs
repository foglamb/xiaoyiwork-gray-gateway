import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { authHeaders } from './upstream.mjs'
import { modelPolicy, HttpError } from './canary.mjs'

const WORK_MODELS_URL = 'https://xiaoyi.huawei.com/celia/service/work/getWorkModelList'
const CHAT_URL = 'https://xiaoyi.huawei.com/chat/'
const HAG_MODELS_URL = 'https://hag-drcn.op.dbankcloud.com/user-ability-gallery/v1/agent/user/query'
const PLATFORM_AGENT_ID = 'agent208b6760552b4fa0b395e5165d0d771e'
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

function cookiePairs(input) {
  const pairs = []
  if (typeof input === 'string') {
    for (const part of input.split(';')) {
      const index = part.indexOf('=')
      if (index > 0) pairs.push([part.slice(0, index).trim(), part.slice(index + 1).trim()])
    }
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        const pair = item.split(';', 1)[0]
        const index = pair.indexOf('=')
        if (index > 0) pairs.push([pair.slice(0, index).trim(), pair.slice(index + 1).trim()])
      } else if (item && typeof item.name === 'string') {
        pairs.push([item.name, String(item.value ?? '')])
      }
    }
  }
  return pairs.filter(([name, value]) => COOKIE_NAME.test(name) && !/[\x00-\x20\x7f]/.test(value))
}

function cookieString(input) {
  const jar = new Map(cookiePairs(input))
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * HAG discovery reuses gateway accounts; a web session is an optional fallback.
 * Credentials stay out of public status and catalogue metadata. Cache timestamps
 * describe successful fetches, not failed refresh attempts.
 */
export class ModelCatalog {
  constructor({ fetchImpl = fetch, logger = console, configPath = null } = {}) {
    this.fetch = fetchImpl
    this.logger = logger
    this.sessionPath = configPath ? resolve(dirname(configPath), 'model-catalog-session.json') : null
    this.cookie = ''
    this.updatedAt = null
    this.upstream = []
    this.status = { ok: null, source: 'pending', message: '尚未刷新', refreshedAt: null, lastSuccessAt: null, lastAttemptAt: null, transport: null }
    this.inflight = null
    this.sessionChain = Promise.resolve()
    this.#load()
  }

  #load() {
    if (!this.sessionPath) return
    try {
      const saved = JSON.parse(readFileSync(this.sessionPath, 'utf8'))
      this.cookie = cookieString(saved.cookie)
      this.updatedAt = saved.updatedAt || null
      if (Array.isArray(saved.models)) this.upstream = saved.models.filter((row) => typeof row?.id === 'string' && row.id)
      if (this.upstream.length) {
        this.status = {
          ok: true,
          source: 'upstream-cache',
          message: `已载入 ${this.upstream.length} 个上游缓存模型`,
          refreshedAt: saved.lastSuccessAt || saved.refreshedAt || null,
          lastSuccessAt: saved.lastSuccessAt || saved.refreshedAt || null,
          lastAttemptAt: saved.lastAttemptAt || null,
          transport: ['hag', 'web'].includes(saved.transport) ? saved.transport : null,
        }
      }
    } catch { /* absent or invalid private session starts empty */ }
  }

  #save() {
    if (!this.sessionPath) return
    const temporary = `${this.sessionPath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({
      version: 2,
      cookie: this.cookie,
      updatedAt: this.updatedAt,
      refreshedAt: this.status.lastSuccessAt,
      lastSuccessAt: this.status.lastSuccessAt,
      lastAttemptAt: this.status.lastAttemptAt,
      transport: this.status.transport,
      models: this.upstream,
    }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.sessionPath)
    // Some NAS filesystems apply their own creation mode; enforce 0600 after rename.
    chmodSync(this.sessionPath, 0o600)
  }

  publicStatus() {
    return {
      ...this.status,
      stale: this.status.source === 'upstream-cache' || this.status.ok !== true || !this.status.lastSuccessAt || Date.now() - Date.parse(this.status.lastSuccessAt) >= 900000,
      sessionConfigured: Boolean(this.cookie),
      sessionUpdatedAt: this.updatedAt,
    }
  }

  importSession(input, refreshOptions = {}) {
    const cookie = cookieString(input?.cookies ?? input?.cookie ?? input)
    if (!cookie) throw new HttpError(400, 'Cookie 为空或格式不正确', 'invalid_catalog_session')
    // Serialize the entire import, including discovery. Waiting only for the
    // initial refresh lets an older web fallback overwrite a newer Cookie.
    const operation = this.sessionChain.then(async () => {
      if (this.inflight) await this.inflight
      this.cookie = cookie
      this.updatedAt = new Date().toISOString()
      this.#save()
      return this.refresh({ ...refreshOptions, force: true })
    })
    this.sessionChain = operation.catch(() => {})
    return operation
  }

  clearSession() {
    const operation = this.sessionChain.then(async () => {
      if (this.inflight) await this.inflight
      this.cookie = ''
      this.updatedAt = null
      // Clearing the optional web session has no bearing on a healthy HAG cache.
      if (this.status.transport !== 'hag') {
        this.status = { ...this.status, ok: null,
          source: this.upstream.length ? 'upstream-cache' : 'observed-config',
          message: this.upstream.length ? `网页备用会话已清除，保留 ${this.upstream.length} 个上游缓存模型` : '网页备用会话已清除',
        }
      }
      this.#save()
      return this.publicStatus()
    })
    this.sessionChain = operation.catch(() => {})
    return operation
  }

  list(config, observed = []) {
    const rows = new Map()
    const source = this.status.source === 'upstream-cache' ? 'upstream-cache' : 'upstream'
    for (const model of this.upstream) {
      if (typeof model.id !== 'string' || !model.id) continue
      rows.set(model.id, { ...model, source, upstreamGray: typeof model.gray === 'boolean' ? model.gray : null })
    }
    for (const [ids, origin] of [[observed, 'observed'], [[...(config.grayModels || []), ...(config.gray?.models || [])], 'config']]) {
      for (const id of ids) {
        if (typeof id === 'string' && id && !rows.has(id)) rows.set(id, { id, name: id, source: origin, upstreamGray: null })
      }
    }
    return [...rows.values()].map((model) => {
      const policy = modelPolicy(config, model.id)
      return { ...model, ...policy, gray: model.upstreamGray === true || policy.gatewayGray, rate: 0 }
    }).sort((a, b) => a.id.localeCompare(b.id))
  }

  async refresh({ force = false, account = null, accounts = account ? [account] : [], renewAccount = null } = {}) {
    if (this.inflight) return this.inflight
    if (!force && this.status.ok && this.status.lastSuccessAt && Date.now() - Date.parse(this.status.lastSuccessAt) < 900000) return this.publicStatus()
    this.inflight = this.#discover(accounts, renewAccount).finally(() => { this.inflight = null })
    return this.inflight
  }

  async #discover(accounts, renewAccount) {
    const errors = []
    let models = null, transport = null
    const seen = new Set()
    for (const original of accounts) {
      if (!original?.credential || !original.uid || !original.deviceId || seen.has(original.uid)) continue
      seen.add(original.uid)
      try {
        try { models = await this.#hagModels(original) }
        catch (error) {
          if (![401, 403].includes(error.status) || !original.refreshToken || !renewAccount) throw error
          const renewed = await renewAccount(original)
          models = await this.#hagModels(renewed || original)
        }
        transport = 'hag'
        break
      } catch (error) {
        errors.push(error instanceof CatalogError ? error : new CatalogError('HAG 模型目录连接或续期失败', 502, 'catalog_unavailable'))
      }
    }
    if (!models && (this.cookie || !accounts.length)) {
      try { models = await this.#workModels(); transport = 'web' }
      catch (error) { errors.push(error instanceof CatalogError ? error : new CatalogError('网页备用目录请求失败', 502, 'catalog_unavailable')) }
    }
    const attemptedAt = new Date().toISOString()
    if (models?.length) {
      this.upstream = models
      this.status = { ok: true, source: 'upstream', message: `已从${transport === 'hag' ? 'HAG ' : '网页备用'}上游获取 ${models.length} 个模型`,
        refreshedAt: attemptedAt, lastSuccessAt: attemptedAt, lastAttemptAt: attemptedAt, transport, errorType: '' }
      try { this.#save() } catch {
        this.status = { ...this.status, message: this.status.message + '；本地缓存保存失败', cacheWriteFailed: true }
      }
    } else {
      const failure = errors.at(-1) || new CatalogError('没有可用目录账号', 503, 'catalog_account_unavailable')
      this.status = { ...this.status, ok: false, source: this.upstream.length ? 'upstream-cache' : 'observed-config',
        message: `目录刷新失败：${failure.message}${this.upstream.length ? '；保留上次成功目录' : ''}`,
        lastAttemptAt: attemptedAt, errorType: failure.code,
      }
    }
    return this.publicStatus()
  }

  async #hagModels(account) {
    const response = await this.fetch(HAG_MODELS_URL, {
      method: 'POST',
      headers: {
        ...authHeaders(account, { sse: false }),
        'x-prd-pkg-name': 'com.huawei.hmos.vassistant',
      },
      body: JSON.stringify({
        type: 'CELIA_CLAW_USER_MODEL_QUERY',
        terminalInfo: {
          agentId: PLATFORM_AGENT_ID,
          brand: 'HUAWEI', countryCode: 'CN', deviceType: 'PC',
          language: 'zh_CN', locale: 'zh-CN', manufacturer: 'HUAWEI',
          osType: 'Hap', phoneType: 'ALN-AL80', prdVer: '11.6.5.414',
          privacyOption: {}, sysVer: 'OpenHarmony-6.1.1.35(Beta1)', ohosApiVersion: 24,
        },
        pagination: { limit: 500, start: '0' },
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new CatalogError(`HAG 模型目录 HTTP ${response.status}`, response.status, 'catalog_http_error')
    const payload = await response.json()
    if (!Array.isArray(payload?.contents)) throw new CatalogError('HAG 模型目录响应无有效列表', 502, 'catalog_invalid_response')
    const list = payload.contents.flatMap((content) => Array.isArray(content?.modelList) ? content.modelList : [])
    const models = list.filter((row) => row && typeof row.modelValue === 'string').map((row) => ({
      id: String(row.modelValue || '').trim(),
      name: String(row.modelName || row.modelValue || '').trim(),
      description: String(row.modelDescription || '').trim(),
      gray: row.gray === true,
      upstreamRate: row.aiPointConsumptionRatio || '',
      vision: row.vision ?? row.supportVision ?? null,
    })).filter((row) => row.id)
    if (!models.length) throw new CatalogError('HAG 上游返回空模型目录', 502, 'catalog_empty')
    return [...new Map(models.map((m) => [m.id, m])).values()]
  }

  async #workModels() {
    const jar = new Map(cookiePairs(this.cookie))
    const page = await this.fetch(CHAT_URL, {
      headers: jar.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {},
      signal: AbortSignal.timeout(12000),
    })
    if (!page.ok) throw new CatalogError(`网页备用会话 HTTP ${page.status}`, page.status, 'catalog_http_error')
    const html = await page.text()
    // The Work catalogue is gated by the upstream web-agent configuration.
    // With the feature disabled, /chat/work redirects home and the internal
    // endpoint returns 404 even with a completely valid logged-in cookie.
    const common = html.match(/<script[^>]*id=["']common["'][^>]*>([\s\S]*?)<\/script>/i)
    if (common) {
      try {
        const config = JSON.parse(common[1])?.config || {}
        const work = (config.webAgents || []).find((agent) => agent.type === 'claw')
        if (work && (work.enableAgent === false || work.enableFeature === false)) {
          throw new CatalogError('当前网页配置未开放小艺Work Web（enableAgent=false）', 404, 'catalog_feature_disabled')
        }
      } catch (error) {
        if (error.message.includes('未开放')) throw error
      }
    }
    for (const [name, value] of cookiePairs(page.headers.getSetCookie?.() || [])) jar.set(name, value)
    const csrf = jar.get('xy_csrf_token')
    if (!csrf) throw new CatalogError('网页备用目录未返回 CSRF 会话', 401, 'catalog_session_required')
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    const response = await this.fetch(WORK_MODELS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        cookie,
        origin: 'https://xiaoyi.huawei.com',
        referer: CHAT_URL,
      },
      body: JSON.stringify({ ts: Date.now(), timestamp: Date.now() }),
      signal: AbortSignal.timeout(12000),
    })
    for (const [name, value] of cookiePairs(response.headers.getSetCookie?.() || [])) jar.set(name, value)
    if (!response.ok) throw new CatalogError(`网页备用目录 HTTP ${response.status}`, response.status, 'catalog_http_error')
    this.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    const payload = await response.json()
    let operation = payload.operationResult
    if (typeof operation === 'string') {
      try { operation = JSON.parse(operation) } catch { throw new CatalogError('模型目录响应无法解析', 502, 'catalog_invalid_response') }
    }
    const list = operation?.contents?.[0]?.modelList || payload?.data || []
    if (!Array.isArray(list)) throw new CatalogError('模型目录结构不符合预期', 502, 'catalog_invalid_response')
    const models = list.filter((row) => row && typeof row === 'object').map((row) => ({
      id: row.modelValue || row.id || row.model || row.modelName,
      name: row.modelName || row.display_name || row.name || row.modelValue || row.id,
      description: row.aiPointConsumptionRatio || row.description || '',
      vision: row.vision ?? row.supportVision ?? null,
    })).filter((row) => typeof row.id === 'string' && row.id)
    if (!models.length) throw new CatalogError('网页备用目录返回空列表', 502, 'catalog_empty')
    return [...new Map(models.map((m) => [m.id, m])).values()]
  }
}

class CatalogError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code }
}
