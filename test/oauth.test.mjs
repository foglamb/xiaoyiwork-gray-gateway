import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createProxyServer } from '../src/server.mjs'
import { OAuthManager, OAUTH, oauthCallbackHtml } from '../src/oauth.mjs'

function fixture() {
  return {
    listen: '127.0.0.1', port: 17356,
    upstreamUrl: 'https://hag-drcn.op.dbankcloud.com/celia/v1/sse-api/chat/completions',
    apiKey: 'test-proxy-key-123456', adminKey: 'test-admin-key-123456',
    requestTimeoutMs: 10000, maxBodyBytes: 1024 * 1024, allowPanelFromLan: false,
    allowGrayModels: false, grayModels: [],
    gray: { enabled: false, percentage: 0, salt: 'salt', allowHeaderOverride: true, allowCookieOverride: true, allowlist: [], denylist: [], pool: 'gray', models: [], shadow: false },
    accounts: { stable: [], gray: [] },
  }
}

/** Fake OAuth + credential exchange; never contacts Huawei. */
function fakeOauthFetch(uid = '70086000334832078') {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (url === OAUTH.tokenUrl) {
      const idToken = `x.${Buffer.from(JSON.stringify({ uid, display_name: '测试账号' })).toString('base64url')}.y`
      return Response.json({ access_token: 'access-token', refresh_token: 'refresh-token', id_token: idToken, expires_in: 3600 })
    }
    if (url.endsWith('/user-credential/v1/business-credential/create')) {
      const body = JSON.parse(init.body)
      return Response.json({ credentialResult: { businessCredential: `credential-${body.deviceId}`, validTime: 1893456000 } })
    }
    throw new Error(`unexpected upstream ${url}`)
  }
  return { fetchImpl, calls }
}

async function launch(t, { config = fixture(), oauthManager } = {}) {
  const server = createProxyServer(config, { persistConfig: async () => {}, oauthManager, fetchImpl: async () => new Response('', { status: 503 }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)) })
  return { base: `http://127.0.0.1:${server.address().port}`, admin: { authorization: `Bearer ${config.adminKey}`, 'content-type': 'application/json' }, config }
}

function managerWith(fetchImpl) {
  return new OAuthManager({ fetchImpl })
}

test('oauth start builds PKCE URL and never returns credentials', async (t) => {
  const { base, admin } = await launch(t, { oauthManager: managerWith(fakeOauthFetch().fetchImpl) })
  const response = await fetch(`${base}/api/auth/oauth/start`, { method: 'POST', headers: admin, body: JSON.stringify({ pool: 'stable' }) })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.match(body.url, /^https:\/\/oauth-login\.cloud\.huawei\.com\/oauth2\/v3\/authorize\?/)
  const url = new URL(body.url)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('redirect_uri'), OAUTH.redirectUri)
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.ok(url.searchParams.get('state'))
  assert.ok(url.searchParams.get('code_challenge'))
  assert.doesNotMatch(JSON.stringify(body), /credential|refresh-token|access-token/)
})

test('oauth rejects a callback whose state does not match the session', async (t) => {
  const { base, admin } = await launch(t, { oauthManager: managerWith(fakeOauthFetch().fetchImpl) })
  const started = await (await fetch(`${base}/api/auth/oauth/start`, { method: 'POST', headers: admin, body: '{"pool":"gray"}' })).json()
  const forged = `http://127.0.0.1:17355/auth/callback?code=abc&state=not-${started.state}`
  const response = await fetch(`${base}/api/auth/oauth/complete`, { method: 'POST', headers: admin, body: JSON.stringify({ state: started.state, callbackUrl: forged }) })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.type, 'oauth_state_mismatch')
})

test('oauth rejects non-callback URLs and missing codes', async (t) => {
  const { base, admin } = await launch(t, { oauthManager: managerWith(fakeOauthFetch().fetchImpl) })
  const started = await (await fetch(`${base}/api/auth/oauth/start`, { method: 'POST', headers: admin, body: '{"pool":"stable"}' })).json()
  for (const callbackUrl of ['https://evil.example/auth/callback?code=1&state=' + started.state, `http://127.0.0.1:17355/other?code=1&state=${started.state}`, `http://127.0.0.1:17355/auth/callback?state=${started.state}`]) {
    const response = await fetch(`${base}/api/auth/oauth/complete`, { method: 'POST', headers: admin, body: JSON.stringify({ state: started.state, callbackUrl }) })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.type, 'oauth_callback_invalid')
  }
})

test('oauth callback completes and the account is stored with its device binding', async (t) => {
  const { fetchImpl, calls } = fakeOauthFetch('70086000334832078')
  const cfg = fixture()
  const { base, admin } = await launch(t, { config: cfg, oauthManager: managerWith(fetchImpl) })
  const started = await (await fetch(`${base}/api/auth/oauth/start`, { method: 'POST', headers: admin, body: '{"pool":"stable"}' })).json()
  const callback = `http://127.0.0.1:17355/auth/callback?code=auth-code-1&state=${started.state}`
  const complete = await fetch(`${base}/api/auth/oauth/complete`, { method: 'POST', headers: admin, body: JSON.stringify({ state: started.state, callbackUrl: callback }) })
  assert.equal(complete.status, 200)
  assert.equal((await complete.json()).status, 'success')
  const statusResponse = await fetch(`${base}/api/auth/oauth/status?state=${started.state}`, { headers: admin })
  const status = await statusResponse.json()
  assert.equal(status.status, 'success')
  assert.equal(status.account.uid, '70086000334832078')
  assert.equal(status.account.hasRefreshToken, true)
  const stateResponse = await (await fetch(`${base}/api/state`, { headers: admin })).json()
  const stored = stateResponse.accounts.find((item) => item.pool === 'stable')
  assert.ok(stored, 'account persisted to stable pool')
  assert.match(stored.uid, /70086000334832078$/)
  assert.ok(calls.some((call) => call.url === OAUTH.tokenUrl))
  assert.ok(calls.some((call) => call.url.endsWith('/business-credential/create')))
  const reused = await fetch(`${base}/api/auth/oauth/status?state=${started.state}`, { headers: admin })
  assert.equal(reused.status, 404, 'session is single-use')
})

