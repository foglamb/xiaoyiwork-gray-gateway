import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import { createProxyServer } from '../src/server.mjs'
import { AccountPool } from '../src/pool.mjs'
import { normalizeRequestBody } from '../src/compatibility.mjs'

const enc = new TextEncoder()
const event = (value) => `data: ${JSON.stringify(value)}\n\n`
const chunk = { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
const success = () => new Response(event(chunk), { headers: { 'content-type': 'text/event-stream' } })
const fixture = (overrides = {}) => ({
  listen: '127.0.0.1', port: 17356,
  upstreamUrl: 'https://hag-drcn.op.dbankcloud.com/celia/v1/sse-api/chat/completions',
  apiKey: 'fixture-api-key-123456', adminKey: 'fixture-admin-key-123456',
  requestTimeoutMs: 10000, maxBodyBytes: 10485760, streamHeartbeatMs: 0,
  accountProbeMinutes: 0, modelCatalogMinutes: 0,
  grayModels: [], allowGrayModels: false,
  gray: { enabled: false, percentage: 0, salt: 'fixture', allowHeaderOverride: false, allowCookieOverride: false, allowlist: [], denylist: [], models: [], pool: 'gray', shadow: false },
  accounts: { stable: ['a', 'b'].map((id) => ({ id, uid: `10000${id === 'a' ? 1 : 2}`, credential: `credential-${id}`, deviceId: `device-${id}` })), gray: [] },
  ...overrides,
})
async function launch(t, { chat = async () => success(), persistConfig = async () => {}, overrides = {} } = {}) {
  const config = fixture(overrides)
  const server = createProxyServer(config, {
    persistConfig,
    fetchImpl: (url, init) => String(url).endsWith('/chat/completions')
      ? chat(url, init)
      : Promise.resolve(Response.json({ contents: [], errorCode: '0' })),
    logger: { log() {}, warn() {}, error() {} },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: `Bearer ${config.adminKey}`, 'content-type': 'application/json' }
  const call = (path, body, method = 'POST') => fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const chatRequest = (stream = true) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { ...headers, authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model: 'fixture-model', messages: [], stream }) })
  return { base, config, headers, call, chatRequest }
}
async function logs(app) { return (await app.call('/api/logs?hours=24', undefined, 'GET')).json() }

test('client request ID matches logs and relates every failover attempt', async (t) => {
  const traces = []
  const app = await launch(t, { chat: async (_url, init) => {
    traces.push(init.headers['x-hag-trace-id'])
    return init.headers.businessCredential === 'credential-a' ? new Response('private response must not be retained', { status: 429 }) : success()
  } })
  const response = await app.chatRequest()
  await response.text()
  const id = response.headers.get('x-request-id')
  const data = await logs(app)
  assert.equal(data.entries.length, 1)
  const record = data.entries[0]
  assert.equal(record.id, id)
  assert.deepEqual(record.attempts.map((a) => [a.accountId, a.status]), [['a', 429], ['b', 200]])
  assert.deepEqual(record.attempts.map((a) => a.traceId), traces)
  assert.ok(traces.every((trace) => trace.startsWith(id + '-a')))
  assert.equal(JSON.stringify(record).includes('private response'), false)
  assert.equal(record.timingVersion, 2)
  assert.equal(record.firstByteMeaning, 'body_byte')
  assert.ok(record.firstByteMs >= record.responseHeadersMs)
  const state = await (await app.call('/api/state', undefined, 'GET')).json()
  assert.equal(state.accounts.find((a) => a.id === 'a').cooling, true)
  const saved = await app.call('/api/settings', { streamHeartbeatMs: 2500 })
  assert.equal(saved.status, 200)
  const after = await (await app.call('/api/state', undefined, 'GET')).json()
  assert.equal(after.accounts.find((a) => a.id === 'a').cooling, true, 'unrelated settings preserve cooldown')
})

test('SSE transport failure is a failed log with available usage', async (t) => {
  const app = await launch(t, { chat: async () => {
    let count = 0
    return new Response(new ReadableStream({ pull(controller) {
      if (count++ === 0) controller.enqueue(enc.encode(event(chunk)))
      else controller.error(new Error('private transport error'))
    } }))
  } })
  const response = await app.chatRequest()
  const body = await response.text()
  assert.match(body, /upstream_stream_error/)
  const record = (await logs(app)).entries[0]
  assert.equal(record.status, 502)
  assert.equal(record.errorType, 'upstream_stream_error')
  assert.equal(record.totalTokens, 12)
})

test('non-stream partial error returns 502 and keeps partial content plus failed log', async (t) => {
  const app = await launch(t, { chat: async () => new Response(event(chunk) + event({ code: 11115, message: 'server inner' })) })
  const response = await app.chatRequest(false)
  assert.equal(response.status, 502)
  const data = await response.json()
  assert.equal(data.choices[0].message.content, 'ok')
  assert.equal(data.error.code, '11115')
  const record = (await logs(app)).entries[0]
  assert.equal(record.status, 502)
  assert.equal(record.errorType, 'upstream_error')
  assert.equal(record.totalTokens, 12)
})

