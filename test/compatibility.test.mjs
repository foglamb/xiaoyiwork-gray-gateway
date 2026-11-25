import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeRequestBody } from '../src/compatibility.mjs'
import { AccountPool, MAX_HAG_BODY_BYTES } from '../src/pool.mjs'
import { transformSse, aggregateSse } from '../src/upstream.mjs'

test('Kimi requests drop unsupported temperature and normalize named tool_choice', () => {
  const input = {
    model: 'Kimi_K3.1_Pro_VE',
    temperature: 0,
    tool_choice: { type: 'function', function: { name: 'search' } },
    tools: [{
      type: 'function',
      function: {
        name: 'search',
        parameters: {
          type: 'object',
          $defs: { Query: { enum: ['news', 'docs'] } },
          properties: { query: { $ref: '#/$defs/Query' }, limit: { const: 1 } },
        },
      },
    }],
  }
  const output = normalizeRequestBody(input)
  assert.equal('temperature' in output, false)
  assert.equal(output.tool_choice, 'required')
  const schema = output.tools[0].function.parameters
  assert.deepEqual(schema.properties.query, { enum: ['news', 'docs'], type: 'string' })
  assert.equal(schema.properties.limit.type, 'integer')
  assert.equal('$defs' in schema, false)

  const untouched = normalizeRequestBody({ model: 'GLM_5.3_FLASH_VE', temperature: 0.2 })
  assert.equal(untouched.temperature, 0.2)
})

function poolWith(fetchImpl, overrides = {}) {
  return new AccountPool({
    upstreamUrl: 'https://hag-drcn.op.dbankcloud.com/celia/v1/sse-api/chat/completions',
    accounts: { gray: [{ id: 'gray-test', uid: '123456', deviceId: 'device-test', credential: 'credential-test' }], stable: [] },
    ...overrides,
  }, { fetchImpl })
}

test('pool normalizes the actual outgoing Kimi request body', async () => {
  let forwarded
  const pool = poolWith(async (url, init) => {
    forwarded = JSON.parse(init.body)
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', { status: 200 })
  })
  const response = await pool.chat({
    model: 'Kimi_K3.1_Pro_VE', messages: [], stream: false, temperature: 0,
    tool_choice: { type: 'function', function: { name: 'x' } },
    tools: [{ type: 'function', function: { name: 'x', parameters: { type: 'object', properties: {} } } }],
  }, { pool: 'gray', selected: true, reason: 'test', bucket: 0 })
  assert.equal(response.status, 200)
  assert.equal('temperature' in forwarded, false)
  assert.equal(forwarded.tool_choice, 'required')
  assert.equal(forwarded.stream, true, 'upstream remains SSE for non-stream clients')
})

test('requests above the upstream 4.5 MiB limit fail with 413 before fetch', async () => {
  let called = false
  const pool = poolWith(async () => { called = true; throw new Error('must not fetch') })
  await assert.rejects(
    pool.chat({ model: 'Kimi_K3.1_Pro_VE', messages: [{ role: 'user', content: 'x'.repeat(MAX_HAG_BODY_BYTES) }] }, { pool: 'gray', selected: true, reason: 'test', bucket: 0 }),
    (error) => error.status === 413 && error.code === 'upstream_body_too_large',
  )
  assert.equal(called, false)
})

test('SSE error frames stop upstream reads and still terminate the client stream', async () => {
  let cancelled = false
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"code":11115,"message":"server inner"}\n\n'))
      // Intentionally remain open: correct error-frame handling must cancel it.
    },
    cancel() { cancelled = true },
  })
  let reported
  const text = await new Response(transformSse(upstream, 'Kimi_K3.1_Pro_VE', { onError: (error) => { reported = error } })).text()
  assert.match(text, /"code":"11115"/)
  assert.match(text, /server inner/)
  assert.match(text, /data: \[DONE\]/)
  assert.equal(reported.code, '11115')
  assert.equal(cancelled, true)
})

test('non-stream aggregation turns an empty upstream error into 502', async () => {
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"code":11115,"message":"server inner"}\n\n'))
      controller.close()
    },
  })
  await assert.rejects(
    aggregateSse(upstream, 'Kimi_K3.1_Pro_VE'),
    (error) => error.status === 502 && error.code === 'upstream_error' && /11115/.test(error.message),
  )
})

test('partial content is preserved when a later upstream error arrives', async () => {
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"code":11115,"message":"server inner"}\n\n'))
      controller.close()
    },
  })
  const result = await aggregateSse(upstream, 'Kimi_K3.1_Pro_VE')
  assert.equal(result.choices[0].message.content, 'partial')
  assert.equal(result.error.code, '11115')
})

test('compatibility switches preserve the original Kimi request when disabled', async () => {
  let forwarded
  const pool = poolWith(async (url, init) => {
    forwarded = JSON.parse(init.body)
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', { status: 200 })
  }, { kimiCompatibility: false, normalizeToolSchemas: false })
  await pool.chat({ model: 'Kimi_K3.1_Pro_VE', messages: [], stream: false, temperature: 0 }, { pool: 'gray', selected: true, reason: 'test', bucket: 0 })
  assert.equal(forwarded.temperature, 0)
})

test('zero heartbeat disables keepalive without a zero-delay timer loop', async () => {
  const upstream = new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
      await new Promise((resolve) => setTimeout(resolve, 20))
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'))
      controller.close()
    },
  })
  const text = await new Response(transformSse(upstream, 'Kimi_K3.1_Pro_VE', { heartbeatMs: 0 })).text()
  assert.doesNotMatch(text, /keepalive/)
  assert.match(text, /"content":"a"/)
  assert.match(text, /"content":"b"/)
})
