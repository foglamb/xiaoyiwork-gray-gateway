import assert from 'node:assert/strict'
import test from 'node:test'
import { RequestLog, timingMetrics } from '../src/requestlog.mjs'

const until = 1800000000000
function record(id, fields = {}) {
  return { id, at: until - 10000, model: 'm', ms: 1000, status: 200, ...fields }
}
function query(entries) {
  const log = new RequestLog({ persist: false })
  log.entries = entries
  return log.query({ until, hours: 1 })
}

const cacheKeys = ['cacheHitRate', 'cacheHitSamples', 'cacheHitPromptTokens', 'cacheHitCachedTokens']
function assertCache(summary, expected) {
  for (const key of cacheKeys) assert.equal(summary[key], expected[key], key)
}

test('historical firstByte values are header samples and never body samples', () => {
  const result = query([record('old', { firstByteMs: 100 }), record('old-2', { firstByteMs: 300, timingVersion: 1 })])
  for (const summary of [result.stats, result.breakdown.byModel[0]]) {
    assert.equal(summary.averageFirstByteMs, null)
    assert.equal(summary.firstByteSamples, 0)
    assert.equal(summary.averageResponseHeadersMs, 200)
    assert.equal(summary.responseHeadersSamples, 2)
    assert.equal(summary.legacyResponseHeadersSamples, 2)
  }
  assert.equal(result.entries[0].firstByteMeaning, 'historical_response_headers')
  assert.equal(result.entries[0].responseHeadersMs, null, 'inferred header aggregate does not fabricate stored header fields')
})

test('mixed timing versions separate header and body samples and prefer explicit headers', () => {
  const result = query([
    record('old', { firstByteMs: 100 }),
    record('new', { timingVersion: 2, firstByteMs: 900, responseHeadersMs: 200, ttftMs: 950 }),
    record('old-explicit-header', { firstByteMs: 800, responseHeadersMs: 300 }),
    record('new-zero', { timingVersion: 2, firstByteMs: 0, responseHeadersMs: 0, ttftMs: 0 }),
  ])
  for (const summary of [result.stats, result.breakdown.byModel[0]]) {
    assert.equal(summary.averageFirstByteMs, 450)
    assert.equal(summary.firstByteSamples, 2)
    assert.equal(summary.averageResponseHeadersMs, 150)
    assert.equal(summary.responseHeadersSamples, 4)
    assert.equal(summary.legacyResponseHeadersSamples, 1)
    assert.equal(summary.averageFirstTokenMs, 475)
    assert.equal(summary.firstTokenSamples, 2)
    assert.equal(summary.ttftSamples, 2)
  }
})

test('negative, missing and out-of-range timing values cannot become latency samples', () => {
  const entries = [null, undefined, '', -1, 1001, Infinity].map((value, index) => record(`bad-${index}`, {
    timingVersion: 2, firstByteMs: value, responseHeadersMs: value, firstTokenMs: value, ttftMs: value,
  }))
  entries.push(record('negative-total', { ms: -1, timingVersion: 2, firstByteMs: 0, responseHeadersMs: 0, ttftMs: 0 }))
  const result = query(entries)
  assert.equal(result.stats.firstByteSamples, 0)
  assert.equal(result.stats.responseHeadersSamples, 0)
  assert.equal(result.stats.firstTokenSamples, 0)
  assert.equal(result.stats.averageFirstByteMs, null)
  assert.equal(result.stats.averageResponseHeadersMs, null)
  for (const entry of result.entries) {
    assert.equal(entry.firstByteMs, null)
    assert.equal(entry.responseHeadersMs, null)
    assert.equal(entry.ttftMs, null)
    assert.equal(entry.firstByteMeaning, null)
    assert.equal(entry.hasTtft, false)
  }
  assert.equal(timingMetrics({ ms: -1, ttftMs: 0 }).hasTtft, false)
})

