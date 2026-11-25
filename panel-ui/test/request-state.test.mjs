import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.sessionStorage = { getItem: () => null }
const pending = []
globalThis.fetch = (path) => new Promise((resolve) => pending.push({ path, resolve: (data) => resolve({ ok: true, text: async () => JSON.stringify(data) }) }))
const table = await import('../src/composables/useLogs.js')
const overview = await import('../src/composables/useDashboard.js')
const response = (page, label, until = 10000) => ({ page, pageSize: 20, pages: 3, total: 60, until, entries: [{ id: label }], stats: { last24h: 60 } })

test('table filter races, polling, snapshot pagination and overview are isolated', async () => {
  const first = table.loadTableLogs()
  const second = table.updateLogQuery({ model: 'new-model', sort: 'ms', order: 'asc' })
  pending[1].resolve(response(1, 'filtered'))
  await second
  pending[0].resolve(response(1, 'old'))
  await first
  assert.equal(table.tableEntries.value[0].id, 'filtered')
  const nextPage = table.updateLogQuery({ page: 2 })
  assert.deepEqual(table.tableEntries.value, [], 'new query cannot export or display previous page rows')
  const params = new URL(pending[2].path, 'http://example.test').searchParams
  assert.equal(params.get('until'), '10000')
  assert.equal(params.get('model'), 'new-model')
  pending[2].resolve(response(2, 'page-two'))
  await nextPage
  const poll = table.loadTableLogs()
  assert.equal(pending[3].path, pending[2].path)
  pending[3].resolve(response(2, 'page-two-refreshed'))
  await poll
  assert.equal(table.logQuery.value.page, 2)
  const overviewLoad = overview.loadLogs()
  pending[4].resolve(response(1, 'overview'))
  await overviewLoad
  assert.equal(overview.logs.value[0].id, 'overview')
  assert.equal(table.tableEntries.value[0].id, 'page-two-refreshed')
  const latest = table.resumeLatestLogs()
  assert.equal(new URL(pending[5].path, 'http://example.test').searchParams.has('until'), false)
  pending[5].resolve(response(1, 'latest'))
  await latest
  assert.equal(table.logQuery.value.page, 1)
  assert.equal(table.logQuery.value.model, 'new-model')
})

test('successful setting snapshot rejects state responses already in flight', async () => {
  overview.state.value = { requestTimeoutMs: 1000, settings: { grayModelIds: ['old'] } }
  const index = pending.length
  const stale = overview.loadState()
  overview.acceptSettingsSnapshot({ requestTimeoutMs: 2000, grayModelIds: ['new'] })
  pending[index].resolve({ requestTimeoutMs: 1000, settings: { grayModelIds: ['old'] } })
  await stale
  assert.equal(overview.state.value.requestTimeoutMs, 2000)
  assert.deepEqual(overview.state.value.settings.grayModelIds, ['new'])
})

test('overview ignores older same-window responses and refreshAll propagates double failure', async () => {
  let index = pending.length
  const old = overview.loadLogs()
  const fresh = overview.loadLogs()
  pending[index + 1].resolve(response(1, 'fresh'))
  await fresh
  pending[index].resolve(response(1, 'stale'))
  await old
  assert.equal(overview.logs.value[0].id, 'fresh')
  const previous = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline') }
  try { await assert.rejects(overview.refreshAll(), /offline/) } finally { globalThis.fetch = previous }
  assert.equal(overview.loading.value, false)
})
