import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { createProxyServer } from '../src/server.mjs'

function fixture() {
  return {
    listen: '127.0.0.1', port: 17356,
    upstreamUrl: 'http://127.0.0.1:18085/celia/v1/sse-api/chat/completions',
    apiKey: 'test-proxy-key-123456', adminKey: 'test-admin-key-123456',
    requestTimeoutMs: 10000, maxBodyBytes: 1024 * 1024, allowPanelFromLan: false,
    allowGrayModels: false, grayModels: [],
    gray: { enabled: false, percentage: 0, salt: 'salt', allowHeaderOverride: true, allowCookieOverride: true, allowlist: [], denylist: [], pool: 'gray', models: [], shadow: false },
    accounts: {
      stable: [{ id: 'stable-A', credential: 'credential-12345678', uid: '70086000334832078', deviceId: 'device_70086000334832078' }],
      gray: [{ id: 'gray-A', credential: 'credential-87654321', uid: '70086000334832079', deviceId: 'device_70086000334832079' }],
    },
  }
}

async function upstreamServer() {
  const calls = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    calls.push({ url: request.url, body })
    if (request.url.includes('privilege/query')) {
      const parsed = JSON.parse(body)
      if (parsed.agentId === '1') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ celiaPremiumPrivilege: { membership: { skuGroupName: '体验版' }, aiPoints: { totalPoints: 200 } } }))
      } else {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ privilegeList: [{ privilegeName: '首月权益包', privilegeDetail: ['剩余积分：1000'] }] }))
      }
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":800,"completion_tokens":200,"total_tokens":1000}}\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, calls, port: server.address().port }
}

test('panel auto-loads quota and shows account points', async (t) => {
  const upstream = await upstreamServer()
  const config = fixture()
  config.upstreamUrl = `http://127.0.0.1:${upstream.port}/celia/v1/sse-api/chat/completions`
  const proxy = createProxyServer(config, { persistConfig: async () => {} })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(async () => { proxy.closeAllConnections?.(); await new Promise((r) => proxy.close(r)); upstream.server.closeAllConnections?.(); await new Promise((r) => upstream.server.close(r)) })
  const base = `http://127.0.0.1:${proxy.address().port}`
  const admin = { authorization: `Bearer ${config.adminKey}` }
  const first = await (await fetch(`${base}/api/state`, { headers: admin })).json()
  assert.equal(first.quota.totalAccounts, 2)
  // The first response may be before the async quota refresh completes.
  let state = first
  for (let i = 0; i < 20 && state.quota.accounts < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 60))
    state = await (await fetch(`${base}/api/state`, { headers: admin })).json()
  }
  assert.equal(state.quota.accounts, 2)
  assert.ok(state.quota.points >= 2400, `expected aggregated points, got ${state.quota.points}`)
  assert.ok(state.accounts.every((account) => account.quota && account.quota.windows.length >= 1))
})

test('per-request model points are recorded and exposed', async (t) => {
  const upstream = await upstreamServer()
  const config = fixture()
  config.upstreamUrl = `http://127.0.0.1:${upstream.port}/celia/v1/sse-api/chat/completions`
  const proxy = createProxyServer(config, { persistConfig: async () => {} })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(async () => { proxy.closeAllConnections?.(); await new Promise((r) => proxy.close(r)); upstream.server.closeAllConnections?.(); await new Promise((r) => upstream.server.close(r)) })
  const base = `http://127.0.0.1:${proxy.address().port}`
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'LLM_GLM5.3', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(response.status, 200)
  const state = await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${config.adminKey}` } })).json()
  // Token accounting only; the gateway must not invent a charge.
  assert.equal(state.spend.totalTokens, 1000)
  assert.equal(state.spend.byModel['LLM_GLM5.3'], 1000)
  assert.equal(state.spend.billed, 0)
  const logs = await (await fetch(`${base}/api/logs`, { headers: { authorization: `Bearer ${config.adminKey}` } })).json()
  assert.equal(logs.entries[0].totalTokens, 1000)
  const account = state.accounts.find((item) => item.id === 'stable-A')
  assert.equal(account.spentPoints, undefined, 'no estimated spend exposed')
})

test('quota survives one upstream blip and returns partial data instead of 500', async () => {
  const config = fixture()
  const account = config.accounts.stable[0]
  let calls = 0
  const fetchImpl = async (url, init) => {
    if (!url.includes('privilege/query')) return new Response('{}', { status: 200 })
    calls++
    const body = JSON.parse(init.body)
    // The member-points call fails on the first attempt, succeeds on retry.
    if (body.agentId === '1') {
      if (calls <= 1) throw new TypeError('fetch failed')
      return Response.json({ celiaPremiumPrivilege: { membership: { skuGroupName: '体验版' }, aiPoints: { totalPoints: 200 } } })
    }
    return Response.json({ privilegeList: [] })
  }
  const { AccountPool } = await import('../src/pool.mjs')
  const pool = new AccountPool(config, { fetchImpl, logger: { log() {} } })
  const quota = await pool.quota(account)
  assert.equal(quota.windows[0].remaining, 200)
  assert.ok(calls >= 2, 'retried after the transient error')
})

test('quota reports a clear 502 (not 500) when both upstream calls fail', async () => {
  const config = fixture()
  const account = config.accounts.stable[0]
  const fetchImpl = async (url) => {
    if (!url.includes('privilege/query')) return new Response('{}', { status: 200 })
    throw new TypeError('fetch failed')
  }
  const { AccountPool } = await import('../src/pool.mjs')
  const pool = new AccountPool(config, { fetchImpl, logger: { log() {} } })
  await assert.rejects(() => pool.quota(account), (error) => {
    assert.equal(error.status, 502)
    assert.equal(error.code, 'quota_unavailable')
    assert.match(error.message, /上游连接失败/)
    return true
  })
})

test('quota endpoint returns the upstream reason rather than a generic 500', async (t) => {
  const { createProxyServer } = await import('../src/server.mjs')
  const { once } = await import('node:events')
  const config = fixture()
  const fetchImpl = async (url) => {
    if (!url.includes('privilege/query')) return new Response('{}', { status: 200 })
    throw new TypeError('fetch failed')
  }
  const server = createProxyServer(config, { fetchImpl, persistConfig: async () => {} })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const res = await fetch(`${base}/api/accounts/stable-A/quota`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.adminKey}`, 'content-type': 'application/json' },
    body: '{}',
  })
  const body = await res.json()
  assert.equal(res.status, 502)
  assert.notEqual(body.error.type, 'server_error')
  assert.match(body.error.message, /额度查询失败|上游连接失败/)
})
