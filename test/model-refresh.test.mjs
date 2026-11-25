import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createProxyServer } from '../src/server.mjs'
import { ModelCatalog } from '../src/models.mjs'
import { AccountPool } from '../src/pool.mjs'
import { HttpError, modelPolicy, routeGray } from '../src/canary.mjs'

const a = (id, extra = {}) => ({ id, uid: id === 'a' ? '100001' : '100002', credential: `cred-${id}`, deviceId: `device-${id}`, ...extra })
const result = (id = 'Dynamic_Model') => Response.json({ contents: [{ modelList: [{ modelName: 'Dynamic model', modelValue: id, gray: true }] }] })
const config = { grayModels: [], allowGrayModels: false, gray: { enabled: false, percentage: 0, salt: 'test', allowHeaderOverride: false, allowCookieOverride: false, allowlist: [], denylist: [], pool: 'gray', models: [] } }

test('catalogue failure switches HAG accounts before considering web cookies', async () => {
  const calls = []
  const catalog = new ModelCatalog({ fetchImpl: async (url, init) => {
    calls.push({ url, credential: init.headers.businessCredential })
    return init.headers.businessCredential === 'cred-b' ? result() : new Response('', { status: 401 })
  } })
  const status = await catalog.refresh({ force: true, accounts: [a('a'), a('b')] })
  assert.equal(status.ok, true)
  assert.equal(status.transport, 'hag')
  assert.equal(status.sessionConfigured, false)
  assert.deepEqual(calls.map((c) => c.credential), ['cred-a', 'cred-b'])
  assert.ok(calls.every((c) => c.url.includes('user-ability-gallery')))
  assert.equal(catalog.list(config)[0].source, 'upstream')
})

test('catalogue renews rejected credentials once and uses the returned account', async () => {
  const credentials = []
  let renewed = 0
  const catalog = new ModelCatalog({ fetchImpl: async (_url, init) => {
    credentials.push(init.headers.businessCredential)
    return init.headers.businessCredential === 'renewed' ? result() : new Response('', { status: 403 })
  } })
  const status = await catalog.refresh({ force: true, accounts: [a('a', { refreshToken: 'private-refresh' })], renewAccount: async (account) => { renewed++; return { ...account, credential: 'renewed' } } })
  assert.equal(status.ok, true)
  assert.equal(renewed, 1)
  assert.deepEqual(credentials, ['cred-a', 'renewed'])
  assert.doesNotMatch(JSON.stringify(status), /private-refresh|cred-a/)
})

test('empty HAG list is treated as a failed account rather than authoritative success', async () => {
  const calls = []
  const catalog = new ModelCatalog({ fetchImpl: async (_url, init) => {
    calls.push(init.headers.businessCredential)
    return calls.length === 1 ? Response.json({ contents: [] }) : result()
  } })
  const status = await catalog.refresh({ accounts: [a('a'), a('b')] })
  assert.equal(status.ok, true)
  assert.equal(calls.length, 2)
})

test('failed refresh retains the successful cache timestamp and a separate attempt time', async () => {
  let fail = false
  const catalog = new ModelCatalog({ fetchImpl: async () => fail ? new Response('', { status: 503 }) : result() })
  await catalog.refresh({ account: a('a') })
  const success = catalog.publicStatus()
  fail = true
  const failed = await catalog.refresh({ force: true, account: a('a') })
  assert.equal(failed.ok, false)
  assert.equal(failed.source, 'upstream-cache')
  assert.equal(failed.transport, 'hag')
  assert.equal(failed.lastSuccessAt, success.lastSuccessAt)
  assert.equal(failed.refreshedAt, success.refreshedAt)
  assert.ok(Date.parse(failed.lastAttemptAt) >= Date.parse(success.lastSuccessAt))
  assert.doesNotMatch(failed.message, /Cookie|过期|重新授权/)
  assert.equal(catalog.list(config)[0].source, 'upstream-cache')
})

