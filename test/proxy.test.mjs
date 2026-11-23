import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProxyServer } from '../src/server.mjs'
import { bucketFor, parseCookies, routeGray } from '../src/canary.mjs'
import { aggregateSse, transformSse } from '../src/upstream.mjs'

const CHAT = '/celia/v1/sse-api/chat/completions'
const encoder = new TextEncoder()
const config = () => ({
  listen: '127.0.0.1', port: 17356,
  upstreamUrl: `http://127.0.0.1:18081${CHAT}`,
  apiKey: 'test-proxy-key-123456', adminKey: 'test-admin-key-123456',
  requestTimeoutMs: 10000, maxBodyBytes: 1024 * 1024,
  allowGrayModels: false, grayModels: ['Kimi_K3.1_Pro_VE'],
  gray: {
    enabled: true, percentage: 10, salt: 'fixed-test-salt',
    allowHeaderOverride: true, allowCookieOverride: true,
    allowlist: [], denylist: [], pool: 'gray',
    models: ['Kimi_K3.1_Pro_VE'], shadow: false,
  },
  accounts: {
    stable: [{ id: 'stable-A', credential: 'stable-token', uid: 'stable-uid', deviceId: 'stable-device' }],
    gray: [{ id: 'gray-A', credential: 'gray-token', uid: 'gray-uid', deviceId: 'gray-device' }],
  },
})

function request(headers = {}) {
  return { headers: { authorization: 'Bearer test-user', ...headers } }
}

function sseResponse(events) {
  return new Response(events.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function event(content, finish = null) {
  return `id: 42\ndata: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`
}

async function startUpstream(handler) {
  const { createServer } = await import('node:http')
  const seen = []
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    seen.push({ url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null })
    await handler(req, res, seen.at(-1))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, seen, port: server.address().port }
}

async function startProxy(options) {
  const server = createProxyServer(options.config, options)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: server.address().port }
}

async function stop(server) {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

test('cookie parsing and stable hash buckets', () => {
  assert.deepEqual({ ...parseCookies('a=1; xiaoyi_gray=true; encoded=a%20b') }, { a: '1', xiaoyi_gray: 'true', encoded: 'a b' })
  assert.equal(bucketFor('user-A', 'salt'), bucketFor('user-A', 'salt'))
  assert.ok(bucketFor('user-A', 'salt') >= 0 && bucketFor('user-A', 'salt') < 10000)
  assert.equal(routeGray(request(), { ...config(), gray: { ...config().gray, percentage: 100 } }).selected, true)
  assert.equal(routeGray(request(), { ...config(), gray: { ...config().gray, percentage: 0 } }).selected, false)
})

test('routing precedence: disabled, denylist, allowlist, header, cookie, percentage', () => {
  const cfg = config()
  assert.equal(routeGray(request(), { ...cfg, gray: { ...cfg.gray, enabled: false, percentage: 100 } }).reason, 'disabled')
  assert.equal(routeGray(request({ 'x-gray-key': 'denied', 'x-gray-force': '1' }), { ...cfg, gray: { ...cfg.gray, denylist: ['denied'] } }).selected, false)
  assert.equal(routeGray(request({ 'x-gray-key': 'allowed' }), { ...cfg, gray: { ...cfg.gray, allowlist: ['allowed'], percentage: 0 } }).selected, true)
  assert.equal(routeGray(request({ 'x-gray-force': '1', cookie: 'xiaoyi_gray=0' }), cfg).reason, 'header')
  assert.equal(routeGray(request({ 'x-gray-force': '0', cookie: 'xiaoyi_gray=1' }), cfg).selected, false)
  assert.equal(routeGray(request({ cookie: 'xiaoyi_gray=1' }), { ...cfg, gray: { ...cfg.gray, percentage: 0 } }).selected, true)
  assert.throws(() => routeGray(request({ 'x-gray-force': '1' }), { ...cfg, gray: { ...cfg.gray, allowHeaderOverride: false } }), /禁用/)
})

test('gray model is deny-by-default and routes to gray pool when enabled', () => {
  const cfg = config()
  assert.throws(() => routeGray(request(), cfg, { model: 'Kimi_K3.1_Pro_VE' }), /默认禁用/)
  const route = routeGray(request(), { ...cfg, allowGrayModels: true }, { model: 'Kimi_K3.1_Pro_VE' })
  assert.equal(route.selected, true)
  assert.equal(route.reason, 'gray-model')
  assert.equal(route.pool, 'gray')
})

test('SSE split boundaries normalize chunks, preserve comments and add one [DONE]', async () => {
  const bytes = encoder.encode('id: 1\ndata: {"choices":[{"delta":{"content":"你"}}]}\n\n: keepalive\n\ndata: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n')
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 23))
      controller.enqueue(bytes.slice(23, 61))
      controller.enqueue(bytes.slice(61))
      controller.close()
    },
  })
  const text = await new Response(transformSse(source, 'test-model')).text()
  assert.equal((text.match(/data: \[DONE\]/g) || []).length, 1)
  assert.ok(text.endsWith('data: [DONE]\n\n'))
  assert.ok(!/^id:/m.test(text))
  assert.ok(text.includes(': keepalive'))
  assert.ok(text.includes('"object":"chat.completion.chunk"'))
  assert.ok(text.includes('你'))
  assert.ok(text.includes('好'))
})

