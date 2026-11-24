import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProxyServer } from '../src/server.mjs'
import { panelAuthorized } from '../src/network.mjs'

function fixture() {
  return {
    listen: '127.0.0.1', port: 17356,
    upstreamUrl: 'https://hag-drcn.op.dbankcloud.com/celia/v1/sse-api/chat/completions',
    apiKey: 'test-proxy-key-123456', adminKey: 'test-admin-key-123456',
    requestTimeoutMs: 10000, maxBodyBytes: 1024 * 1024, allowPanelFromLan: false,
    allowGrayModels: false, grayModels: ['Kimi_K3.1_Pro_VE'],
    gray: { enabled: true, percentage: 10, salt: 'test-salt', allowHeaderOverride: true, allowCookieOverride: true, allowlist: [], denylist: [], pool: 'gray', models: ['Kimi_K3.1_Pro_VE'], shadow: false },
    accounts: {
      stable: [{ id: 'stable-A', credential: 'credential-stable', uid: '10001', deviceId: 'device-stable' }],
      gray: [{ id: 'gray-A', credential: 'credential-gray', uid: '10002', deviceId: 'device-gray', refreshToken: 'refresh-gray' }],
    },
  }
}

async function launch(t, { config = fixture(), persistConfig = async () => {} } = {}) {
  const server = createProxyServer(config, { persistConfig })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  const admin = { authorization: `Bearer ${config.adminKey}` }
  return { server, base, admin, config }
}

const jsonHeaders = (headers) => ({ ...headers, 'content-type': 'application/json' })

test('panel serves HTML, external CSS/JS, CSP and authentication state', async (t) => {
  const { base, admin } = await launch(t)
  const page = await fetch(`${base}/`)
  const html = await page.text()
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/)
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/)
  assert.match(html, /小艺Work 灰度网关/)
  // Vue build: external module entry plus stylesheet, no inline script.
  assert.match(html, /src="\/app\.js"/)
  assert.match(html, /href="\/app\.css"/)
  assert.doesNotMatch(html, /<script>\s*[\s\S]*?const/)
  assert.doesNotMatch(html, /<style/)
  assert.equal((await fetch(`${base}/app.css`)).headers.get('content-type'), 'text/css; charset=utf-8')
  const bundle = await fetch(`${base}/app.js`)
  assert.equal(bundle.status, 200)
  assert.equal(bundle.headers.get('content-type'), 'text/javascript; charset=utf-8')
  const source = await bundle.text()
  assert.ok(source.length > 10000, 'bundle is a real build')
  // CSP stays strict: no eval/new Function in the shipped bundle.
  assert.doesNotMatch(source, /\bnew Function\s*\(/)
  const anonymous = await (await fetch(`${base}/api/session`)).json()
  assert.equal(anonymous.authenticated, false)
  assert.equal((await fetch(`${base}/api/session`, { headers: admin })).status, 200)
  assert.equal((await fetch(`${base}/api/state`)).status, 401)
})

test('state exposes account pool metadata and model information without secrets', async (t) => {
  const { base, admin } = await launch(t)
  const response = await fetch(`${base}/api/state`, { headers: admin })
  const data = await response.json()
  assert.equal(data.accounts.length, 2)
  assert.equal(data.models.length, 8)
  assert.equal(data.models.find((model) => model.id === 'Kimi_K3.1_Pro_VE').rate, '13x')
  assert.equal(data.models.find((model) => model.id === 'Kimi_K3.1_Pro_VE').gray, true)
  assert.equal(data.accounts.find((account) => account.id === 'gray-A').hasRefreshToken, true)
  assert.ok(data.endpoint.baseUrl.endsWith('/v1'))
  assert.doesNotMatch(JSON.stringify(data), /credential-(stable|gray)|refresh-gray|test-admin-key|test-proxy-key/)
})

test('account add/delete persists credentials server-side and prevents empty pools', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyi-panel-test-'))
  const configPath = join(directory, 'config.json')
  const config = fixture()
  const server = createProxyServer(config, { configPath })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = jsonHeaders({ 'x-admin-key': config.adminKey })
  const added = await fetch(`${base}/api/accounts`, {
    method: 'POST', headers,
    body: JSON.stringify({ pool: 'gray', id: 'gray-B', credential: 'second-credential-value', uid: '100003', deviceId: 'second-device_100003', refreshToken: 'second-refresh' }),
  })
  assert.equal(added.status, 201)
  const stored = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(stored.accounts.gray.length, 2)
  assert.equal(stored.accounts.gray[1].credential, 'second-credential-value')
  const duplicate = await fetch(`${base}/api/accounts`, { method: 'POST', headers, body: JSON.stringify({ pool: 'gray', id: 'gray-B', credential: 'another-credential', uid: '100004', deviceId: 'device_100004' }) })
  assert.equal(duplicate.status, 409)
  const removed = await fetch(`${base}/api/accounts/gray-B`, { method: 'DELETE', headers })
  assert.equal(removed.status, 200)
  const last = await fetch(`${base}/api/accounts/gray-A`, { method: 'DELETE', headers })
  assert.equal(last.status, 409)
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).accounts.gray.length, 1)
})