test('upstream rollout metadata cannot be mistaken for local traffic policy', () => {
  const catalog = new ModelCatalog()
  catalog.upstream = [{ id: 'Dynamic_Model', name: 'Dynamic', gray: true }, { id: 'Kimi_K3.1_Pro_VE', name: 'Kimi', gray: false }]
  const models = catalog.list(config)
  const rollout = models.find((m) => m.id === 'Dynamic_Model')
  const kimi = models.find((m) => m.id === 'Kimi_K3.1_Pro_VE')
  assert.equal(rollout.upstreamGray, true)
  assert.equal(rollout.gatewayGray, false)
  assert.equal(rollout.gatewayAllowed, true)
  assert.equal(rollout.gatewayPolicy, 'traffic-split')
  assert.equal(kimi.upstreamGray, false)
  assert.equal(kimi.gatewayGray, true)
  assert.equal(kimi.gatewayAllowed, false)
  assert.deepEqual(modelPolicy(config, kimi.id), { gatewayGray: true, gatewayAllowed: false, gatewayPolicy: 'gray-pool' })
  assert.equal(routeGray({ headers: {} }, config, { model: rollout.id }).pool, 'stable')
  assert.throws(() => routeGray({ headers: {} }, config, { model: kimi.id }), (e) => e.code === 'gray_model_disabled')
})

test('clearing an optional cookie never invalidates a healthy HAG catalogue', async () => {
  const catalog = new ModelCatalog({ fetchImpl: async () => result() })
  catalog.cookie = 'xy_csrf_token=not-returned-to-client'
  catalog.updatedAt = new Date().toISOString()
  await catalog.refresh({ account: a('a') })
  const before = catalog.publicStatus()
  const after = await catalog.clearSession()
  assert.equal(after.ok, true)
  assert.equal(after.source, 'upstream')
  assert.equal(after.transport, 'hag')
  assert.equal(after.sessionConfigured, false)
  assert.equal(after.lastSuccessAt, before.lastSuccessAt)
})

test('invalid Cookie payload is a 400 configuration error', () => {
  const catalog = new ModelCatalog()
  assert.throws(() => catalog.importSession({ cookie: '' }), (e) => e.status === 400 && e.code === 'invalid_catalog_session')
})

test('concurrent renewal updates every waiting caller rather than leaving stale credentials', async () => {
  const original = a('a', { refreshToken: 'private-refresh' })
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  let calls = 0
  const pool = new AccountPool({ upstreamUrl: 'https://hag-drcn.op.dbankcloud.com/chat', accounts: { stable: [original], gray: [] } }, { logger: { log() {} }, fetchImpl: async (url) => {
    calls++
    await barrier
    return url.includes('refresh-token') ? Response.json({ token: 'short-lived' }) : Response.json({ credentialResult: { businessCredential: 'renewed', validTime: 9999999999 } })
  } })
  const copy = { ...original }
  const first = pool.renew(original)
  const second = pool.renew(copy)
  release()
  await Promise.all([first, second])
  assert.equal(calls, 2, 'only one token exchange and one credential issuance')
  assert.equal(original.credential, 'renewed')
  assert.equal(copy.credential, 'renewed')
})

test('a request can time out while the shared renewal continues for other callers', async () => {
  const original = a('a', { refreshToken: 'private-refresh' })
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const pool = new AccountPool({ upstreamUrl: 'https://hag-drcn.op.dbankcloud.com/chat', accounts: { stable: [original], gray: [] } }, { logger: { log() {} }, fetchImpl: async (url) => {
    await barrier
    return url.includes('refresh-token') ? Response.json({ token: 'short-lived' }) : Response.json({ credentialResult: { businessCredential: 'renewed' } })
  } })
  const keep = pool.renew(original)
  const controller = new AbortController()
  const wait = pool.renew({ ...original }, { signal: controller.signal })
  controller.abort(new HttpError(504, '上游请求超时', 'upstream_timeout'))
  await assert.rejects(wait, (error) => error.status === 504)
  release()
  await keep
  assert.equal(original.credential, 'renewed')
})


test('HTTP model listing and routing use the same local restriction after HAG failover', async (t) => {
  const cfg = { ...structuredClone(config), listen: '127.0.0.1', port: 17356,
    apiKey: 'fixture-api-key-123456', adminKey: 'fixture-admin-key-123456',
    upstreamUrl: 'https://hag-drcn.op.dbankcloud.com/celia/v1/sse-api/chat/completions',
    maxBodyBytes: 1048576, requestTimeoutMs: 1000, accountProbeMinutes: 0, modelCatalogMinutes: 0,
    accounts: { gray: [a('a')], stable: [a('b')] },
  }
  const traces = []
  const server = createProxyServer(cfg, { persistConfig: async () => {}, logger: { log(){}, warn(){}, error(){} }, fetchImpl: async (url, init) => {
    if (!url.includes('user-ability-gallery')) return Response.json({})
    traces.push(init.headers.businessCredential)
    if (init.headers.businessCredential === 'cred-a') return new Response('', { status: 401 })
    return Response.json({ contents: [{ modelList: [
      { modelValue: 'Dynamic_Model', modelName: 'Dynamic', gray: true },
      { modelValue: 'Kimi_K3.1_Pro_VE', modelName: 'Kimi', gray: false },
    ] }] })
  } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const admin = { authorization: `Bearer ${cfg.adminKey}`, 'content-type': 'application/json' }
  const refresh = await (await fetch(base + '/api/models/refresh', { method: 'POST', headers: admin, body: '{}' })).json()
  assert.equal(refresh.status.ok, true)
  assert.equal(refresh.status.transport, 'hag')
  assert.ok(traces.includes('cred-a') && traces.includes('cred-b'))
  const listed = await (await fetch(base + '/v1/models', { headers: { authorization: `Bearer ${cfg.apiKey}` } })).json()
  assert.deepEqual(listed.data.map(m => m.id), refresh.models.filter(m => m.gatewayAllowed).map(m => m.id))
  assert.deepEqual(listed.data.map(m => m.id), ['Dynamic_Model'])
  const blocked = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { ...admin, authorization: `Bearer ${cfg.apiKey}` }, body: JSON.stringify({ model: 'Kimi_K3.1_Pro_VE', messages: [] }) })
  assert.equal(blocked.status, 403)
})