test('repeated OAuth login for the same uid replaces the saved credential', async (t) => {
  const { base, admin } = await launch(t, { oauthManager: managerWith(fakeOauthFetch().fetchImpl) })
  async function login() {
    const started = await (await fetch(`${base}/api/auth/oauth/start`, { method: 'POST', headers: admin, body: '{"pool":"stable"}' })).json()
    const callback = `http://127.0.0.1:17355/auth/callback?code=auth-code-1&state=${started.state}`
    await fetch(`${base}/api/auth/oauth/complete`, { method: 'POST', headers: admin, body: JSON.stringify({ state: started.state, callbackUrl: callback }) })
    const response = await fetch(`${base}/api/auth/oauth/status?state=${started.state}`, { headers: admin })
    assert.equal(response.status, 200)
    return response.json()
  }
  const first = await login()
  const second = await login()
  assert.equal(first.account.replaced, false)
  assert.equal(second.account.replaced, true)
  assert.equal(second.account.id, first.account.id)
  const state = await (await fetch(`${base}/api/state`, { headers: admin })).json()
  assert.equal(state.accounts.filter((item) => item.pool === 'stable').length, 1)
})

test('manual interface credentials are rejected; only login state import is allowed', async (t) => {
  const { base, admin } = await launch(t, { oauthManager: managerWith(fakeOauthFetch().fetchImpl) })
  const manual = await fetch(`${base}/api/accounts`, { method: 'POST', headers: admin, body: JSON.stringify({ pool: 'stable', credential: 'x', uid: '123456', deviceId: 'device-1' }) })
  assert.equal(manual.status, 400)
  const plain = await fetch(`${base}/api/auth/import`, { method: 'POST', headers: admin, body: JSON.stringify({ pool: 'stable', text: 'just-a-token' }) })
  assert.equal(plain.status, 400)
  assert.equal((await plain.json()).error.type, 'invalid_import')
  const imported = await fetch(`${base}/api/auth/import`, { method: 'POST', headers: admin, body: JSON.stringify({ pool: 'gray', text: JSON.stringify({ credential: 'credential-from-magpie', uid: '70086000334832078', deviceId: 'registered-device_70086000334832078', refreshToken: 'rt' }) }) })
  assert.equal(imported.status, 201)
  const body = await imported.json()
  assert.equal(body.account.pool, 'gray')
  assert.equal(body.account.hasRefreshToken, true)
})

test('oauth state expires and duplicate uid is refused across pools', async (t) => {
  const { fetchImpl } = fakeOauthFetch('70086000334832078')
  const oauth = new OAuthManager({ fetchImpl })
  const session = oauth.begin({ pool: 'stable' })
  session.createdAt = 0
  // Re-create with an old timestamp to exercise the TTL path.
  const old = oauth.begin({ pool: 'stable' })
  const stored = oauth.sessions.get(old.state)
  stored.createdAt = Date.now() - 6 * 60 * 1000
  assert.throws(() => oauth.status(old.state), /过期/)

  const { base, admin } = await launch(t, { oauthManager: managerWith(fetchImpl) })
  const first = await (await fetch(`${base}/api/auth/oauth/start`, { method: 'POST', headers: admin, body: '{"pool":"stable"}' })).json()
  await fetch(`${base}/api/auth/oauth/complete`, { method: 'POST', headers: admin, body: JSON.stringify({ state: first.state, callbackUrl: `http://127.0.0.1:17355/auth/callback?code=c1&state=${first.state}` }) })
  await fetch(`${base}/api/auth/oauth/status?state=${first.state}`, { headers: admin })
  const second = await (await fetch(`${base}/api/auth/oauth/start`, { method: 'POST', headers: admin, body: '{"pool":"gray"}' })).json()
  await fetch(`${base}/api/auth/oauth/complete`, { method: 'POST', headers: admin, body: JSON.stringify({ state: second.state, callbackUrl: `http://127.0.0.1:17355/auth/callback?code=c2&state=${second.state}` }) })
  const conflict = await fetch(`${base}/api/auth/oauth/status?state=${second.state}`, { headers: admin })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error.type, 'duplicate_uid')
})

test('callback page escapes error text', () => {
  const html = oauthCallbackHtml(false, '<script>alert(1)</script>')
  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /&lt;script&gt;/)
})

test('manual callback UI sends callbackUrl/state and then saves through status polling', async () => {
  const source = await readFile(new URL('../panel-ui/src/components/LoginDialog.vue', import.meta.url), 'utf8')
  assert.match(source, /body: \{ state: session\.value\?\.state, callbackUrl: value \}/)
  assert.doesNotMatch(source, /JSON\.stringify\(\{ url: value \}\)/)
  assert.match(source, /if \(result\.status === 'success'\) \{[\s\S]*?await poll\(\)/)
})
