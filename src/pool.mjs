import { rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { authHeaders, aggregateSse, transformSse } from './upstream.mjs'
import { HttpError } from './canary.mjs'
import { normalizeRequestBody } from './compatibility.mjs'

const HAG = 'https://hag-drcn.op.dbankcloud.com'
export const MAX_HAG_BODY_BYTES = 4_718_592 // 4.5 MiB; larger requests hang then 408 upstream
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

  /** Accounts temporarily skipped after auth/limit failures, with expiry timestamps. */
  cooldownUntil = new Map()

  /** Last health probe result per account id. */
  health = new Map()

  /**
   * Cheap probe: one billing query is enough to tell whether a credential still
   * works, without spending model tokens. Returns a compact state for the panel.
   */
  async probe(account, { timeoutMs = 15000 } = {}) {
    const base = this.#upstreamOrigin()
    try {
      const response = await this.fetch(`${base}/ability-billing/v1/agent-purchases-client/privilege/query`, {
        method: 'POST',
        headers: authHeaders(account, { sse: false }),
        body: JSON.stringify({
          accountType: 'HW_UID', agentId: '1',
          endpoint: {
            device: { brand: 'HUAWEI', deviceId: account.deviceId }, eduMode: 'NONEDU',
            foregroundPkgName: '', isXiaoyiAPP: false, language: 'zh_CN',
            languageMode: 'MANDARIN', locale: 'default',
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const ok = response.ok
      const data = await response.json().catch(() => ({}))
      const state = {
        at: Date.now(), ok, status: response.status,
        errorCode: data.errorCode ?? null,
        message: ok ? (data.errorMessage || 'Success') : String(data.errorMessage || data.desc || `HTTP ${response.status}`).slice(0, 200),
      }
      if (!ok && [401, 403].includes(response.status)) this.cool(account, 300000, `probe ${response.status}`)
      if (ok) this.clearCool(account)
      this.health.set(account.id, state)
      return state
    } catch (error) {
      const state = { at: Date.now(), ok: false, status: 0, errorCode: null, message: `探测失败：${error.message}` }
      this.health.set(account.id, state)
      return state
    }
  }

  healthOf(account) {
    return this.health.get(account.id) || null
  }

  isCooling(account) {
    const until = this.cooldownUntil.get(account.id)
    if (!until) return false
    if (Date.now() >= until) { this.cooldownUntil.delete(account.id); return false }
    return true
  }

  cool(account, ms = 60000, reason = '') {
    this.cooldownUntil.set(account.id, Date.now() + ms)
    this.stats.cooldowns = (this.stats.cooldowns || 0) + 1
    this.logger.log(`[pool] account=${account.id} cooling ${Math.round(ms / 1000)}s (${reason || 'failure'})`)
  }

  clearCool(account) {
    this.cooldownUntil.delete(account.id)
  }

  poolAccounts(pool) {
    return this.config.accounts[pool] || []
  }

  /**
   * Ordered candidates for one request: start at the round-robin position, then
   * walk every other account in the same pool so a dead account never blocks a call.
   * Accounts in cooldown are placed last instead of being removed, so a fully
   * cooling pool still attempts something rather than failing outright.
   */
  candidates(route, { exclude = new Set() } = {}) {
    const pool = route.pool
    const accounts = this.poolAccounts(pool)
    if (!accounts.length) throw new HttpError(503, `${pool} 池暂无账号，请在管理面板「账号池」中添加小艺Work 凭据`, 'account_pool_empty')
    const start = this.cursors[pool]++ % accounts.length
    this.cursors[pool] %= accounts.length
    const ordered = [...accounts.slice(start), ...accounts.slice(0, start)]
    const fresh = ordered.filter((account) => !exclude.has(account.id) && !this.isCooling(account))
    const cooling = ordered.filter((account) => !exclude.has(account.id) && this.isCooling(account))
    return [...fresh, ...cooling]
  }

  select(route) {
    const account = this.candidates(route)[0]
    return { account, pool: route.pool }
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

  /**
   * Seamless failover: try each account in the pool until one succeeds.
   * - 401/403: renew credentials once, then move on if it still fails.
   * - 429: cool the account down, try the next one.
   * - 5xx / network: cool briefly, try the next one.
   * The client sees one request; it never learns an account was swapped.
   */
  async chat(body, route, { signal, configPath = this.configPath, onUsage, onFirstToken, onError } = {}) {
    this.configPath = configPath
    const outgoing = normalizeRequestBody({ ...structuredClone(body), stream: true })
    const outgoingText = JSON.stringify(outgoing)
    if (Buffer.byteLength(outgoingText) > MAX_HAG_BODY_BYTES) {
      throw new HttpError(413, `上游请求体超过 4.5 MiB 限制（${Buffer.byteLength(outgoingText)} B）`, 'upstream_body_too_large')
    }
    const attempted = new Set()
    const failures = []
    let lastError = null

    for (let attempt = 0; attempt < 6; attempt++) {
      const ordered = this.candidates(route, { exclude: attempted })
      if (!ordered.length) break
      const account = ordered[0]
      attempted.add(account.id)
      this.record(route, account)
      const execute = () => this.fetch(this.config.upstreamUrl, {
        method: 'POST',
        headers: authHeaders(account),
        body: outgoingText,
        signal,
      })
      let response
      try {
        response = await execute()
        if ([401, 403].includes(response.status) && account.refreshToken) {
          await response.body?.cancel().catch(() => {})
          try {
            await this.renew(account)
            response = await execute()
          } catch (error) {
            lastError = error
          }
        }
      } catch (error) {
        this.stats.upstreamErrors++
        if (signal?.aborted) throw error
        this.cool(account, 30000, 'network')
        failures.push({ account: account.id, status: 0, reason: error.message })
        lastError = new HttpError(502, `上游连接失败：${error.message}`, 'upstream_unavailable')
        continue
      }

      if (response.ok && response.body) {
        this.clearCool(account)
        this.lastFirstByteAt = Date.now()
        this.stats.failovers = (this.stats.failovers || 0) + (attempt > 0 ? 1 : 0)
        return this.#respond({ response, account, route, pool: route.pool, body, signal, onUsage, onFirstToken, onError })
      }

      this.stats.upstreamErrors++
      const status = response.status
      const text = await response.text().catch(() => '')
      failures.push({ account: account.id, status, reason: text.slice(0, 200) })
      lastError = new HttpError(status, `小艺Work 上游 HTTP ${status}：${text.slice(0, 1000)}`,
        [401, 403].includes(status) ? 'authentication_error' : 'upstream_error')

      if ([401, 403].includes(status)) {
        // Credential is genuinely unusable: keep it out of rotation and try the next account.
        this.cool(account, 300000, `auth ${status}`)
        continue
      }
      if (status === 429) { this.cool(account, 120000, 'rate limit'); continue }
      if (status >= 500) { this.cool(account, 60000, `upstream ${status}`); continue }
      if (status === 400 || status === 404 || status === 413) {
        // Request-shape errors are not account problems: do not retry elsewhere.
        throw lastError
      }
      this.cool(account, 60000, `http ${status}`)
    }

    const detail = failures.length ? `；尝试 ${failures.length} 个账号：${failures.map((f) => `${f.account}(${f.status || 'network'})`).join(', ')}` : ''
    throw lastError
      ? new HttpError(lastError.status || 502, `${lastError.message}${detail}`, lastError.code || 'upstream_error')
      : new HttpError(503, `${route.pool} 池没有可用账号，请检查凭据或在面板重新登录${detail}`, 'account_pool_empty')
  }

  #respond({ response, account, route, pool, body, signal, onUsage, onFirstToken, onError }) {
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
      return new Response(transformSse(response.body, body.model, {
        signal, onUsage, onFirstToken, onError, heartbeatMs: this.config.streamHeartbeatMs || 15000,
      }), { status: 200, headers })
    }
    return aggregateSse(response.body, body.model, { signal, onUsage, onFirstToken }).then((result) => {
      headers.set('content-type', 'application/json; charset=utf-8')
      return new Response(JSON.stringify(result), { status: 200, headers })
    })
  }

  /**
   * Query balance. Each upstream call is isolated: one network blip must not
   * turn the whole endpoint into a 500, and partial results are still useful.
   */
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
      signal: AbortSignal.timeout(20000),
    })

    // Settle each call independently and retry transient failures once.
    const settle = async (agentId) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await query(agentId)
          if ([401, 403].includes(response.status)) {
            await response.body?.cancel().catch(() => {})
            if (!account.refreshToken) {
              return { ok: false, status: response.status, error: `账号 ${account.id} 凭据失效且没有 refreshToken` }
            }
            await this.renew(account)
            continue
          }
          const data = await response.json().catch(() => ({}))
          return { ok: response.ok, status: response.status, data }
        } catch (error) {
          if (attempt === 1) {
            return { ok: false, status: 0, error: `上游连接失败：${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}` }
          }
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
      return { ok: false, status: 0, error: '额度查询重试后仍失败' }
    }

    const [premiumResult, platformResult] = await Promise.all([
      settle('1'), settle('agent208b6760552b4fa0b395e5165d0d771e'),
    ])
    if (!premiumResult.ok && !platformResult.ok) {
      const detail = [premiumResult.error, platformResult.error].filter(Boolean).join('；') ||
        `会员 ${premiumResult.status} / 权益包 ${platformResult.status}`
      throw new HttpError(502, `额度查询失败：${detail}`, 'quota_unavailable')
    }

    const premium = premiumResult.data || {}
    const platform = platformResult.data || {}
    const windows = []
    const points = premium.celiaPremiumPrivilege?.aiPoints || {}
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
    const partial = !premiumResult.ok || !platformResult.ok
    return {
      at: Date.now(), plan: premium.celiaPremiumPrivilege?.membership?.skuGroupName || null, windows,
      ...(partial ? { partial: true, warning: [premiumResult.error, platformResult.error].filter(Boolean).join('；') } : {}),
    }
  }
}