test('concurrent session imports are serialized so the newest Cookie wins', async () => {
  let releaseInitial
  const initialBarrier = new Promise(resolve => { releaseInitial = resolve })
  let initial = true
  const seenCookies = []
  const catalog = new ModelCatalog({ fetchImpl: async (url, init = {}) => {
    if (String(url).includes('user-ability-gallery')) {
      if (initial) { initial = false; await initialBarrier }
      return new Response('', { status: 503 })
    }
    if (String(url).endsWith('/chat/')) return new Response('<html></html>', {
      headers: { 'set-cookie': 'xy_csrf_token=csrf; Path=/' },
    })
    const cookie = init.headers?.cookie || ''
    seenCookies.push(cookie)
    const body = JSON.stringify({ contents: [{ modelList: [{ modelValue: 'Session_Model', modelName: cookie.match(/sid=([^;]+)/)?.[1] || 'missing' }] }] })
    return new Response(JSON.stringify({ operationResult: body }), { headers: { 'content-type': 'application/json' } })
  } })
  const initialRefresh = catalog.refresh({ account: a('a') })
  while (!catalog.inflight) await new Promise(resolve => setImmediate(resolve))
  const first = catalog.importSession({ cookie: 'sid=A' })
  const second = catalog.importSession({ cookie: 'sid=B' })
  releaseInitial()
  await initialRefresh
  await Promise.all([first, second])
  assert.equal(catalog.cookie, 'sid=B; xy_csrf_token=csrf')
  assert.equal(seenCookies.length, 2)
  assert.match(seenCookies[0], /sid=A/)
  assert.match(seenCookies[1], /sid=B/)
  assert.equal(catalog.publicStatus().sessionConfigured, true)
})

test('a failed session import does not block later imports or clearing', async () => {
  let fail = true
  const catalog = new ModelCatalog({ fetchImpl: async (url, init = {}) => {
    if (String(url).includes('user-ability-gallery')) return new Response('', { status: 503 })
    if (String(url).endsWith('/chat/')) return new Response('<html></html>', { headers: { 'set-cookie': 'xy_csrf_token=csrf; Path=/' } })
    if (fail) return new Response('', { status: 503 })
    const name = (init.headers?.cookie || '').match(/sid=([^;]+)/)?.[1] || 'missing'
    return Response.json({ operationResult: JSON.stringify({ contents: [{ modelList: [{ modelValue: 'Session_Model', modelName: name }] }] }) })
  } })
  const failed = catalog.importSession({ cookie: 'sid=A' })
  const succeeded = catalog.importSession({ cookie: 'sid=B' })
  assert.equal((await failed).ok, false)
  fail = false
  await succeeded
  assert.equal(catalog.cookie, 'sid=B; xy_csrf_token=csrf')
  await catalog.clearSession()
  assert.equal(catalog.cookie, '')
})

test('clearing web cookies waits for in-flight discovery and leaves them cleared', async () => {
  let resolveFetch
  const catalog = new ModelCatalog({ fetchImpl: async () => new Promise(resolve => { resolveFetch = resolve }) })
  catalog.cookie = 'xy_csrf_token=old'
  const refresh = catalog.refresh({ account: a('a') })
  const cleared = catalog.clearSession()
  resolveFetch(result())
  await refresh
  const status = await cleared
  assert.equal(status.sessionConfigured, false)
  assert.equal(status.transport, 'hag')
  assert.equal(status.ok, true)
})
