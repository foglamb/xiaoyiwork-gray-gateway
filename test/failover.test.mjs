import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountPool } from '../src/pool.mjs'

function config(accounts) {
  return {
    upstreamUrl: 'https://hag-drcn.op.dbankcloud.com/celia/v1/sse-api/chat/completions',
    accounts: { stable: accounts, gray: accounts },
  }
}

const okBody = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
const route = { pool: 'stable', selected: false, reason: 'percentage', bucket: 1 }
const body = { model: 'LLM_DeepSeekV4_Think', stream: false, messages: [] }

function account(id, extra = {}) {
  return { id, credential: `cred-${id}`, uid: `70086000${id}`, deviceId: `device-${id}`, ...extra }
}

test('401 on first account fails over to the next account transparently', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.businessCredential)
    return init.headers.businessCredential === 'cred-a' ? new Response('expired', { status: 401 }) : okBody()
  }
  const pool = new AccountPool(config([account('a'), account('b')]), { fetchImpl, logger: { log() {} } })
  const response = await pool.chat(body, route, {})
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-xiaoyi-account'), 'b')
  assert.equal(seen.length, 2)
  assert.equal(pool.stats.failovers, 1)
  assert.ok(pool.isCooling(pool.config.accounts.stable[0]), 'failed account is cooling down')
})

test('429 rate limit switches account and cools it', async () => {
  const fetchImpl = async (url, init) => init.headers.businessCredential === 'cred-a'
    ? new Response('rate limited', { status: 429 })
    : okBody()
  const pool = new AccountPool(config([account('a'), account('b')]), { fetchImpl, logger: { log() {} } })
  const response = await pool.chat(body, route, {})
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-xiaoyi-account'), 'b')
  const cooling = pool.cooldownUntil.get('a')
  assert.ok(cooling && cooling > Date.now(), 'account a cooled')
})

test('5xx fails over and does not leak the failing account id', async () => {
  const fetchImpl = async (url, init) => init.headers.businessCredential === 'cred-a'
    ? new Response('boom', { status: 503 })
    : okBody()
  const pool = new AccountPool(config([account('a'), account('b')]), { fetchImpl, logger: { log() {} } })
  const response = await pool.chat(body, route, {})
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-xiaoyi-account'), 'b')
})

test('request-shape errors (400) do not trigger account switching', async () => {
  const seen = []
  const fetchImpl = async (url, init) => { seen.push(init.headers.businessCredential); return new Response('bad request', { status: 400 }) }
  const pool = new AccountPool(config([account('a'), account('b')]), { fetchImpl, logger: { log() {} } })
  await assert.rejects(() => pool.chat(body, route, {}), (error) => error.status === 400)
  assert.equal(seen.length, 1, 'only one attempt for client errors')
})

test('all accounts failing surfaces an explanatory 503/upstream error', async () => {
  const fetchImpl = async () => new Response('expired', { status: 401 })
  const pool = new AccountPool(config([account('a'), account('b')]), { fetchImpl, logger: { log() {} } })
  await assert.rejects(() => pool.chat(body, route, {}), (error) => {
    assert.ok(/尝试 2 个账号/.test(error.message), `message: ${error.message}`)
    return true
  })
})

test('cooldown expires and the account returns to rotation', async () => {
  const pool = new AccountPool(config([account('a')]), { fetchImpl: async () => okBody(), logger: { log() {} } })
  const target = pool.config.accounts.stable[0]
  pool.cool(target, 10, 'test')
  assert.equal(pool.isCooling(target), true)
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(pool.isCooling(target), false)
  assert.equal(pool.cooldownUntil.has('a'), false, 'expired entry cleaned up')
})

test('credential renewal is attempted before switching accounts', async () => {
  let renewCalls = 0
  const fetchImpl = async (url, init) => {
    if (url.includes('refresh-token')) { renewCalls++; return Response.json({ token: 'fresh' }) }
    if (url.includes('business-credential/create')) return Response.json({ credentialResult: { businessCredential: 'renewed' } })
    if (init.headers.businessCredential === 'cred-a') return new Response('expired', { status: 401 })
    return okBody()
  }
  const pool = new AccountPool(config([account('a', { refreshToken: 'rt' }), account('b')]), { fetchImpl, logger: { log() {} } })
  // First call uses account a, renews, retries a with the renewed credential.
  const response = await pool.chat(body, route, {})
  assert.equal(renewCalls, 1)
  assert.equal(response.status, 200)
  const renewed = pool.config.accounts.stable[0].credential
  assert.equal(renewed, 'renewed', 'credential updated in place')
})

test('empty pool still returns a clear error', async () => {
  const pool = new AccountPool({ upstreamUrl: 'https://x/y', accounts: { stable: [], gray: [] } }, { fetchImpl: async () => okBody(), logger: { log() {} } })
  await assert.rejects(() => pool.chat(body, route, {}), (error) => error.code === 'account_pool_empty')
})