test('non-stream aggregation concatenates content and tool calls', async () => {
  const events = [
    `data: ${JSON.stringify({ id: 'completion-A', choices: [{ delta: { role: 'assistant', content: 'hel', tool_calls: [{ index: 0, id: 'call_A', function: { name: 'get_', arguments: '{"ci' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo', tool_calls: [{ index: 0, function: { name: 'weather', arguments: 'ty":"SH"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
  ]
  const value = await aggregateSse(sseResponse(events).body, 'model-A')
  assert.equal(value.choices[0].message.content, 'hello')
  assert.equal(value.choices[0].message.tool_calls[0].function.name, 'get_weather')
  assert.equal(value.choices[0].message.tool_calls[0].function.arguments, '{"city":"SH"}')
  assert.equal(value.choices[0].finish_reason, 'tool_calls')
})

test('upstream [DONE] passes through once and CR-only SSE boundaries work', async () => {
  const input = 'data: {"choices":[{"delta":{"content":"ok"}}]}\r\rdata: [DONE]\r\r'
  const value = await new Response(transformSse(sseResponse([input]).body, 'model-A')).text()
  assert.equal((value.match(/data: \[DONE\]/g) || []).length, 1)
  assert.ok(value.endsWith('data: [DONE]\n\n'))
})

test('end-to-end gray pool, auth headers, SSE and model listing', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`${event('gray-response', 'stop')}`)
    res.end()
  })
  const cfg = config()
  cfg.upstreamUrl = `http://127.0.0.1:${upstream.port}${CHAT}`
  const proxy = await startProxy({ config: cfg, fetchImpl: fetch })
  t.after(async () => { await stop(proxy.server); await stop(upstream.server) })
  const base = `http://127.0.0.1:${proxy.port}`

  assert.equal((await fetch(`${base}/healthz`)).status, 200)
  assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer wrong' } })).status, 401)
  const models = await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${cfg.apiKey}` } })).json()
  assert.ok(!models.data.some((model) => model.id === 'Kimi_K3.1_Pro_VE'))

  const result = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json', 'x-gray-key': 'user-A', 'x-gray-force': '1' },
    body: JSON.stringify({ model: 'LLM_DeepSeekV4_Think', stream: true, messages: [{ role: 'user', content: 'test' }] }),
  })
  const text = await result.text()
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('x-xiaoyi-route'), 'gray')
  assert.equal(result.headers.get('x-xiaoyi-account'), 'gray-A')
  assert.equal(upstream.seen[0].headers.businesscredential, 'gray-token')
  assert.equal(upstream.seen[0].headers['x-uid'], 'gray-uid')
  assert.equal(upstream.seen[0].headers['x-device-id'], 'gray-device')
  assert.equal(upstream.seen[0].headers['x-prd-pkg-name'], 'com.huawei.hmos.vassistant')
  assert.ok(text.includes('gray-response'))
  assert.ok(text.endsWith('data: [DONE]\n\n'))
})

test('stable pool, non-stream response and disabled gray model rejection', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(event('stable-response', 'stop'))
  })
  const cfg = config()
  cfg.upstreamUrl = `http://127.0.0.1:${upstream.port}${CHAT}`
  cfg.gray.percentage = 0
  const proxy = await startProxy({ config: cfg })
  t.after(async () => { await stop(proxy.server); await stop(upstream.server) })
  const base = `http://127.0.0.1:${proxy.port}`
  const result = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'LLM_DeepSeekV4_Think', stream: false, messages: [] }),
  })
  const body = await result.json()
  assert.equal(result.headers.get('x-xiaoyi-account'), 'stable-A')
  assert.equal(body.object, 'chat.completion')
  assert.equal(body.choices[0].message.content, 'stable-response')
  const denied = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json', 'x-gray-force': '1' },
    body: JSON.stringify({ model: 'Kimi_K3.1_Pro_VE', messages: [] }),
  })
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).error.type, 'gray_model_disabled')
})

