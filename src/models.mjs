import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const WORK_MODELS_URL = 'https://xiaoyi.huawei.com/celia/service/work/getWorkModelList'
const CHAT_URL = 'https://xiaoyi.huawei.com/chat/'
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
 * Upstream model discovery uses a separate Xiaoyi web session. That cookie is
 * never mixed into chat credentials, API responses, or logs. The local session
 * file also caches the last genuine catalogue so restarts do not erase it.
 */
export class ModelCatalog {
  constructor({ fetchImpl = fetch, logger = console, configPath = null } = {}) {
    this.fetch = fetchImpl
    this.logger = logger
    this.sessionPath = configPath ? resolve(dirname(configPath), 'model-catalog-session.json') : null
    this.cookie = ''
    this.updatedAt = null
    this.upstream = []
    this.status = { ok: null, source: 'pending', message: '尚未刷新', refreshedAt: null }
    this.inflight = null
    this.#load()
  }

  #load() {
    if (!this.sessionPath) return
    try {
      const saved = JSON.parse(readFileSync(this.sessionPath, 'utf8'))
      this.cookie = cookieString(saved.cookie)
      this.updatedAt = saved.updatedAt || null
      if (Array.isArray(saved.models)) this.upstream = saved.models.filter((row) => row?.id)
      if (this.upstream.length) {
        this.status = {
          ok: true,
          source: 'upstream-cache',
          message: `已载入 ${this.upstream.length} 个上游缓存模型`,
          refreshedAt: saved.refreshedAt || this.updatedAt,
        }
      }
    } catch { /* absent or invalid private session starts empty */ }
  }

  #save() {
    if (!this.sessionPath) return
    const temporary = `${this.sessionPath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({
      version: 1,
      cookie: this.cookie,
      updatedAt: this.updatedAt,
      refreshedAt: this.status.refreshedAt,
      models: this.upstream,
    }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.sessionPath)
    // Some NAS filesystems apply their own creation mode; enforce 0600 after rename.
    chmodSync(this.sessionPath, 0o600)
  }

  publicStatus() {
    return {
      ...this.status,
      sessionConfigured: Boolean(this.cookie),
      sessionUpdatedAt: this.updatedAt,
    }
  }

  async importSession(input) {
    const cookie = cookieString(input?.cookies ?? input?.cookie ?? input)
    if (!cookie) throw new Error('Cookie 为空或格式不正确')
    this.cookie = cookie
    this.updatedAt = new Date().toISOString()
    this.#save()
    return this.refresh({ force: true })
  }

  clearSession() {
    this.cookie = ''
    this.updatedAt = null
    this.status = this.upstream.length
      ? { ok: true, source: 'upstream-cache', message: `目录会话已清除，保留 ${this.upstream.length} 个上游缓存模型`, refreshedAt: this.status.refreshedAt }
      : { ok: null, source: 'observed-config', message: '目录会话已清除，等待重新授权', refreshedAt: null }
    this.#save()
    return this.publicStatus()
  }

  list(config, observed = []) {
    const rows = new Map()
    const add = (id, name, source, extra = {}) => {
      if (!id || typeof id !== 'string') return
      const previous = rows.get(id)
      rows.set(id, {
        id,
        name: name || previous?.name || id,
        source: previous?.source === 'upstream' ? 'upstream' : source,
        ...previous,
        ...extra,
      })
    }
    for (const model of this.upstream) add(model.id, model.name, this.status.source === 'upstream-cache' ? 'upstream-cache' : 'upstream', model)
    for (const id of observed) add(id, id, 'observed')
    for (const id of [...(config.grayModels || []), ...(config.gray?.models || [])]) add(id, id, 'config')
    return [...rows.values()].map((model) => ({
      ...model,
      gray: (config.grayModels || []).includes(model.id) || (config.gray?.models || []).includes(model.id),
      rate: 0,
    })).sort((a, b) => a.id.localeCompare(b.id))
  }

  async refresh({ force = false } = {}) {
    if (this.inflight) return this.inflight
    if (!force && this.status.ok && this.status.refreshedAt && Date.now() - Date.parse(this.status.refreshedAt) < 900000) {
      return this.publicStatus()
    }
    this.inflight = this.#discover().finally(() => { this.inflight = null })
    return this.inflight
  }

  async #discover() {
    try {
      const models = await this.#workModels()
      if (!models.length) throw new Error('上游返回了空模型目录')
      this.upstream = models
      this.status = { ok: true, source: 'upstream', message: `已从上游获取 ${models.length} 个模型`, refreshedAt: new Date().toISOString() }
      this.#save()
    } catch (error) {
      const sessionHint = this.cookie ? '网页目录会话可能已过期，请重新授权' : '尚未配置网页版目录会话'
      this.status = {
        ok: false,
        source: this.upstream.length ? 'upstream-cache' : 'observed-config',
        message: `上游目录暂不可用：${error.message}；${sessionHint}`,
        refreshedAt: new Date().toISOString(),
      }
    }
    return this.publicStatus()
  }

  async #workModels() {
    const jar = new Map(cookiePairs(this.cookie))
    const page = await this.fetch(CHAT_URL, {
      headers: jar.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {},
      signal: AbortSignal.timeout(12000),
    })
    if (!page.ok) throw new Error(`模型会话初始化 HTTP ${page.status}`)
    await page.arrayBuffer()
    for (const [name, value] of cookiePairs(page.headers.getSetCookie?.() || [])) jar.set(name, value)
    const csrf = jar.get('xy_csrf_token')
    if (!csrf) throw new Error('上游未返回 CSRF 会话')
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
    if (!response.ok) throw new Error(`模型目录 HTTP ${response.status}`)
    this.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    const payload = await response.json()
    let operation = payload.operationResult
    if (typeof operation === 'string') {
      try { operation = JSON.parse(operation) } catch { throw new Error('模型目录 operationResult 无法解析') }
    }
    const list = operation?.contents?.[0]?.modelList || payload?.data || []
    if (!Array.isArray(list)) throw new Error('模型目录结构不符合预期')
    return list.map((row) => ({
      id: row.modelValue || row.id || row.model || row.modelName,
      name: row.modelName || row.display_name || row.name || row.modelValue || row.id,
      description: row.aiPointConsumptionRatio || row.description || '',
      vision: row.vision ?? row.supportVision ?? null,
    })).filter((row) => row.id)
  }
}
