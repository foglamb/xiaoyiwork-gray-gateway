const WORK_MODELS_URL = 'https://xiaoyi.huawei.com/celia/service/work/getWorkModelList'
const CHAT_URL = 'https://xiaoyi.huawei.com/chat/'

/**
 * Model metadata comes from the upstream catalogue when it is available.
 * Configured IDs and IDs observed in real requests are separate sources, not a
 * hard-coded list pretending to be an upstream response.
 */
export class ModelCatalog {
  constructor({ fetchImpl = fetch, logger = console } = {}) {
    this.fetch = fetchImpl
    this.logger = logger
    this.upstream = []
    this.status = { ok: null, source: 'pending', message: '尚未刷新', refreshedAt: null }
    this.inflight = null
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
    for (const model of this.upstream) add(model.id, model.name, 'upstream', model)
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
      return this.status
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
    } catch (error) {
      this.status = {
        ok: false,
        source: this.upstream.length ? 'upstream-cache' : 'observed-config',
        message: `上游目录暂不可用：${error.message}`,
        refreshedAt: new Date().toISOString(),
      }
    }
    return this.status
  }

  async #workModels() {
    const page = await this.fetch(CHAT_URL, { signal: AbortSignal.timeout(12000) })
    if (!page.ok) throw new Error(`模型会话初始化 HTTP ${page.status}`)
    await page.arrayBuffer()
    const cookies = page.headers.getSetCookie?.() || []
    const cookie = cookies.map((line) => line.split(';', 1)[0]).join('; ')
    const csrfLine = cookies.find((line) => line.startsWith('xy_csrf_token='))
    const csrf = csrfLine?.split(';', 1)[0].split('=')[1]
    if (!csrf) throw new Error('上游未返回 CSRF 会话')
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
    if (!response.ok) throw new Error(`模型目录 HTTP ${response.status}`)
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
