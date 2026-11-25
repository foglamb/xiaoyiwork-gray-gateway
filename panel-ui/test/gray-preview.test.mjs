import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

globalThis.sessionStorage = { getItem: () => 'synthetic-admin' }
const { previewBucket } = await import('../src/composables/useGray.js')

test('preview uses authenticated server API without browser crypto', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
  let request
  globalThis.fetch = async (path, options) => {
    request = { path, options }
    return { ok: true, text: async () => JSON.stringify({ identity: 'user', salt: 'salt', bucket: 123, gray: true }) }
  }
  try {
    const result = await previewBucket('user', 'salt', 10)
    assert.equal(result.bucket, 123)
    assert.equal(request.path, '/api/gray/preview')
    assert.equal(request.options.method, 'POST')
    assert.equal(request.options.headers.authorization, 'Bearer synthetic-admin')
    assert.deepEqual(JSON.parse(request.options.body), { identity: 'user', salt: 'salt', percentage: 10 })
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
    else delete globalThis.crypto
  }
})

test('actual GrayView preview handler reports API failures and resets busy', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => '{"error":{"message":"预览参数无效"}}' })
  const source = readFileSync(new URL('../src/components/GrayView.vue', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('async function runPreview()'), source.indexOf('\nwatch([salt, percentage'))
  const messages = []
  const ctx = { previewBucket, previewInput: { value: 'user' }, salt: { value: 'salt' }, percentage: { value: 10 }, previewBusy: { value: false }, preview: { value: { bucket: 1 } }, notify: (...args) => messages.push(args) }
  vm.createContext(ctx)
  vm.runInContext(handler, ctx)
  await ctx.runPreview()
  assert.equal(ctx.previewBusy.value, false)
  assert.equal(ctx.preview.value, null)
  assert.equal(messages[0][0], '预览参数无效')
  assert.equal(messages[0][1], 'err')
})