test('available legacy duration measurements remain usable when total duration is unknown', () => {
  const result = query([record('legacy', { ms: null, firstByteMs: 10, firstTokenMs: 20 })])
  assert.equal(result.stats.averageFirstByteMs, null)
  assert.equal(result.stats.averageResponseHeadersMs, 10)
  assert.equal(result.stats.averageFirstTokenMs, 20)
  assert.equal(result.entries[0].hasTtft, true)
  assert.equal(result.entries[0].outputTps, null)
})

test('cache hits use only complete valid prompt/cache pairs in KPIs, models and buckets', () => {
  const result = query([
    record('hit', { promptTokens: 100, cachedTokens: 100 }),
    record('miss', { promptTokens: 100, cachedTokens: 0 }),
    record('unknown', { promptTokens: 900, cachedTokens: null }),
    record('no-prompt', { promptTokens: null, cachedTokens: 100 }),
    record('negative-cache', { promptTokens: 100, cachedTokens: -1 }),
    record('negative-prompt', { promptTokens: -1, cachedTokens: 0 }),
    record('over-prompt', { promptTokens: 100, cachedTokens: 101 }),
    record('no-usage'),
  ])
  const expected = { cacheHitRate: 50, cacheHitSamples: 2, cacheHitPromptTokens: 200, cacheHitCachedTokens: 100 }
  assertCache(result.stats, expected)
  assertCache(result.breakdown.byModel[0], expected)
  assertCache(result.breakdown.byHour.find((bucket) => bucket.requests), expected)
  for (const bucket of result.breakdown.byHour.filter((bucket) => !bucket.requests)) {
    assertCache(bucket, { cacheHitRate: null, cacheHitSamples: 0, cacheHitPromptTokens: 0, cacheHitCachedTokens: 0 })
  }
})

test('unknown cache and zero-token samples do not fabricate a rate; measured zero hits do', () => {
  for (const fields of [{}, { promptTokens: 100 }, { promptTokens: 100, cachedTokens: null }, { promptTokens: null, cachedTokens: 10 }]) {
    const result = query([record('unknown', fields)])
    assertCache(result.stats, { cacheHitRate: null, cacheHitSamples: 0, cacheHitPromptTokens: 0, cacheHitCachedTokens: 0 })
  }
  assertCache(query([record('zero', { promptTokens: 0, cachedTokens: 0 })]).stats,
    { cacheHitRate: null, cacheHitSamples: 1, cacheHitPromptTokens: 0, cacheHitCachedTokens: 0 })
  assertCache(query([record('measured-miss', { promptTokens: 50, cachedTokens: 0 })]).stats,
    { cacheHitRate: 0, cacheHitSamples: 1, cacheHitPromptTokens: 50, cacheHitCachedTokens: 0 })
})

test('cache sample totals reconcile across models and buckets with missing historical data', () => {
  const result = query([
    record('a', { model: 'a', at: until - 1800000, promptTokens: 100, cachedTokens: 50 }),
    record('b', { model: 'b', promptTokens: '200', cachedTokens: '200' }),
    record('old', { model: 'a', at: until - 1800000, promptTokens: 900 }),
  ])
  assertCache(result.stats, { cacheHitRate: 83.3, cacheHitSamples: 2, cacheHitPromptTokens: 300, cacheHitCachedTokens: 250 })
  for (const list of [result.breakdown.byModel, result.breakdown.byHour]) {
    for (const key of cacheKeys.filter((key) => key !== 'cacheHitRate')) assert.equal(list.reduce((sum, row) => sum + row[key], 0), result.stats[key])
  }
  const log = new RequestLog({ persist: false })
  log.entries = [record('kept', { promptTokens: 100, cachedTokens: 50, firstByteMs: 200 })]
  const before = JSON.stringify(log.entries)
  log.query({ until })
  assert.equal(JSON.stringify(log.entries), before, 'normalization does not rewrite historical records')
})