test('quota UI endpoint calls both billing APIs and returns only parsed quota', async (t) => {
  const urls = []
  const fetchImpl = async (url, init) => {
    urls.push({ url, init })
    if (init.headers['x-uid'] !== '10001') return new Response('{}', { status: 403 })
    const body = JSON.parse(init.body)
    if (body.agentId === '1') return Response.json({ celiaPremiumPrivilege: { membership: { skuGroupName: '体验版' }, aiPoints: { totalPoints: 200 } } })
    return Response.json({ privilegeList: [{ privilegeName: '首月权益包', privilegeDetail: ['剩余积分：1000'], expireTime: '20261216235959' }] })
  }
  const config = fixture()
  const server = createProxyServer(config, { fetchImpl, persistConfig: async () => {} })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const result = await fetch(`${base}/api/accounts/stable-A/quota`, { method: 'POST', headers: jsonHeaders({ authorization: `Bearer ${config.adminKey}` }), body: '{}' })
  assert.equal(result.status, 200)
  const data = await result.json()
  assert.equal(data.quota.plan, '体验版')
  assert.equal(data.quota.windows[0].remaining, 200)
  assert.equal(data.quota.windows[1].remaining, 1000)
  assert.equal(urls.length, 2)
  assert.ok(urls.every((entry) => entry.init.headers['x-prd-pkg-name'] === 'com.huawei.hmos.vassistant'))
})

test('request log records route, duration, tokens but no prompts or credentials', async (t) => {
  const { admin, config } = await launch(t)
  const fetchImpl = async () => new Response('data: {"choices":[{"delta":{"content":"private answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n', { status: 200 })
  // Use a separate server to inject the fetch transport.
  const injected = createProxyServer(config, { fetchImpl, persistConfig: async () => {} })
  injected.listen(0, '127.0.0.1')
  await once(injected, 'listening')
  t.after(async () => { injected.closeAllConnections?.(); await new Promise((resolve) => injected.close(resolve)) })
  const injectedBase = `http://127.0.0.1:${injected.address().port}`
  const chat = await fetch(`${injectedBase}/v1/chat/completions`, {
    method: 'POST', headers: jsonHeaders({ authorization: `Bearer ${config.apiKey}` }),
    body: JSON.stringify({ model: 'LLM_DeepSeekV4_Think', stream: false, messages: [{ role: 'user', content: 'private prompt' }] }),
  })
  assert.equal(chat.status, 200)
  const logs = await (await fetch(`${injectedBase}/api/logs`, { headers: admin })).json()
  assert.equal(logs.entries.length, 1)
  assert.equal(logs.entries[0].totalTokens, 16)
  assert.equal(logs.entries[0].accountId, 'stable-A')
  assert.equal(logs.entries[0].status, 200)
  assert.doesNotMatch(JSON.stringify(logs), /private prompt|private answer|credential-stable/)
  const cleared = await fetch(`${injectedBase}/api/logs/clear`, { method: 'POST', headers: admin, body: '{}' })
  assert.equal(cleared.status, 200)
  assert.equal((await (await fetch(`${injectedBase}/api/logs`, { headers: admin })).json()).entries.length, 0)
})

test('remote panel data requires explicit allowPanelFromLan even with spoofed forwarding headers', () => {
  const request = { socket: { remoteAddress: '192.168.1.100' }, headers: { 'x-forwarded-for': '127.0.0.1' } }
  assert.equal(panelAuthorized(request, {}), false)
  assert.equal(panelAuthorized(request, { allowPanelFromLan: true }), true)
  assert.equal(panelAuthorized({ socket: { remoteAddress: '::ffff:127.0.0.1' } }, {}), true)
})

test('chart hover uses a frozen snapshot and cannot index live data', async () => {
  const source = await readFile(new URL('../panel-ui/src/components/LineChart.vue', import.meta.url), 'utf8')
  // Reading point values straight off the reactive data during render is what
  // threw after polling replaced the array, unmounting the whole chart.
  assert.doesNotMatch(source, /hover\.point\[/)
  assert.doesNotMatch(source, /hover\.point\./)
  // The snapshot carries precomputed series values instead.
  assert.match(source, /values:\s*props\.series\.map/)
  assert.match(source, /function hoverY/)
  // Width is a computed ref now, so every use must read .value.
  assert.doesNotMatch(source, /\*\s*W\b(?!\.value)/)
})
