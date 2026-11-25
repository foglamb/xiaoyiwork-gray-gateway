import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLogQuery, changeLogQuery, logQueryString, createRequestGate, latencyStages, stageStyle, measuredOutputTps, csvCell, logsCsv, proportionalHeight } from '../src/lib/logs.js'
import { settingsFromState, settingsSync, settingsPayload, savedSettings, settingsEqual } from '../src/lib/settings.js'
import { ms } from '../src/composables/useFormat.js'

test('query preserves filters, size and sort while pagination freezes a server snapshot', () => {
  const query = changeLogQuery(defaultLogQuery(), { pageSize: 100, model: 'a&b', accountId: 'account', status: 'error', q: 'timeout', sort: 'outputTps', order: 'asc', hours: 72 })
  const page = changeLogQuery(query, { page: 2 }, 123456)
  assert.equal(page.until, 123456)
  assert.equal(page.pageSize, 100)
  const params = new URLSearchParams(logQueryString(page))
  for (const key of ['model', 'accountId', 'status', 'q', 'sort', 'order']) assert.equal(params.get(key), query[key])
  assert.equal(params.get('page'), '2')
  const filtered = changeLogQuery(page, { model: 'another' })
  assert.equal(filtered.page, 1)
  assert.equal(filtered.until, 123456)
  const latest = changeLogQuery(filtered, { page: 1, until: null })
  assert.equal(new URLSearchParams(logQueryString(latest)).has('until'), false)
  assert.equal(latest.model, 'another')
})

test('request gate rejects out-of-order and invalidated reads', () => {
  const gate = createRequestGate()
  const first = gate.next()
  const second = gate.next()
  assert.equal(gate.current(first), false)
  assert.equal(gate.current(second), true)
  gate.invalidate()
  assert.equal(gate.current(second), false)
})

test('missing timing stays unknown, including historical firstByte-as-headers', () => {
  const stages = latencyStages({ ms: 1000, firstByteMs: 150, firstByteMeaning: 'historical_response_headers' })
  assert.deepEqual(stages.map((stage) => stage.value), [null, null, null])
  assert.equal(ms(stages[0].value), '—')
  assert.equal(measuredOutputTps({ ms: 1000, outputTps: 100 }), null)
  assert.deepEqual(latencyStages({ ms: 1000, responseHeadersMs: 100, ttftMs: 300 }).map((s) => s.value), [100, 200, 700])
  assert.deepEqual(latencyStages({ ms: 1000, ttftMs: 300 }).map((s) => s.value), [null, null, 700])
  assert.equal(measuredOutputTps({ ms: 1000, ttftMs: 300, outputTps: 14 }), 14)
  assert.equal(measuredOutputTps({ ms: 1000, ttftMs: 1000, outputTps: 14 }), null)
  assert.deepEqual(latencyStages({ ms: 1000, responseHeadersMs: 2000, ttftMs: 2000 }).map((s) => s.value), [null, null, null])
})

test('timing segments and TokenBars keep actual proportions', () => {
  assert.deepEqual(stageStyle({ value: 1, offset: 3 }, { ms: 1000 }), { left: '0.3%', width: '0.1%' })
  assert.equal(proportionalHeight(1, 100000), 0.001)
  assert.equal(proportionalHeight(0, 100), 0)
})

test('CSV escapes formulas, leading controls, quotes, delimiters and multiline content', () => {
  for (const value of ['=SUM(A1)', '+cmd', '-cmd', '@cmd', '  =cmd', '\t=cmd', '\rtext', '\ntext', '\u0000=cmd']) assert.ok(csvCell(value).startsWith('"\''), value)
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"')
  const csv = logsCsv([{ at: 'invalid', model: '=cmd', ms: 500, outputTps: 100, endToEndTps: 80, errorType: 'network', attempts: [{ index: 1, traceId: 'trace' }] }])
  assert.ok(csv.startsWith('\ufeff'))
  assert.ok(csv.includes('"endToEndTps"'))
  assert.ok(csv.includes('"\'=cmd"'))
  assert.ok(csv.includes('trace'))
  assert.ok(!csv.includes('"100"'))
})

test('polling cannot replace a dirty draft or a saving draft', () => {
  const baseline = settingsFromState({ requestTimeoutMs: 1000, settings: {} })
  const edit = { ...baseline, requestTimeoutMs: 2000 }
  const poll = { requestTimeoutMs: 3000, settings: {} }
  assert.equal(settingsSync(edit, baseline, poll, false), null)
  assert.equal(settingsSync(baseline, baseline, poll, true), null)
  assert.equal(settingsSync(baseline, baseline, poll, false).requestTimeoutMs, 3000)
})

test('settings payload maps grayModels and saved baseline uses submitted snapshot', () => {
  const initial = settingsFromState({ requestTimeoutMs: 1000, settings: { grayModelIds: ['one'] } })
  const submitted = { ...initial, requestTimeoutMs: 2000, grayModelIds: ['two'] }
  const payload = settingsPayload(submitted)
  assert.deepEqual(payload.grayModels, ['two'])
  assert.equal('grayModelIds' in payload, false)
  submitted.grayModelIds.push('three')
  assert.deepEqual(payload.grayModels, ['two'])
  const nextEdit = { ...submitted, requestTimeoutMs: 3000 }
  const saved = savedSettings(nextEdit, submitted)
  assert.equal(saved.baseline.requestTimeoutMs, 2000)
  assert.equal(saved.draft.requestTimeoutMs, 3000)
  assert.equal(settingsEqual(saved.baseline, saved.draft), false)
  assert.equal(settingsEqual(savedSettings(submitted, submitted).baseline, submitted), true)
  submitted.grayModelIds.push('four')
  assert.deepEqual(saved.baseline.grayModelIds, ['two', 'three'])
})
