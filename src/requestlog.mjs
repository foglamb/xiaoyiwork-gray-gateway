import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export class RequestLog {
  constructor({ configPath = null, maxEntries = 1000, persist = true, segmentBytes = 4 * 1024 * 1024 } = {}) {
    this.dir = configPath ? resolve(dirname(configPath)) : null
    this.path = this.dir ? resolve(this.dir, 'requests.jsonl') : null
    this.maxEntries = clampInteger(maxEntries, 1000, 50, 5000)
    this.segmentBytes = clampInteger(segmentBytes, 4 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024)
    this.pageSize = 100
    this.persist = persist && Boolean(this.path)
    this.entries = []
    this.active = new Map()
    this.onFlush = null
    this.segment = 0
    this.needsSeparator = false
    if (this.persist) this.#load()
  }

  setMaxEntries(value) {
    this.maxEntries = clampInteger(value, 1000, 50, 5000)
    this.entries = this.entries.slice(-this.maxEntries)
    return this.maxEntries
  }

  // Validate the resolved absolute target and reject symlinks before file mutation.
  #logPath(name) {
    if (!/^requests\.jsonl(?:\.[1-9]\d*)?$/.test(name)) throw new Error('Invalid request log filename')
    const target = resolve(this.dir, name)
    if (dirname(target) !== this.dir) throw new Error('Request log outside configured directory')
    try {
      if (!lstatSync(target).isFile()) throw new Error('Request log must be a regular file')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return target
  }

  #files() {
    if (!this.dir) return []
    try {
      return readdirSync(this.dir).filter((name) => /^requests\.jsonl(?:\.[1-9]\d*)?$/.test(name))
        .flatMap((name) => {
          try {
            const path = this.#logPath(name)
            return [{ name, path, index: name === 'requests.jsonl' ? Infinity : Number(name.slice(15)) }]
          } catch { return [] }
        }).sort((a, b) => a.index - b.index)
    } catch { return [] }
  }

  #load() {
    // Legacy deployments may have only numbered files, with gaps after pruning.
    const files = this.#files()
    this.segment = Math.max(0, ...files.filter((file) => Number.isFinite(file.index)).map((file) => file.index))
    this.entries = this.#allEntries().slice(-this.maxEntries)
    const active = files.find((file) => file.name === 'requests.jsonl')
    if (active) {
      try {
        const text = readFileSync(active.path, 'utf8')
        this.needsSeparator = text.length > 0 && !text.endsWith('\n')
      } catch { /* The append path remains best-effort. */ }
    }
  }

  #rotate() {
    const active = this.#logPath('requests.jsonl')
    if (!existsSync(active) || lstatSync(active).size < this.segmentBytes) return
    let next = this.segment + 1
    while (existsSync(resolve(this.dir, `requests.jsonl.${next}`))) next++
    const archive = this.#logPath(`requests.jsonl.${next}`)
    renameSync(active, archive)
    this.needsSeparator = false
    this.segment = next
    // Active file plus two archives. Prune by actual filenames, never by contiguous indexes.
    const archives = this.#files().filter((file) => Number.isFinite(file.index))
    const obsolete = archives.slice(0, -2)
    for (const file of obsolete) unlinkSync(this.#logPath(file.name))
    return obsolete.length > 0
  }

  #appendLine(record) {
    if (!this.persist) return
    try {
      const pruned = this.#rotate()
      appendFileSync(this.#logPath('requests.jsonl'), `${this.needsSeparator ? '\n' : ''}${JSON.stringify(record)}\n`, { mode: 0o600 })
      this.needsSeparator = false
      if (pruned) this.entries = this.#allEntries({ includeMemory: false }).slice(-this.maxEntries)
    } catch { /* A storage failure must not interrupt a response. */ }
  }

  #store(entry) {
    if (this.onFlush) {
      Promise.resolve(this.onFlush(this.entries)).catch(() => {})
      return
    }
    this.#appendLine(entry)
  }

  begin({ id, model, stream, route = {}, accountId }) {
    const entry = {
      id, at: Date.now(), model: String(model || '').slice(0, 100), stream: Boolean(stream),
      route: route.selected ? 'gray' : 'stable', pool: route.pool, reason: route.reason,
      accountId: '', accountLabel: String(accountId || '').slice(0, 80), status: 'pending', ms: null,
      promptTokens: null, completionTokens: null, totalTokens: null,
      cachedTokens: null, reasoningTokens: null, rate: null, error: '', errorType: '', attempts: null,
      timingVersion: 2, responseHeadersMs: null, firstByteMs: null, firstTokenMs: null, ttftMs: null,
    }
    this.active.set(id, entry)
    return entry
  }

  finish(id, { status = 200, usage, error = '', accountId, rate = null, marks = null, attempts = null, errorType = '', responseHeadersMs = null } = {}) {
    const entry = this.active.get(id)
    if (!entry) return
    this.active.delete(id)
    if (accountId) entry.accountId = String(accountId).slice(0, 80)
    delete entry.accountLabel
    entry.status = status
    entry.ms = Math.max(0, Date.now() - entry.at)
    entry.promptTokens = numberOrNull(usage?.prompt_tokens)
    entry.completionTokens = numberOrNull(usage?.completion_tokens)
    entry.totalTokens = numberOrNull(usage?.total_tokens)
    entry.cachedTokens = numberOrNull(usage?.prompt_tokens_details?.cached_tokens)
    entry.reasoningTokens = numberOrNull(usage?.completion_tokens_details?.reasoning_tokens)
    entry.rate = rate || null
    const elapsed = (mark) => {
      const value = numberOrNull(mark)
      return value !== null && value >= entry.at && value <= entry.at + entry.ms ? value - entry.at : null
    }
    entry.responseHeadersMs = elapsed(marks?.responseHeadersAt) ?? validDuration(responseHeadersMs, entry.ms)
    entry.firstByteMs = elapsed(marks?.firstByteAt)
    entry.firstTokenMs = elapsed(marks?.firstTokenAt)
    entry.ttftMs = entry.firstTokenMs
    entry.attempts = normalizeAttempts(attempts)
    entry.errorType = String(errorType || '').slice(0, 80)
    // Never record response bodies, headers, or arbitrary attempt objects.
    entry.error = redact(error, 160)
    this.entries.push(entry)
    this.entries = this.entries.slice(-this.maxEntries)
    this.#store(entry)
  }

  /** Compatibility API: newest-first pages of the bounded memory ring. */
  page({ page = 1, pageSize = 50 } = {}) {
    return { ...paginate([...this.entries].reverse().map(normalizeEntry), page, pageSize, this.pageSize), maxEntries: this.maxEntries }
  }

  recent(limit = 100) {
    return this.entries.slice(-clampInteger(limit, 100, 1, 500)).reverse()
  }

  /** Append-only test seam; marker rows are excluded from requests and statistics. */
  flushNow() {
    this.#appendLine({ flushed: true })
  }

  clear() {
    if (this.persist) {
      // Validate all destinations first. Only exact log filenames can be removed.
      const active = this.#logPath('requests.jsonl')
      const archives = this.#files().filter((file) => Number.isFinite(file.index))
      for (const file of archives) unlinkSync(this.#logPath(file.name))
      writeFileSync(active, '', { mode: 0o600 })
    }
    this.entries = []
    this.active.clear()
    this.segment = 0
    this.needsSeparator = false
  }

  #allEntries({ includeMemory = true } = {}) {
    const records = []
    if (this.persist) {
      for (const file of this.#files()) {
        try {
          for (const line of readFileSync(file.path, 'utf8').split('\n')) {
            try { records.push(JSON.parse(line)) } catch { /* Ignore partial or malformed lines. */ }
          }
        } catch { /* Unreadable segments must not hide the other segments. */ }
      }
    }
    if (includeMemory) records.push(...this.entries)
    const seen = new Set()
    const out = []
    // Newest record wins, including the in-memory copy of a just-finished request.
    for (let index = records.length - 1; index >= 0; index--) {
      const entry = records[index]
      if (!entry || entry.flushed || numberOrNull(entry.at) === null) continue
      const key = entry.id ? `id:${entry.id}` : `row:${JSON.stringify(entry)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
    return out.reverse()
  }

  modelIds() {
    return [...new Set(this.#allEntries().map((entry) => entry.model).filter(Boolean))]
  }

  /** One retained-log snapshot and clock for rows, KPIs, models and chart buckets. */
  query({ page = 1, pageSize = 50, hours = 24, model = '', accountId = '', status = 'all', q = '', sort = 'at', order = 'desc', until, bucketMs = null } = {}) {
    const windowHours = windowSize(hours)
    const snapshotUntil = numberOrNull(until)
    const now = snapshotUntil ?? Date.now()
    const search = String(q || '').trim().toLowerCase()
    const retained = this.#allEntries().map(normalizeEntry).filter((entry) => {
      if (entry.at > now || (model && entry.model !== model) || (accountId && entry.accountId !== accountId)) return false
      // A request that finishes after a fixed snapshot must not appear on later pages.
      // Legacy rows without any completion timing keep their available start-time bound.
      const completedAt = numberOrNull(entry.completedAt) ?? (entry.ms !== null && entry.ms >= 0 ? entry.at + entry.ms : null)
      if (snapshotUntil !== null && completedAt !== null && completedAt > snapshotUntil) return false
      if (status === 'success' && !(entry.status >= 200 && entry.status < 400)) return false
      if (status === 'error' && !(entry.status >= 400)) return false
      return !search || ['id', 'model', 'accountId', 'status', 'route', 'pool', 'reason', 'error', 'errorType']
        .some((key) => String(entry[key] ?? '').toLowerCase().includes(search))
    })
    const source = retained.filter((entry) => entry.at >= now - windowHours * 3600000)
    const key = ['at', 'ms', 'outputTps', 'totalTokens'].includes(sort) ? sort : 'at'
    const direction = order === 'asc' ? 1 : -1
    const ordered = source.map((entry, index) => ({ entry, index })).sort((a, b) => {
      const left = numberOrNull(a.entry[key])
      const right = numberOrNull(b.entry[key])
      if (left === null && right !== null) return 1
      if (right === null && left !== null) return -1
      return (left !== null && right !== null ? (left - right) * direction : 0)
        || b.entry.at - a.entry.at || String(a.entry.id || '').localeCompare(String(b.entry.id || '')) || a.index - b.index
    }).map(({ entry }) => entry)
    return {
      ...paginate(ordered, page, pageSize, this.pageSize), maxEntries: this.maxEntries,
      stats: summarize(source, retained, windowHours, now),
      breakdown: buildBreakdown(source, windowHours, now, bucketMs), windowHours, until: now,
    }
  }

  stats(hours = 24) {
    return this.query({ hours }).stats
  }

  breakdown(hours = 24, { bucketMs = null } = {}) {
    return this.query({ hours, bucketMs }).breakdown
  }
}

function paginate(entries, page, pageSize, cap) {
  const size = clampInteger(pageSize, 50, 1, cap)
  const total = entries.length
  const pages = Math.max(1, Math.ceil(total / size))
  const index = clampInteger(page, 1, 1, pages)
  return { entries: entries.slice((index - 1) * size, index * size), page: index, pageSize: size, pages, total }
}

function summarize(source, retained, windowHours, until) {
  const durations = source.map((entry) => numberOrNull(entry.ms)).filter((value) => value !== null && value >= 0)
  const completed = source.filter((entry) => entry.status >= 200)
  const failed = source.filter((entry) => entry.status >= 400)
  const promptTokens = sum(source, 'promptTokens')
  const cachedTokens = sum(source, 'cachedTokens')
  const dates = retained.reduce((bounds, entry) => ({
    oldestAt: bounds.oldestAt === null ? entry.at : Math.min(bounds.oldestAt, entry.at),
    newestAt: bounds.newestAt === null ? entry.at : Math.max(bounds.newestAt, entry.at),
  }), { oldestAt: null, newestAt: null })
  const retainedLog = {
    scope: 'retained-logs', permanent: false, requests: retained.length,
    tokens: sum(retained, 'totalTokens'), promptTokens: sum(retained, 'promptTokens'),
    completionTokens: sum(retained, 'completionTokens'),
    ...dates,
  }
  return {
    total: source.length, last24h: source.length, failed24h: failed.length,
    successRate: completed.length ? Math.round((1 - failed.length / completed.length) * 1000) / 10 : null,
    averageMs: average(durations), p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95),
    averageResponseHeadersMs: average(source.map((entry) => entry.responseHeadersMs).filter(Number.isFinite)),
    averageFirstByteMs: average(source.map((entry) => entry.firstByteMs).filter(Number.isFinite)),
    averageFirstTokenMs: average(source.filter((entry) => entry.hasTtft).map((entry) => entry.ttftMs)),
    ...speedSummary(source), latencySamples: durations.length,
    tokens24h: sum(source, 'totalTokens'), promptTokens24h: promptTokens,
    completionTokens24h: sum(source, 'completionTokens'), cachedTokens24h: cachedTokens,
    reasoningTokens24h: sum(source, 'reasoningTokens'),
    cacheHitRate: promptTokens > 0 ? roundRate(cachedTokens / promptTokens) : null,
    windowHours, until, retainedLog,
    // Compatibility names refer only to retained files, never permanent lifetime counters.
    oldestAt: retainedLog.oldestAt, newestAt: retainedLog.newestAt,
    allTimeRequests: retainedLog.requests, allTimeTokens: retainedLog.tokens,
    allTimePromptTokens: retainedLog.promptTokens, allTimeCompletionTokens: retainedLog.completionTokens,
  }
}

function buildBreakdown(source, hours, now, bucketMs) {
  const span = hours * 3600000
  const populated = new Set(source.map((entry) => Math.floor(entry.at / 3600000)))
  const adaptive = populated.size <= 2 ? 5 * 60000 : populated.size <= 8 ? 15 * 60000 : 3600000
  const explicit = numberOrNull(bucketMs)
  const width = Math.max(explicit > 0 ? explicit : adaptive, Math.ceil(span / 288))
  const count = Math.max(1, Math.ceil(span / width))
  const start = now - span
  const byHour = Array.from({ length: count }, (_, index) => ({
    at: start + index * width, requests: 0, prompt: 0, completion: 0, cached: 0, reasoning: 0, total: 0, failed: 0,
  }))
  const models = new Map()
  for (const entry of source) {
    const model = entry.model || 'unknown'
    const list = models.get(model) || []
    list.push(entry)
    models.set(model, list)
    const bucket = byHour[Math.min(count - 1, Math.floor((entry.at - start) / width))]
    bucket.requests++
    for (const [target, field] of [['prompt', 'promptTokens'], ['completion', 'completionTokens'], ['cached', 'cachedTokens'], ['reasoning', 'reasoningTokens'], ['total', 'totalTokens']]) bucket[target] += numberOrNull(entry[field]) || 0
    if (entry.status >= 400) bucket.failed++
  }
  let output = byHour
  if (explicit > 0 || hours <= 24) {
    const filled = byHour.map((bucket, index) => bucket.requests ? index : -1).filter((index) => index >= 0)
    if (filled.length && filled.length < count) {
      const padding = Math.max(2, Math.round(count * 0.08))
      output = byHour.slice(Math.max(0, filled[0] - padding), Math.min(count, filled.at(-1) + padding + 1))
    }
  }
  return {
    bucketMs: width, bucketStart: output[0]?.at ?? start, bucketEnd: now, buckets: output.length,
    byModel: [...models].map(([model, entries]) => {
      const metrics = summarize(entries, entries, hours, now)
      return {
        model, requests: entries.length, prompt: sum(entries, 'promptTokens'), completion: sum(entries, 'completionTokens'),
        cached: sum(entries, 'cachedTokens'), reasoning: sum(entries, 'reasoningTokens'), total: sum(entries, 'totalTokens'),
        ms: sum(entries, 'ms'), generationMs: sum(entries.filter((entry) => entry.outputTps !== null), 'generationMs'),
        failed: entries.filter((entry) => entry.status >= 400).length,
        averageMs: metrics.averageMs, p50Ms: metrics.p50Ms, p95Ms: metrics.p95Ms, latencySamples: metrics.latencySamples,
        ...speedSummary(entries), cacheHitRate: metrics.cacheHitRate,
      }
    }).sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model)),
    byHour: output,
    coverage: { requests: source.length, firstRequestAt: byHour.find((bucket) => bucket.requests)?.at ?? null, lastRequestAt: [...byHour].reverse().find((bucket) => bucket.requests)?.at ?? null },
  }
}

function normalizeEntry(entry) {
  const total = numberOrNull(entry.ms)
  const firstToken = validDuration(entry.ttftMs, total) ?? validDuration(entry.firstTokenMs, total)
  return {
    ...entry, at: numberOrNull(entry.at), ms: total,
    ...Object.fromEntries(['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens', 'responseHeadersMs', 'firstByteMs', 'firstTokenMs'].map((key) => [key, numberOrNull(entry[key])])),
    ttftMs: firstToken, timingVersion: entry.timingVersion ?? 1,
    firstByteMeaning: numberOrNull(entry.firstByteMs) === null ? null : entry.timingVersion >= 2 ? 'body_byte' : 'historical_response_headers',
    attempts: normalizeAttempts(entry.attempts), errorType: entry.errorType || '',
    ...timingMetrics({ ...entry, ttftMs: firstToken }),
  }
}

export function timingMetrics(entry) {
  const totalMs = numberOrNull(entry.ms)
  const ttft = validDuration(entry.ttftMs, totalMs) ?? validDuration(entry.firstTokenMs, totalMs)
  const hasTtft = ttft !== null
  const generationMs = totalMs !== null && totalMs > 0 && hasTtft ? totalMs - ttft : null
  const completion = numberOrNull(entry.completionTokens)
  const prompt = numberOrNull(entry.promptTokens)
  return {
    hasTtft, generationMs,
    outputTps: completion > 0 && generationMs > 0 ? roundTps(completion * 1000 / generationMs) : null,
    endToEndTps: completion > 0 && totalMs > 0 ? roundTps(completion * 1000 / totalMs) : null,
    prefillTps: prompt > 0 && ttft > 0 ? roundTps(prompt * 1000 / ttft) : null,
  }
}

function speedSummary(entries) {
  const output = entries.filter((entry) => timingMetrics(entry).outputTps !== null)
  const endToEnd = entries.filter((entry) => timingMetrics(entry).endToEndTps !== null)
  const generation = output.reduce((total, entry) => total + timingMetrics(entry).generationMs, 0)
  return {
    outputTps: generation > 0 ? roundTps(sum(output, 'completionTokens') * 1000 / generation) : null,
    endToEndTps: endToEnd.length ? roundTps(sum(endToEnd, 'completionTokens') * 1000 / sum(endToEnd, 'ms')) : null,
    outputTpsSamples: output.length, endToEndTpsSamples: endToEnd.length,
    ttftSamples: entries.filter((entry) => timingMetrics(entry).hasTtft).length,
  }
}

function normalizeAttempts(value) {
  if (!Array.isArray(value)) return numberOrNull(value)
  return value.slice(0, 100).map((attempt) => {
    if (!attempt || typeof attempt !== 'object') return null
    const result = {}
    for (const key of ['index', 'status', 'durationMs']) {
      if (Object.hasOwn(attempt, key)) result[key] = numberOrNull(attempt[key])
    }
    for (const key of ['accountId', 'errorType', 'traceId']) {
      if (attempt[key] !== undefined) result[key] = String(attempt[key]).slice(0, key === 'traceId' ? 160 : 80)
    }
    if (['chat', 'chat-after-renewal', 'renewal'].includes(attempt.action)) result.action = attempt.action
    return result
  }).filter(Boolean)
}

function redact(value, limit) {
  return value ? String(value).slice(0, limit).replace(/(bearer|credential|token)\s*[:=]?\s*\S+/gi, '$1 [REDACTED]') : ''
}
function validDuration(value, total) {
  const duration = numberOrNull(value)
  return duration !== null && duration >= 0 && (total === null || duration <= total) ? duration : null
}
function sum(entries, key) { return entries.reduce((total, entry) => total + (numberOrNull(entry[key]) || 0), 0) }
function windowSize(hours) { return Math.max(1, Math.min(numberOrNull(hours) || 24, 168)) }
function clampInteger(value, fallback, min, max) { return Math.max(min, Math.min(Math.floor(numberOrNull(value) || fallback), max)) }
function roundTps(value) { return Number.isFinite(value) ? Math.round(value * 10) / 10 : null }
function roundRate(ratio) { const percent = ratio * 100; return percent < 1 ? Math.round(percent * 100) / 100 : Math.round(percent * 10) / 10 }
function average(values) { return values.length ? Math.round(values.reduce((total, value) => total + value, 0) / values.length) : null }
function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)])
}
function numberOrNull(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