test('admin hot update persists first, redacts secrets, and rejects invalid patches', async (t) => {
  const writes = []
  const cfg = config()
  const proxy = await startProxy({ config: cfg, persistConfig: async (next) => { writes.push(structuredClone(next)) } })
  t.after(() => stop(proxy.server))
  const base = `http://127.0.0.1:${proxy.port}`
  assert.equal((await fetch(`${base}/_admin/config`, { headers: { authorization: `Bearer ${cfg.apiKey}` } })).status, 401)
  const response = await fetch(`${base}/_admin/gray`, {
    method: 'POST', headers: { 'x-admin-key': cfg.adminKey, 'content-type': 'application/json' },
    body: JSON.stringify({ percentage: 35.5, allowlist: ['user-beta'] }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.gray.percentage, 35.5)
  assert.deepEqual(writes[0].gray.allowlist, ['user-beta'])
  assert.equal(JSON.stringify(body).includes('stable-token'), false)
  assert.equal(JSON.stringify(body).includes('test-admin-key'), false)
  const invalid = await fetch(`${base}/_admin/gray`, {
    method: 'POST', headers: { 'x-admin-key': cfg.adminKey, 'content-type': 'application/json' }, body: '{"percentage":101}',
  })
  assert.equal(invalid.status, 400)
})

test('hot enable gray model removes it from /v1/models and persists the flag', async (t) => {
  const cfg = config()
  const proxy = await startProxy({ config: cfg, persistConfig: async () => {} })
  t.after(() => stop(proxy.server))
  const base = `http://127.0.0.1:${proxy.port}`
  const response = await fetch(`${base}/_admin/gray`, {
    method: 'POST', headers: { 'x-admin-key': cfg.adminKey, 'content-type': 'application/json' },
    body: JSON.stringify({ allowGrayModels: true, percentage: 0 }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).allowGrayModels, true)
  const models = await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${cfg.apiKey}` } })).json()
  assert.ok(models.data.some((model) => model.id === 'Kimi_K3.1_Pro_VE'))
  const invalid = await fetch(`${base}/_admin/gray`, {
    method: 'POST', headers: { 'x-admin-key': cfg.adminKey, 'content-type': 'application/json' },
    body: '{"allowGrayModels":"false"}',
  })
  assert.equal(invalid.status, 400)
})

test('failed persistence leaves active gray config unchanged and permits later updates', async (t) => {
  const cfg = config()
  let attempts = 0
  const proxy = await startProxy({
    config: cfg,
    persistConfig: async () => { attempts++; if (attempts === 1) throw new Error('read-only filesystem') },
  })
  t.after(() => stop(proxy.server))
  const url = `http://127.0.0.1:${proxy.port}/_admin/gray`
  const failed = await fetch(url, {
    method: 'POST', headers: { 'x-admin-key': cfg.adminKey, 'content-type': 'application/json' }, body: '{"percentage":80}',
  })
  assert.equal(failed.status, 500)
  assert.equal((await (await fetch(url.replace('/gray', '/config'), { headers: { 'x-admin-key': cfg.adminKey } })).json()).gray.percentage, 10)
  const next = await fetch(url, {
    method: 'POST', headers: { 'x-admin-key': cfg.adminKey, 'content-type': 'application/json' }, body: '{"percentage":15}',
  })
  assert.equal(next.status, 200)
  assert.equal((await next.json()).gray.percentage, 15)
})

test('default admin persistence atomically writes actual config file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyi-proxy-test-'))
  const cfg = config()
  const path = join(directory, 'config.json')
  const proxy = await startProxy({ config: cfg, configPath: path })
  t.after(async () => { await stop(proxy.server); await rm(directory, { recursive: true, force: true }) })
  const response = await fetch(`http://127.0.0.1:${proxy.port}/_admin/gray`, {
    method: 'POST', headers: { 'x-admin-key': cfg.adminKey, 'content-type': 'application/json' }, body: '{"percentage":27}',
  })
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).gray.percentage, 27)
})

test('401 renews credential, persists without logging secrets and retries', async (t) => {
  const cfg = config()
  cfg.accounts.stable[0].refreshToken = 'refresh-secret'
  let chatCalls = 0
  const upstream = await startUpstream((req, res) => {
    if (req.url === '/user-credential/v1/xiaoyiwork/refresh-token') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"token":"fresh-access-token"}'); return
    }
    if (req.url === '/user-credential/v1/business-credential/create') {
      assert.equal(req.headers.authorization, 'Bearer fresh-access-token')
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"credentialResult":{"businessCredential":"renewed-token","validTime":999999}}'); return
    }
    chatCalls++
    if (chatCalls === 1) { res.writeHead(401); res.end('expired'); return }
    assert.equal(req.headers.businesscredential, 'renewed-token')
    res.writeHead(200); res.end(event('renewed', 'stop'))
  })
  cfg.upstreamUrl = `http://127.0.0.1:${upstream.port}${CHAT}`
  const persisted = []
  const proxy = await startProxy({ config: cfg, configPath: '/tmp/xiaoyiwork-test-config.json', persistConfig: async (next) => persisted.push(next) })
  t.after(async () => { await stop(proxy.server); await stop(upstream.server) })
  const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'LLM_DeepSeekV4_Think', stream: false, messages: [] }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, 'renewed')
  assert.equal(chatCalls, 2)
  assert.equal(cfg.accounts.stable[0].credential, 'renewed-token')
  assert.equal(persisted[0].accounts.stable[0].credential, 'renewed-token')
})
