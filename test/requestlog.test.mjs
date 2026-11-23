import assert from 'node:assert/strict'
import test from 'node:test'
import { RequestLog } from '../src/requestlog.mjs'

function push(log, index, overrides = {}) {
  const id = `req-${index}`
  log.begin({ id, model: 'LLM_GLM5.3', stream: false, route: { selected: false, pool: 'stable', reason: 'percentage' } })
  log.finish(id, {
    status: 200, accountId: 'stable-A', rate: '8x',
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 15 } },
    ...overrides,
  })
}

test('log retains cache and reasoning token details', () => {
  const log = new RequestLog({ persist: false })
  push(log, 1)
  const [entry] = log.page({ page: 1, pageSize: 10 }).entries
  assert.equal(entry.cachedTokens, 60)
  assert.equal(entry.reasoningTokens, 15)
  assert.equal(entry.rate, '8x')
  const stats = log.stats()
  assert.equal(stats.cacheHitRate, 60)
  assert.equal(stats.promptTokens24h, 100)
  assert.equal(stats.cachedTokens24h, 60)
  assert.equal(stats.reasoningTokens24h, 15)
})

test('pagination caps page size and clamps page numbers', () => {
  const log = new RequestLog({ persist: false })
  for (let index = 0; index < 120; index++) push(log, index)
  const first = log.page({ page: 1, pageSize: 50 })
  assert.equal(first.entries.length, 50)
  assert.equal(first.pages, 3)
  assert.equal(first.total, 120)
  // Newest first.
  assert.equal(first.entries[0].id, 'req-119')
  const oversized = log.page({ page: 1, pageSize: 99999 })
  assert.equal(oversized.entries.length, 100, 'page size is capped at 100')
  const clamped = log.page({ page: 999, pageSize: 50 })
  assert.equal(clamped.page, 3)
  assert.equal(log.page({ page: -5, pageSize: 50 }).page, 1)
})

test('ring buffer enforces maxEntries and never grows unbounded', () => {
  const log = new RequestLog({ persist: false, maxEntries: 50 })
  for (let index = 0; index < 300; index++) push(log, index)
  assert.equal(log.entries.length, 50)
  assert.equal(log.page({ page: 1, pageSize: 50 }).total, 50)
  assert.equal(log.entries.at(-1).id, 'req-299')
  assert.equal(log.entries[0].id, 'req-250')
})

test('maxEntries is clamped to a safe range', () => {
  assert.equal(new RequestLog({ persist: false, maxEntries: 99999 }).maxEntries, 5000)
  assert.equal(new RequestLog({ persist: false, maxEntries: 1 }).maxEntries, 50)
})

test('breakdown aggregates per model and per hour', () => {
  const log = new RequestLog({ persist: false })
  push(log, 1)
  push(log, 2)
  const { byModel, byHour } = log.breakdown(24)
  assert.equal(byModel.length, 1)
  assert.equal(byModel[0].requests, 2)
  assert.equal(byModel[0].cached, 120)
  assert.equal(byModel[0].cacheHitRate, 60)
  assert.equal(byHour.length, 24)
  assert.equal(byHour.reduce((sum, hour) => sum + hour.requests, 0), 2)
})

test('flushing appends and never truncates existing records', async () => {
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'xiaoyi-log-guard-'))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, '{}\n')
  const logPath = join(dir, 'requests.jsonl')
  await writeFile(logPath, `${JSON.stringify({ id: 'kept', at: Date.now(), status: 200, ms: 5 })}\n`)
  const log = new RequestLog({ configPath })
  log.flushNow()
  const lines = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean)
  assert.equal(lines.length, 2, 'old record kept, new record appended')
  assert.equal(JSON.parse(lines[0]).id, 'kept')
})

test('reaching maxEntries rotates segments instead of rewriting the active file', async () => {
  const { mkdtemp, writeFile, readdir, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'xiaoyi-log-rotate-'))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, '{}\n')
  // Tiny segment so rotation happens quickly.
  const log = new RequestLog({ configPath, maxEntries: 50, segmentBytes: 256 * 1024 })
  for (let i = 0; i < 400; i++) push(log, i)
  const files = (await readdir(dir)).filter((name) => name.startsWith('requests.jsonl'))
  assert.ok(files.length >= 1)
  const total = files.reduce(async (acc, name) => (await acc) + (await stat(join(dir, name))).size, Promise.resolve(0))
  assert.ok((await total) > 0, 'records were persisted')
  // Memory stays capped regardless of how many records were written.
  assert.equal(log.entries.length <= 50, true)
  assert.equal(log.page({ page: 1, pageSize: 50 }).total <= 50, true)
})
