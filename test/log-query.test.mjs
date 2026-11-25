import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, lstatSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { RequestLog, timingMetrics } from '../src/requestlog.mjs'

function fixture(t) {
  const root = resolve(tmpdir())
  const dir = mkdtempSync(join(root, 'xiaoyi-log-query-'))
  t.after(() => {
    const target = resolve(dir)
    assert.equal(dirname(target), root)
    assert.ok(target.startsWith(join(root, 'xiaoyi-log-query-')))
    assert.ok(lstatSync(target).isDirectory())
    rmSync(target, { recursive: true, force: true })
  })
  return { dir, configPath: join(dir, 'config.json') }
}
function writeRows(path, rows) {
  writeFileSync(path, rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n')
}
function row(id, at, overrides = {}) {
  return { id, at, model: 'm', accountId: 'a', status: 200, ms: 1000, ttftMs: 200, promptTokens: 100, completionTokens: 80, totalTokens: 180, ...overrides }
}
function finish(log, id, payload = {}) {
  log.begin({ id, model: 'm', stream: true })
  log.finish(id, { usage: { completion_tokens: 80, total_tokens: 80 }, ...payload })
}

test('query filters all retained files beyond the ring and shares a fixed window with every aggregate', (t) => {
  const { dir, configPath } = fixture(t)
  const until = 1800000000000
  const old = row('old-ring-eviction', until - 30 * 3600000, { model: 'old' })
  const rows = Array.from({ length: 60 }, (_, i) => row(`r-${i}`, until - (i + 1) * 1000, {
    model: i % 2 ? 'm' : 'other', accountId: i % 3 ? 'a' : 'b', status: i % 5 ? 200 : 500,
    error: i % 5 ? '' : 'upstream timeout',
  }))
  writeRows(join(dir, 'requests.jsonl.7'), [old, ...rows.slice(30)])
  writeRows(join(dir, 'requests.jsonl.12'), rows.slice(10, 30))
  writeRows(join(dir, 'requests.jsonl'), rows.slice(0, 10))
  const log = new RequestLog({ configPath, maxEntries: 50 })
  assert.equal(log.entries.length, 50)
  assert.equal(log.query({ until, hours: 72 }).total, 61)
  const result = log.query({ until, hours: 1, model: 'm', accountId: 'a', status: 'error', q: 'TIMEOUT', pageSize: 1 })
  const expected = rows.filter((entry) => entry.model === 'm' && entry.accountId === 'a' && entry.status >= 400)
  assert.equal(result.total, expected.length)
  assert.equal(result.entries.length, 1)
  assert.equal(result.stats.last24h, expected.length)
  assert.equal(result.stats.tokens24h, expected.length * 180)
  assert.equal(result.breakdown.byModel[0].requests, expected.length)
  assert.equal(result.breakdown.byHour.reduce((sum, bucket) => sum + bucket.requests, 0), expected.length)
  assert.equal(result.stats.until, until)
  assert.equal(result.breakdown.bucketEnd, until)
  assert.equal(result.until, until)
  assert.equal(result.stats.retainedLog.scope, 'retained-logs')
  assert.equal(result.stats.retainedLog.permanent, false)
  assert.equal(result.stats.allTimeRequests, result.stats.retainedLog.requests)
  assert.equal(log.query({ until, hours: 1, model: 'old' }).total, 0)
  assert.equal(log.query({ until, hours: 1, model: 'old' }).stats.retainedLog.requests, 1)
})

test('query boundaries, stable ordering, search, nulls and integer pagination', () => {
  const log = new RequestLog({ persist: false })
  const until = 1800000000000
  log.entries = [
    row('z', until - 20, { ms: 20, totalTokens: 10, ttftMs: null }),
    row('a', until - 20, { ms: 20, totalTokens: 30, ttftMs: null }),
    row('b', until - 21, { ms: null, totalTokens: null, ttftMs: null }),
    row('edge', until - 3600000, { ms: 5, status: 503, errorType: 'transport_error' }),
    row('too-old', until - 3600001), row('future', until + 1),
  ]
  const desc = log.query({ until, hours: 1, sort: 'ms', order: 'desc' })
  assert.deepEqual(desc.entries.map((entry) => entry.id), ['a', 'z', 'edge', 'b'])
  assert.deepEqual(log.query({ until, hours: 1, sort: 'ms', order: 'asc' }).entries.map((entry) => entry.id), ['edge', 'a', 'z', 'b'])
  assert.equal(log.query({ until, hours: 1, status: 'success' }).total, 3)
  assert.equal(log.query({ until, hours: 1, q: 'TRANSPORT_ERROR' }).entries[0].id, 'edge')
  const page1 = log.query({ until, hours: 1, sort: 'ms', page: 1, pageSize: 2.9 })
  const page2 = log.query({ until, hours: 1, sort: 'ms', page: 2.8, pageSize: 2.9 })
  assert.equal(page2.page, 2)
  assert.equal(page2.pageSize, 2)
  assert.deepEqual([...page1.entries, ...page2.entries].map((entry) => entry.id), desc.entries.map((entry) => entry.id))
  assert.equal(log.query({ until, hours: 1, sort: 'totalTokens' }).entries[0].id, 'edge')
  assert.equal(log.query({ until, hours: 1, page: Infinity, pageSize: 9999 }).pageSize, 100)
  assert.equal(log.query({ until, q: 'no match', page: 999 }).page, 1)
  log.entries.reverse()
  assert.deepEqual(log.query({ until, hours: 1, sort: 'ms' }).entries.map((entry) => entry.id), desc.entries.map((entry) => entry.id))
})

test('fixed snapshot excludes requests completed after until without changing rows or aggregates', (t) => {
  const { configPath } = fixture(t)
  const until = 1800000000000
  let now = until - 1000
  t.mock.method(Date, 'now', () => now)
  const log = new RequestLog({ configPath })
  finish(log, 'already-finished')
  log.begin({ id: 'late-completion', model: 'm', stream: true })
  now = until
  const before = log.query({ until })
  assert.deepEqual(before.entries.map((entry) => entry.id), ['already-finished'])
  now = until + 1000
  log.finish('late-completion', { usage: { completion_tokens: 100, total_tokens: 100 } })
  assert.deepEqual(log.query({ until }), before)
  assert.deepEqual(JSON.parse(JSON.stringify(new RequestLog({ configPath }).query({ until }))), JSON.parse(JSON.stringify(before)))
  assert.equal(log.query().total, 2, 'live queries retain the completed request')
  assert.equal(log.query({ until: now }).total, 2, 'completion exactly at until is included')
})

test('legacy retained date bounds do not exceed function argument limits', (t) => {
  const { dir, configPath } = fixture(t)
  const until = Date.now()
  const oldest = until - 48 * 3600000
  const count = 140000
  writeRows(join(dir, 'requests.jsonl'), Array.from({ length: count }, (_, index) => ({ id: `old-${index}`, at: oldest + index, ms: 1, status: 200 })))
  const result = new RequestLog({ configPath, maxEntries: 50 }).query({ until, hours: 1 })
  assert.equal(result.total, 0)
  assert.equal(result.stats.retainedLog.requests, count)
  assert.equal(result.stats.retainedLog.oldestAt, oldest)
  assert.equal(result.stats.retainedLog.newestAt, oldest + count - 1)
})

test('nearest-rank P95 and throughput use matching valid samples globally and per model', () => {
  const log = new RequestLog({ persist: false })
  const until = Date.now()
  log.entries = [
    row('measured', until - 2000, { ms: 1000, ttftMs: 200, completionTokens: 80 }),
    row('missing', until - 2000, { ms: 2000, ttftMs: null, completionTokens: 1000 }),
    row('zero-ttft', until - 2000, { ms: 100, ttftMs: 0, completionTokens: 10 }),
    row('invalid', until - 2000, { ms: 10, ttftMs: 20, completionTokens: 3 }),
    row('no-usage', until - 2000, { ms: 900, ttftMs: 100, completionTokens: null }),
    row('no-duration', until - 2000, { ms: null, ttftMs: null, completionTokens: 100 }),
  ]
  const result = log.query({ until })
  assert.equal(result.stats.p95Ms, 2000)
  assert.equal(result.stats.p50Ms, 900)
  assert.equal(result.stats.latencySamples, 5)
  assert.equal(result.stats.outputTps, 100)
  assert.equal(result.stats.outputTpsSamples, 2)
  assert.equal(result.stats.endToEndTpsSamples, 4)
  assert.equal(result.stats.ttftSamples, 3)
  assert.equal(result.stats.endToEndTps, Math.round(1093 * 1000 / 3110 * 10) / 10)
  const model = result.breakdown.byModel[0]
  for (const key of ['outputTps', 'outputTpsSamples', 'endToEndTps', 'endToEndTpsSamples', 'ttftSamples', 'averageMs', 'p95Ms', 'latencySamples']) assert.equal(model[key], result.stats[key], key)
  assert.equal(timingMetrics({ ms: 1000, completionTokens: 100, ttftMs: null }).outputTps, null)
  assert.equal(timingMetrics({ ms: 1000, completionTokens: 100, ttftMs: null }).endToEndTps, 100)
  assert.equal(timingMetrics({ ms: 1000, completionTokens: 100, ttftMs: '' }).hasTtft, false)
  assert.equal(timingMetrics({ ms: 1000, completionTokens: 100, ttftMs: 1000 }).outputTps, null)
  assert.equal(timingMetrics({ ms: 1000, completionTokens: 100, firstTokenMs: 200 }).outputTps, 125)
  assert.equal(timingMetrics({ ms: '1000', completionTokens: '80', ttftMs: '200' }).outputTps, 100)
  const empty = new RequestLog({ persist: false }).query({ until })
  assert.equal(empty.stats.outputTps, null)
  assert.equal(empty.stats.endToEndTps, null)
  assert.equal(empty.stats.averageMs, null)
  assert.equal(empty.stats.outputTpsSamples, 0)
})

test('finish stores response headers, body byte, TTFT version and safe attempt details independently', (t) => {
  const { dir, configPath } = fixture(t)
  const log = new RequestLog({ configPath })
  const at = Date.now() - 2000
  log.begin({ id: 'new', model: 'm', stream: true })
  log.active.get('new').at = at
  const attempts = [{ index: 1, accountId: 'a', action: 'chat', status: null, durationMs: 300, errorType: 'timeout', traceId: 'trace-1', body: 'SECRET', message: 'SECRET', headers: { authorization: 'SECRET' } }]
  log.finish('new', { marks: { responseHeadersAt: at + 100, firstByteAt: at + 200, firstTokenAt: at + 500 }, attempts, errorType: 'timeout' })
  const entry = log.page().entries[0]
  assert.equal(entry.responseHeadersMs, 100)
  assert.equal(entry.firstByteMs, 200)
  assert.equal(entry.ttftMs, 500)
  assert.equal(entry.timingVersion, 2)
  assert.equal(entry.firstByteMeaning, 'body_byte')
  assert.equal(entry.hasTtft, true)
  assert.deepEqual(entry.attempts, [{ index: 1, status: null, durationMs: 300, accountId: 'a', errorType: 'timeout', traceId: 'trace-1', action: 'chat' }])
  assert.equal(entry.errorType, 'timeout')
  assert.ok(!readFileSync(join(dir, 'requests.jsonl'), 'utf8').includes('SECRET'))
  log.entries.push(row('legacy', at, { firstByteMs: 5, ttftMs: 50 }))
  const legacy = log.page().entries.find((item) => item.id === 'legacy')
  assert.equal(legacy.firstByteMeaning, 'historical_response_headers')
  assert.equal(legacy.timingVersion, 1)
  assert.equal(legacy.responseHeadersMs, null)
  assert.equal(legacy.hasTtft, true)
  finish(log, 'no-marks')
  const missing = log.page().entries[0]
  assert.equal(missing.ttftMs, null)
  assert.equal(missing.responseHeadersMs, null)
  assert.equal(missing.hasTtft, false)
  assert.equal(missing.outputTps, null)
})

test('legacy gaps, malformed rows, duplicate ids and markers survive restart without mutation', (t) => {
  const { dir, configPath } = fixture(t)
  const now = Date.now()
  writeRows(join(dir, 'requests.jsonl.2'), [row('old', now), row('duplicate', now, { totalTokens: 1 }), '{broken', { flushed: true }, null, { id: 'missing-at' }])
  writeRows(join(dir, 'requests.jsonl.9'), [row('latest', now), row('duplicate', now, { totalTokens: 2 })])
  const before = readFileSync(join(dir, 'requests.jsonl.2'), 'utf8')
  const log = new RequestLog({ configPath })
  assert.equal(log.query().total, 3)
  assert.equal(log.query().entries.find((entry) => entry.id === 'duplicate').totalTokens, 2)
  assert.equal(readFileSync(join(dir, 'requests.jsonl.2'), 'utf8'), before)
  finish(log, 'after-restart')
  assert.ok(readFileSync(join(dir, 'requests.jsonl'), 'utf8').includes('after-restart'))
  assert.equal(new RequestLog({ configPath }).query().total, 4)
  assert.deepEqual(new RequestLog({ configPath }).query().entries.map((entry) => entry.id), log.query().entries.map((entry) => entry.id))
})

test('append after a truncated legacy tail preserves existing bytes and writes a readable new row', (t) => {
  const { dir, configPath } = fixture(t)
  const path = join(dir, 'requests.jsonl')
  const original = `${JSON.stringify(row('kept', Date.now()))}\n{"id":"truncated"`
  writeFileSync(path, original)
  const log = new RequestLog({ configPath })
  finish(log, 'after-partial')
  assert.ok(readFileSync(path, 'utf8').startsWith(original))
  assert.equal(new RequestLog({ configPath }).query().total, 2)
  assert.deepEqual(new Set(new RequestLog({ configPath }).query().entries.map((entry) => entry.id)), new Set(['kept', 'after-partial']))
})

test('multiple rotations remain bounded, append to active base and have identical restart totals', (t) => {
  const { dir, configPath } = fixture(t)
  const log = new RequestLog({ configPath, maxEntries: 5000 })
  // Test-only threshold adjustment keeps the fixture small while exercising four rotations.
  log.segmentBytes = 1200
  for (let i = 0; i < 30; i++) finish(log, `request-${i}`)
  const names = readdirSync(dir).filter((name) => /^requests\.jsonl(?:\.\d+)?$/.test(name))
  assert.equal(names.length, 3)
  assert.ok(names.includes('requests.jsonl'))
  assert.ok(log.segment >= 4)
  assert.ok(readFileSync(join(dir, 'requests.jsonl'), 'utf8').includes('request-29'))
  const restarted = new RequestLog({ configPath, maxEntries: 5000 })
  assert.equal(restarted.query().total, log.query().total)
  assert.deepEqual(restarted.query().entries.map((entry) => entry.id), log.query().entries.map((entry) => entry.id))
  assert.ok(!log.query().entries.some((entry) => entry.id === 'request-0'))
})

test('clear removes only exact retained log files and does not resurrect rows after restart', (t) => {
  const { dir, configPath } = fixture(t)
  const now = Date.now()
  for (const name of ['requests.jsonl', 'requests.jsonl.2', 'requests.jsonl.100']) writeRows(join(dir, name), [row(name, now)])
  for (const name of ['requests.jsonl.backup', 'requests.jsonl.1.bak', 'requests.jsonl-other', 'config.json']) writeFileSync(join(dir, name), 'KEEP')
  const log = new RequestLog({ configPath })
  log.begin({ id: 'inflight', model: 'm' })
  log.clear()
  log.finish('inflight')
  assert.equal(log.query().total, 0)
  assert.equal(new RequestLog({ configPath }).query().total, 0)
  assert.equal(readFileSync(join(dir, 'requests.jsonl'), 'utf8'), '')
  for (const name of ['requests.jsonl.backup', 'requests.jsonl.1.bak', 'requests.jsonl-other', 'config.json']) assert.equal(readFileSync(join(dir, name), 'utf8'), 'KEEP')
  finish(log, 'fresh')
  assert.deepEqual(new RequestLog({ configPath }).query().entries.map((entry) => entry.id), ['fresh'])
  const nonpersistent = new RequestLog({ configPath, persist: false })
  nonpersistent.clear()
  nonpersistent.flushNow()
  assert.equal(new RequestLog({ configPath }).query().total, 1)
})

test('symlink log targets are never read, truncated, rotated or removed', (t) => {
  const { dir, configPath } = fixture(t)
  const protectedPath = join(dir, 'protected.txt')
  writeFileSync(protectedPath, 'KEEP')
  symlinkSync(protectedPath, join(dir, 'requests.jsonl'))
  symlinkSync(protectedPath, join(dir, 'requests.jsonl.1'))
  const log = new RequestLog({ configPath })
  finish(log, 'attempt')
  assert.throws(() => log.clear(), /regular file/)
  assert.equal(readFileSync(protectedPath, 'utf8'), 'KEEP')
  assert.ok(lstatSync(join(dir, 'requests.jsonl')).isSymbolicLink())
  assert.ok(lstatSync(join(dir, 'requests.jsonl.1')).isSymbolicLink())
})

test('wide-window small explicit buckets retain all requests within a bounded chart', () => {
  const log = new RequestLog({ persist: false })
  const until = Date.now()
  log.entries = [row('old', until - 71 * 3600000), row('new', until - 1000)]
  const result = log.query({ hours: 72, until, bucketMs: 1000 })
  assert.ok(result.breakdown.buckets <= 288)
  assert.equal(result.breakdown.byHour.reduce((sum, bucket) => sum + bucket.requests, 0), 2)
  assert.equal(result.breakdown.byModel[0].requests, 2)
  assert.equal(result.stats.total, 2)
})
