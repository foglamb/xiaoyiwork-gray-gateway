import { rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { authHeaders, aggregateSse, transformSse } from './upstream.mjs'
import { HttpError } from './canary.mjs'

const HAG = 'https://hag-drcn.op.dbankcloud.com'
const CLIENT_ID = '6917612679526496902'

export class AccountPool {
  constructor(config, { fetchImpl = fetch, configPath = null, logger = console, persistConfig = null } = {}) {
    this.config = config
    this.fetch = fetchImpl
    this.configPath = configPath
    this.logger = logger
    this.persistConfig = persistConfig
    this.cursors = { stable: 0, gray: 0 }
    this.renewals = new Map()
    this.stats = {
      startedAt: new Date().toISOString(),
      requests: 0,
      stable: 0,
      gray: 0,
      byReason: {},
      byAccount: {},
      upstreamErrors: 0,
      credentialRefreshes: 0,
    }
  }

  select(route) {
    const pool = this.config.accounts[route.pool]?.length ? route.pool : 'stable'
    const accounts = this.config.accounts[pool]
    const index = this.cursors[pool]++ % accounts.length
    this.cursors[pool] %= accounts.length
    return { account: accounts[index], pool }
  }

  async persist() {
    if (this.persistConfig) {
      await this.persistConfig(this.config)
      return
    }
    if (!this.configPath) return
    const target = resolve(this.configPath)
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, target)
  }

  async renew(account) {
    if (!account.refreshToken) throw new HttpError(401, `账号 ${account.id} 凭据失效且未配置 refreshToken`, 'authentication_error')
    if (this.renewals.has(account.id)) return this.renewals.get(account.id)
    const task = this.#renew(account).finally(() => this.renewals.delete(account.id))
    this.renewals.set(account.id, task)
    return task
  }

  #upstreamOrigin() {
    const origin = new URL(this.config.upstreamUrl).origin
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname) ? origin : HAG
  }

  async #renew(account) {    // accessToken has a short freshness window. Refresh and issue back-to-back;
    // never cache the intermediate accessToken.
    const base = this.#upstreamOrigin()
    const refreshedResponse = await this.fetch(`${base}/user-credential/v1/xiaoyiwork/refresh-token`, {
      method: 'POST',
      headers: authHeaders(account, { sse: false }),
      body: JSON.stringify({ refreshToken: account.refreshToken }),
      signal: AbortSignal.timeout(30000),
    })
    const refreshed = await refreshedResponse.json().catch(() => ({}))
    if (!refreshedResponse.ok || !refreshed.token) {
      throw new HttpError(401, `账号 ${account.id} 网关代刷失败（HTTP ${refreshedResponse.status}）：${refreshed.desc || refreshed.message || '无 token'}`, 'authentication_error')
    }
    const createdResponse = await this.fetch(`${base}/user-credential/v1/business-credential/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${refreshed.token}`,
        'x-uid': account.uid,
        'x-client-version': '1.0.0',
        'x-hag-trace-id': `xy-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        deviceId: account.deviceId,
        uid: account.uid,
        clientId: CLIENT_ID,
        sysVer: '5.0.0',
        version: '1.0.0',
        ts: String(Date.now()),
      }),
      signal: AbortSignal.timeout(30000),
    })
    const created = await createdResponse.json().catch(() => ({}))
    const credential = created.credentialResult?.businessCredential || created.credentialResult?.credential ||
      created.data?.businessCredential || created.data?.credential || created.businessCredential || created.credential
    if (!createdResponse.ok || !credential) {
      throw new HttpError(401, `账号 ${account.id} 签票失败（HTTP ${createdResponse.status}）：${created.desc || created.message || '无 credential'}`, 'authentication_error')
    }
    account.credential = credential
    account.validTimeSec = created.credentialResult?.validTime || created.data?.validTime || created.validTime ||
      Math.floor(Date.now() / 1000) + 7 * 86400
    // New credentials become valid immediately. Atomic write with mode 0600;
    // if the file backend fails, still keep the renewed value in memory for retry.
    await this.persist()
    this.stats.credentialRefreshes++
    this.logger.log(`[credential] renewed account=${account.id}; not writing token values to logs`)
    return account
  }

  record(route, account) {
    this.stats.requests++
    this.stats[route.pool]++
    this.stats.byReason[route.reason] = (this.stats.byReason[route.reason] || 0) + 1
    this.stats.byAccount[account.id] = (this.stats.byAccount[account.id] || 0) + 1
  }

  async chat(body, route, { signal, configPath = this.configPath, onUsage } = {}) {
    const { account, pool } = this.select(route)
    this.configPath = configPath
    this.record(route, account)
    const outgoing = { ...body, stream: true }
    const execute = () => this.fetch(this.config.upstreamUrl, {
      method: 'POST',
      headers: authHeaders(account),
      body: JSON.stringify(outgoing),
      signal,
    })
    let response
    try {
      response = await execute()
      if ([401, 403].includes(response.status) && account.refreshToken) {
        await response.body?.cancel()
        await this.renew(account)
        response = await execute()
      }
    } catch (error) {
      this.stats.upstreamErrors++
      if (signal?.aborted) throw error
      throw new HttpError(502, `上游连接失败：${error.message}`, 'upstream_unavailable')
    }
    if (!response.ok) {
      this.stats.upstreamErrors++
      const text = await response.text().catch(() => '')
      throw new HttpError(response.status, `小艺Work 上游 HTTP ${response.status}：${text.slice(0, 1000)}`,
        [401, 403].includes(response.status) ? 'authentication_error' : 'upstream_error')
    }
    if (!response.body) throw new HttpError(502, '上游响应没有 body', 'upstream_error')
    const headers = new Headers({
      'x-xiaoyi-route': route.selected ? 'gray' : 'stable',
      'x-xiaoyi-pool': pool,
      'x-xiaoyi-gray-reason': route.reason,
      'x-xiaoyi-gray-bucket': String(route.bucket),
      'x-xiaoyi-account': account.id,
      'x-request-id': `xy-${crypto.randomUUID()}`,
      'cache-control': 'no-cache, no-transform',
    })
    if (body.stream !== false) {
      headers.set('content-type', 'text/event-stream; charset=utf-8')
      headers.set('x-accel-buffering', 'no')
      return new Response(transformSse(response.body, body.model, { signal, onUsage }), { status: 200, headers })
    }
    const result = await aggregateSse(response.body, body.model, { signal, onUsage })
    headers.set('content-type', 'application/json; charset=utf-8')
    return new Response(JSON.stringify(result), { status: 200, headers })
  }
  async quota(account) {
    const base = this.#upstreamOrigin()
    const query = (agentId) => this.fetch(`${base}/ability-billing/v1/agent-purchases-client/privilege/query`, {
      method: 'POST',
      headers: authHeaders(account, { sse: false }),
      body: JSON.stringify({
        accountType: 'HW_UID', agentId,
        endpoint: {
          device: { brand: 'HUAWEI', deviceId: account.deviceId }, eduMode: 'NONEDU',
          foregroundPkgName: '', isXiaoyiAPP: false, language: 'zh_CN',
          languageMode: 'MANDARIN', locale: 'default',
        },
      }),
      signal: AbortSignal.timeout(30000),
    })
    const responses = await Promise.all([query('1'), query('agent208b6760552b4fa0b395e5165d0d771e')])
    for (let index = 0; index < responses.length; index++) {
      if (![401, 403].includes(responses[index].status)) continue
      await responses[index].body?.cancel()
      if (!account.refreshToken) throw new HttpError(401, `账号 ${account.id} 凭据失效且没有 refreshToken`, 'authentication_error')
      await this.renew(account)
      responses[index] = await query(index === 0 ? '1' : 'agent208b6760552b4fa0b395e5165d0d771e')
    }
    const [premiumResponse, platformResponse] = responses
    const premium = await premiumResponse.json().catch(() => ({}))
    const platform = await platformResponse.json().catch(() => ({}))
    if (!premiumResponse.ok && !platformResponse.ok) {
      throw new HttpError(502, `额度查询失败（会员 ${premiumResponse.status} / 权益包 ${platformResponse.status}）`, 'quota_unavailable')
    }
    const points = premium.celiaPremiumPrivilege?.aiPoints || {}
    const windows = []
    if (typeof points.totalPoints === 'number') {
      windows.push({ name: premium.celiaPremiumPrivilege?.membership?.skuGroupName || '会员积分', remaining: points.totalPoints, unit: '点' })
    }
    for (const privilege of platform.privilegeList || []) {
      const detail = Array.isArray(privilege.privilegeDetail) ? privilege.privilegeDetail.join(' ') : String(privilege.privilegeDetail || '')
      const remaining = Number(detail.match(/(\d+(?:\.\d+)?)/)?.[1])
      windows.push({
        name: privilege.privilegeName || '权益包', remaining: Number.isFinite(remaining) ? remaining : null, unit: '点',
        expiresAt: privilege.expireTime || null,
      })
    }
    return { at: Date.now(), plan: premium.celiaPremiumPrivilege?.membership?.skuGroupName || null, windows }
  }
}

export const MODEL_LIST = [
  ['LLM_DeepSeekV4_Think', 'DeepSeek-V4-Flash'],
  ['DeepSeek_V4.1_Flash_VE', 'DeepSeek-V4.1-Flash'],
  ['LLM_GLM5.3', 'GLM-5.3'],
  ['GLM_5.3_FLASH_VE', 'GLM-5.3-Flash'],
  ['MiniMax_M3.1_Flash', 'MiniMax M3.1 Flash'],
  ['Kimi_K3.1_Pro_VE', 'Kimi K3.1 Pro（灰度）'],
  ['OpenPanguV2-Pro', 'openPangu-2.1-Pro'],
  ['Auto-Model', 'Auto-Model'],
]