test('request timeout is 504 rather than client cancelled 499', async (t) => {
  const app = await launch(t, {
    overrides: { requestTimeoutMs: 40 },
    chat: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
  const response = await app.chatRequest(false)
  assert.equal(response.status, 504)
  assert.equal((await response.json()).error.type, 'upstream_timeout')
  const record = (await logs(app)).entries[0]
  assert.equal(record.status, 504)
  assert.equal(record.errorType, 'upstream_timeout')
  assert.equal(record.attempts[0].status, 504)
})

test('streaming timeout retains usage and records 504 after response headers', async (t) => {
  const app = await launch(t, {
    overrides: { requestTimeoutMs: 50 },
    chat: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(enc.encode(event(chunk))) } })),
  })
  const response = await app.chatRequest()
  await response.text()
  const record = (await logs(app)).entries[0]
  assert.equal(record.status, 504)
  assert.equal(record.errorType, 'upstream_timeout')
  assert.equal(record.totalTokens, 12)
})

test('client disconnect keeps measured usage and is classified as 499', async (t) => {
  let cancelled
  const cancellation = new Promise((resolve) => { cancelled = resolve })
  const app = await launch(t, { chat: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(enc.encode(event(chunk))) },
    cancel() { cancelled() },
  })) })
  const request = http.request(app.base + '/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${app.config.apiKey}`, 'content-type': 'application/json' },
  })
  request.on('error', () => {})
  request.end(JSON.stringify({ model: 'fixture-model', messages: [], stream: true }))
  const [response] = await once(request, 'response')
  await once(response, 'data')
  request.destroy()
  await cancellation
  let record
  for (let i = 0; i < 20; i++) {
    record = (await logs(app)).entries[0]
    if (record) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(record.status, 499)
  assert.equal(record.errorType, 'client_cancelled')
  assert.equal(record.totalTokens, 12)
})

test('queued settings patches merge with latest config and accept model selection', async (t) => {
  let release
  let started
  const entered = new Promise((resolve) => { started = resolve })
  const blocker = new Promise((resolve) => { release = resolve })
  const writes = []
  const app = await launch(t, { persistConfig: async (config) => {
    if (!writes.length) { started(); await blocker }
    writes.push(structuredClone(config))
  } })
  const a = app.call('/api/settings', { streamHeartbeatMs: 2200 })
  await entered
  const b = app.call('/api/settings', { grayModels: ['fixture-only'], modelCatalogMinutes: 0 })
  release()
  assert.equal((await a).status, 200)
  assert.equal((await b).status, 200)
  assert.equal(writes.at(-1).streamHeartbeatMs, 2200)
  assert.deepEqual(writes.at(-1).grayModels, ['fixture-only'])
  const invalid = await app.call('/api/settings', { unsupportedControl: true })
  assert.equal(invalid.status, 400, 'unknown controls cannot silently succeed')
  const alias = await app.call('/api/settings', { grayModelIds: ['legacy-panel-model'] })
  assert.equal(alias.status, 200)
  assert.deepEqual(writes.at(-1).grayModels, ['legacy-panel-model'])
})

test('body byte and first useful delta timing are independent of response headers', async () => {
  let feed
  const seen = { headers: 0, bytes: 0, tokens: 0 }
  const config = fixture()
  const pool = new AccountPool(config, { fetchImpl: async () => new Response(new ReadableStream({ start(c) { feed = c } })) })
  const response = await pool.chat({ model: 'fixture', messages: [], stream: true }, { pool: 'stable', selected: false, reason: 'test', bucket: 0 }, {
    onResponseHeaders: () => seen.headers++, onFirstByte: () => seen.bytes++, onFirstToken: () => seen.tokens++,
  })
  assert.deepEqual(seen, { headers: 1, bytes: 0, tokens: 0 })
  const reader = response.body.getReader()
  feed.enqueue(enc.encode(event({ choices: [{ delta: { role: 'assistant', tool_calls: [] } }] })))
  await reader.read()
  assert.deepEqual(seen, { headers: 1, bytes: 1, tokens: 0 })
  feed.enqueue(enc.encode(event(chunk)))
  feed.close()
  while (!(await reader.read()).done) {}
  assert.deepEqual(seen, { headers: 1, bytes: 1, tokens: 1 })
})

test('Kimi named tool choice cannot silently select a different function', () => {
  const body = { model: 'Kimi_fixture', tool_choice: { type: 'function', function: { name: 'chosen' } }, tools: [
    { type: 'function', function: { name: 'chosen', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'other', parameters: { type: 'object' } } },
  ] }
  const result = normalizeRequestBody(body)
  assert.equal(result.tool_choice, 'required')
  assert.deepEqual(result.tools.map((t) => t.function.name), ['chosen'])
  assert.throws(() => normalizeRequestBody({ model: 'Kimi_fixture', tools: [], tool_choice: { type: 'function', function: { name: 'missing' } } }), (e) => e.code === 'invalid_tool_choice')
})
