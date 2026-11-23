import assert from 'node:assert/strict'
import test from 'node:test'
import { transformSse } from '../src/upstream.mjs'
import { RequestLog } from '../src/requestlog.mjs'
import { AccountPool } from '../src/pool.mjs'

const enc = new TextEncoder()

test('heartbeat keeps the stream alive while upstream is silent', async () => {
  let controllerRef
  const slow = new ReadableStream({
    start(controller) {
      controllerRef = controller
      // Send nothing for 120ms, then a real chunk.
      setTimeout(() => { controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n')); controller.close() }, 120)
    },
  })
  const out = new Response(transformSse(slow, 'm', { heartbeatMs: 30 })).text()
  const text = await out
  assert.match(text, /: keepalive/, 'heartbeat comment frame emitted')
  assert.match(text, /hi/)
  assert.ok(text.trimEnd().endsWith('data: [DONE]'))
  void controllerRef
})

test('first token callback fires once on first content delta', async () => {
  let calls = 0
  const src = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
      c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'))
      c.close()
    },
  })
  await new Response(transformSse(src, 'm', { heartbeatMs: 0, onFirstToken: () => { calls++ } })).text()
  assert.equal(calls, 1)
})

test('latency breakdown is recorded per request', () => {
  const log = new RequestLog({ persist: false })
  log.begin({ id: 'r1', model: 'm', stream: true, route: { selected: false, pool: 'stable', reason: 'percentage' } })
  const now = Date.now()
  log.finish('r1', { status: 200, marks: { firstTokenAt: now }, usage: { total_tokens: 3 } })
  const [entry] = log.page().entries
  assert.ok(entry.firstTokenMs === null || entry.firstTokenMs >= 0)
  assert.equal(entry.ttftMs, entry.firstTokenMs)
})

function cfg(accounts) {
  return { upstreamUrl: 'https://hag-drcn.op.dbankcloud.com/celia/v1/sse-api/chat/completions', accounts: { stable: accounts, gray: accounts } }
}
const acc = (id) => ({ id, credential: `cred-${id}`, uid: `7008600${id}`, deviceId: `device-${id}` })

test('probe marks a healthy account and clears cooldown', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('privilege/query')) return Response.json({ errorCode: '0', errorMessage: 'Success' })
    return new Response('{}', { status: 200 })
  }
  const pool = new AccountPool(cfg([acc('a')]), { fetchImpl, logger: { log() {}, warn() {} } })
  const account = pool.config.accounts.stable[0]
  pool.cool(account, 60000, 'test')
  assert.equal(pool.isCooling(account), true)
  const state = await pool.probe(account)
  assert.equal(state.ok, true)
  assert.equal(pool.isCooling(account), false, 'healthy probe clears the cooldown')
  assert.equal(pool.healthOf(account).ok, true)
})

test('probe cools an account whose credential is rejected', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('privilege/query')) return new Response('unauthorized', { status: 401 })
    return new Response('{}', { status: 200 })
  }
  const pool = new AccountPool(cfg([acc('a')]), { fetchImpl, logger: { log() {}, warn() {} } })
  const account = pool.config.accounts.stable[0]
  const state = await pool.probe(account)
  assert.equal(state.ok, false)
  assert.equal(state.status, 401)
  assert.equal(pool.isCooling(account), true)
})

test('probe network failure is reported, not thrown', async () => {
  const pool = new AccountPool(cfg([acc('a')]), { fetchImpl: async () => { throw new TypeError('fetch failed') }, logger: { log() {}, warn() {} } })
  const state = await pool.probe(pool.config.accounts.stable[0])
  assert.equal(state.ok, false)
  assert.match(state.message, /探测失败/)
})
