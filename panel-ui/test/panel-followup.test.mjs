import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuthLifecycle } from '../src/lib/auth.js'
import { settingsFromState, savedSettings, settingsPayload } from '../src/lib/settings.js'
import { mergeConfirmed, finiteMetric, contiguousSegments, cacheRate, modelBadges } from '../src/lib/panel.js'
import { copyText } from '../src/lib/clipboard.js'

test('auth generation cannot be reused after logout or another login', () => {
  const auth = createAuthLifecycle()
  const boot = auth.capture()
  auth.invalidate()
  assert.equal(auth.current(boot), false)
  const login = auth.capture()
  auth.invalidate()
  assert.equal(auth.current(login), false)
})

test('normalized save baseline and unchanged fields use server confirmation while later edits survive', () => {
  const submitted = { ...settingsFromState({ settings: {} }), logMaxEntries: 9999, grayModelIds: ['one'] }
  const edited = { ...submitted, accountProbeMinutes: 30, grayModelIds: ['two'] }
  const result = savedSettings(edited, submitted, { ...settingsPayload(submitted), logMaxEntries: 5000 })
  assert.equal(result.baseline.logMaxEntries, 5000)
  assert.equal(result.draft.logMaxEntries, 5000)
  assert.equal(result.draft.accountProbeMinutes, 30)
  assert.deepEqual(result.draft.grayModelIds, ['two'])
  assert.deepEqual(result.baseline.grayModelIds, ['one'])
})

test('gray confirmation merges per field and array without losing later edits', () => {
  const before = { percentage: 10, models: ['one'], enabled: true }
  const later = { ...before, models: ['two'] }
  assert.deepEqual(mergeConfirmed(later, before, { ...before, percentage: 15 }), { percentage: 15, models: ['two'], enabled: true })
})

test('unknown cache metrics remain gaps rather than zero and malformed pairs stay unknown', () => {
  assert.equal(finiteMetric(null), null)
  assert.equal(finiteMetric(0), 0)
  const segments = contiguousSegments([{ cache: 20 }, { cache: null }, { cache: 0 }], 'cache')
  assert.deepEqual(segments.map((segment) => segment.map(({ index }) => index)), [[0], [2]])
  assert.equal(cacheRate({ promptTokens: 100, cachedTokens: null }), null)
  assert.equal(cacheRate({ promptTokens: 100, cachedTokens: 200 }), null)
  assert.equal(cacheRate({ promptTokens: 100, cachedTokens: 0 }), 0)
})

test('official gray flags cannot determine local policy and unknown vision stays unknown', () => {
  const badges = modelBadges({ upstreamGray: true, gatewayGray: false, gatewayPolicy: 'traffic-split', gatewayAllowed: true, vision: null })
  assert.equal(badges.upstream, '上游灰度')
  assert.equal(badges.gateway, '按流量规则分流')
  assert.equal(badges.vision, '视觉能力未知')
  assert.equal(badges.availability, '本地已启用')
  assert.equal(modelBadges({ gatewayPolicy: 'gray-pool', gatewayAllowed: true }).gateway, '受本地灰度策略限制')
  assert.equal(modelBadges({ gatewayGray: true, gatewayPolicy: 'gray-pool', gatewayAllowed: false }).availability, '本地未开放')
})

test('clipboard confirms actual success and reports unsupported or rejected fallbacks', async () => {
  let copied = ''
  await copyText('model', { navigator: { clipboard: { writeText: async (text) => { copied = text } } } })
  assert.equal(copied, 'model')
  await assert.rejects(copyText('model', {}), /复制不可用/)
  let removed = false
  const doc = { createElement: () => ({ style: {}, select() {}, remove() { removed = true } }), body: { append() {} }, execCommand: () => false }
  await assert.rejects(copyText('model', { document: doc }), /复制失败/)
  assert.equal(removed, true)
})

test('API ignores successful responses after session invalidation and clears all shared data', async () => {
  globalThis.sessionStorage = { getItem: () => 'synthetic', setItem() {}, removeItem() {} }
  const auth = await import('../src/composables/useApi.js')
  const dashboard = await import('../src/composables/useDashboard.js')
  const logs = await import('../src/composables/useLogs.js')
  let resolve
  globalThis.fetch = () => new Promise((r) => { resolve = r })
  dashboard.state.value = { settings: {} }
  logs.tableData.value = { entries: [{ id: 'synthetic' }] }
  const pending = auth.api('/synthetic')
  auth.setAdminKey('')
  resolve({ ok: true, text: async () => '{"ok":true}' })
  await assert.rejects(pending, (error) => error.type === 'session_changed')
  assert.equal(dashboard.state.value, null)
  assert.equal(logs.tableData.value, null)
  assert.equal(auth.adminKey.value, '')
})
