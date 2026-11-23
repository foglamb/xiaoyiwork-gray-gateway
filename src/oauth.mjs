import { createHash, randomBytes } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { HttpError } from './canary.mjs'

export const OAUTH = Object.freeze({
  authorizeUrl: 'https://oauth-login.cloud.huawei.com/oauth2/v3/authorize',
  tokenUrl: 'https://oauth-login.cloud.huawei.com/oauth2/v3/token',
  clientId: '6917612679526496902',
  redirectUri: 'http://127.0.0.1:17355/auth/callback',
  scope: 'openid profile https://www.huawei.com/auth/drive https://www.huawei.com/auth/drive.xiaoyiwork',
  callbackPort: 17355,
  ttlMs: 5 * 60 * 1000,
})

const b64url = (value) => Buffer.from(value).toString('base64url')

/** The upstream expects a device already registered to this uid, not an invented id. */
export function localDeviceId(uid) {
  const source = process.platform === 'win32' ? windowsMachineGuid() : `${hostname()}|${userInfo().username}`
  return `${createHash('sha256').update(source).digest('hex').toLowerCase()}_${uid}`
}

function windowsMachineGuid() {
  // Synchronous Windows registry discovery is only needed on a Windows gateway.
  // Linux/macOS users can enter an existing registered device in the login dialog.
  for (const key of ['HKLM\\SOFTWARE\\Microsoft\\Cryptography', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Cryptography']) {
    try {
      const output = execFileSync('reg.exe', ['query', key, '/v', 'MachineGuid'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/)
      if (match?.[1]?.trim()) return match[1].trim()
    } catch { /* Try the next registry view. */ }
  }
  return `${hostname()}|${userInfo().username}`
}

export class OAuthManager {
  constructor({ fetchImpl = fetch, upstreamOrigin = null, logger = console, listen = '127.0.0.1' } = {}) {
    this.fetch = fetchImpl
    this.upstreamOrigin = upstreamOrigin
    this.logger = logger
    this.listen = listen
    this.sessions = new Map()
    this.callbackServer = null
  }

  begin({ pool, label = '', deviceId = '' }) {
    this.prune()
    if (!['stable', 'gray'].includes(pool)) throw new HttpError(400, '请选择稳定池或灰度池')
    if (this.sessions.size >= 5) throw new HttpError(429, '已有多个登录流程，请完成或取消后重试', 'oauth_busy')
    const verifier = b64url(randomBytes(32))
    const state = b64url(randomBytes(32))
    const session = {
      state, verifier, pool, label: String(label).trim().slice(0, 48), deviceId: String(deviceId).trim(),
      createdAt: Date.now(), status: 'pending', error: '', code: null,
    }
    this.sessions.set(state, session)
    const query = new URLSearchParams({
      response_type: 'code', access_type: 'offline', client_id: OAUTH.clientId,
      redirect_uri: OAUTH.redirectUri, scope: OAUTH.scope,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256', state, display: 'page',
    })
    return { state, url: `${OAUTH.authorizeUrl}?${query}`, redirectUri: OAUTH.redirectUri, expiresAt: session.createdAt + OAUTH.ttlMs }
  }

  status(state) {
    const session = this.get(state)
    return {
      state: session.state, status: session.status, error: session.error, pool: session.pool,
      expiresAt: session.createdAt + OAUTH.ttlMs,
      account: session.status === 'success' ? session.account : undefined,
    }
  }

  cancel(state) {
    const session = this.get(state)
    if (session.status === 'pending') session.status = 'cancelled'
    this.sessions.delete(state)
  }

  /** Accept only the exact registered callback URL; code and state never go to logs. */
  async receiveCallback(url) {
    if (url.origin !== 'http://127.0.0.1:17355' || url.pathname !== '/auth/callback') throw new HttpError(400, 'OAuth 回调地址不正确', 'oauth_callback_invalid')
    const state = url.searchParams.get('state') || ''
    const session = this.get(state)
    if (session.status !== 'pending') throw new HttpError(409, '该登录流程已处理或已取消', 'oauth_already_processed')
    const error = url.searchParams.get('error')
    if (error) {
      session.status = 'failed'
      session.error = `华为授权失败：${error}`
      throw new HttpError(400, session.error, 'oauth_denied')
    }
    const code = url.searchParams.get('code')
    if (!code) throw new HttpError(400, '回调缺少 code', 'oauth_callback_invalid')
    await this.#exchange(session, code)
    return this.status(state)
  }

  async complete(state, code) {
    const session = this.get(state)
    if (session.status !== 'pending') throw new HttpError(409, '该登录流程已处理或已取消', 'oauth_already_processed')
    if (!code || typeof code !== 'string' || code.length > 4096) throw new HttpError(400, '回调 code 无效', 'oauth_callback_invalid')
    return this.#exchange(session, code)
  }

  async #exchange(session, code) {
    session.status = 'exchanging'
    try {
      const tokenResponse = await this.fetch(OAUTH.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, client_id: OAUTH.clientId,
          code_verifier: session.verifier, redirect_uri: OAUTH.redirectUri,
        }),
        signal: AbortSignal.timeout(30000),
      })
      const token = await parseResponse(tokenResponse)
      if (!tokenResponse.ok || !token.access_token) throw new Error(`换取访问令牌失败（HTTP ${tokenResponse.status}）：${token.error_description || token.message || '无 access_token'}`)
      const claims = decodeIdToken(token.id_token)
      if (!claims.uid) throw new Error('华为账号信息中没有 uid，无法绑定小艺账号')
      const deviceId = session.deviceId || localDeviceId(claims.uid)
      if (!/^[A-Za-z0-9_.:-]{8,512}$/.test(deviceId)) throw new Error('Device ID 格式无效')
      const base = this.upstreamOrigin || 'https://hag-drcn.op.dbankcloud.com'
      const credentialResponse = await this.fetch(`${base}/user-credential/v1/business-credential/create`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: 'application/json',
          authorization: `Bearer ${token.access_token}`, 'x-uid': String(claims.uid),
          'x-client-version': '1.0.0', 'x-hag-trace-id': `xy-${randomBytes(8).toString('hex')}`,
        },
        body: JSON.stringify({
          deviceId, uid: String(claims.uid), clientId: OAUTH.clientId,
          sysVer: '5.0.0', version: '1.0.0', ts: String(Date.now()),
        }),
        signal: AbortSignal.timeout(30000),
      })
      const created = await parseResponse(credentialResponse)
      const credential = created.credentialResult?.businessCredential || created.credentialResult?.credential || created.data?.businessCredential || created.data?.credential || created.businessCredential || created.credential
      if (!credentialResponse.ok || !credential) {
        const message = created.desc || created.message || '签票失败'
        if (/clientId|device|设备/i.test(message)) throw new Error(`${message}。当前设备可能未登记：请先在 Windows 小艺Work 登录此账号，登录窗口中填写那台设备已登记的 Device ID，或导入已有登录态。`)
        throw new Error(`签发小艺凭据失败（HTTP ${credentialResponse.status}）：${message}`)
      }
      session.account = {
        id: accountId(session.pool, claims.uid),
        credential, uid: String(claims.uid), deviceId,
        refreshToken: token.refresh_token || undefined,
        validTimeSec: created.credentialResult?.validTime || created.data?.validTime || created.validTime || Math.floor(Date.now() / 1000) + 7 * 86400,
        displayName: claims.display_name || claims.nickname || session.label || null,
        source: 'oauth',
      }
      session.status = 'success'
      session.code = null
      session.verifier = ''
      return { ...this.status(session.state), account: session.account }
    } catch (error) {
      session.status = 'failed'
      session.error = error.message
      throw new HttpError(502, error.message, 'oauth_exchange_failed')
    }
  }

  consume(state) {
    const session = this.get(state)
    if (session.status !== 'success' || !session.account) throw new HttpError(409, '账号授权尚未完成', 'oauth_not_ready')
    this.sessions.delete(state)
    return session
  }

  get(state) {
    const session = this.sessions.get(state)
    if (!session) throw new HttpError(404, '登录流程不存在或已过期，请重新发起', 'oauth_session_not_found')
    if (Date.now() - session.createdAt > OAUTH.ttlMs && session.status === 'pending') {
      this.sessions.delete(state)
      throw new HttpError(410, '登录流程已过期，请重新发起', 'oauth_expired')
    }
    return session
  }

  prune() {
    const now = Date.now()
    for (const [state, session] of this.sessions) if (now - session.createdAt > OAUTH.ttlMs) this.sessions.delete(state)
    if (!this.sessions.size) this.stopCallbackServer()
  }

  async startCallbackServer() {
    if (this.callbackServer) return
    const server = http.createServer(async (request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.setHeader('x-content-type-options', 'nosniff')
      response.setHeader('referrer-policy', 'no-referrer')
      try {
        const url = new URL(request.url || '/', OAUTH.redirectUri)
        await this.receiveCallback(url)
        response.writeHead(200).end(oauthCallbackHtml(true, '已验证 OAuth state 并完成账号授权。账号正在加入网关。'))
      } catch (error) {
        response.writeHead(error.status || 500).end(oauthCallbackHtml(false, error.message))
      }
    })
    server.on('connection', (socket) => {
      socket.setTimeout(10000)
      socket.unref()
    })
    server.unref()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(OAUTH.callbackPort, this.listen, resolve)
    }).catch((error) => {
      try { server.close() } catch { /* not listening */ }
      if (error.code === 'EADDRINUSE') return false
      throw error
    })
    this.callbackServer = server
    return true
  }

  stopCallbackServer() {
    if (!this.callbackServer) return
    const server = this.callbackServer
    this.callbackServer = null
    server.closeAllConnections?.()
    server.close()
  }

  async close() {
    this.stopCallbackServer()
    this.sessions.clear()
  }
}

async function parseResponse(response) {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return { message: text.slice(0, 300) } }
}

function decodeIdToken(token = '') {
  try {
    const payload = String(token).split('.')[1]
    return payload ? JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) : {}
  } catch { return {} }
}

function accountId(pool, uid) {
  return `${pool}-${String(uid).slice(-6)}`
}

export function oauthCallbackHtml(success, message) {
  const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>小艺账号登录</title><body style="font:16px/1.8 system-ui;background:#0b1017;color:#e9edf4;display:grid;place-items:center;min-height:90vh;margin:0"><main style="max-width:540px;padding:36px"><h1>${success ? '✓ 华为账号授权完成' : '授权未完成'}</h1><p style="color:#9baac0">${escape(message)}</p><p>可以关闭此页面，返回小艺Work 灰度网关。</p></main></body></html>`
}
