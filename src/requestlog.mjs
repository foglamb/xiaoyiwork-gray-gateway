import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export class RequestLog {
  constructor({ configPath = null, maxEntries = 1000, persist = true, segmentBytes = 4 * 1024 * 1024 } = {}) {
    this.dir = configPath ? resolve(dirname(configPath)) : null
    this.path = configPath ? resolve(dirname(configPath), 'requests.jsonl') : null
    // Hard cap: the in-memory ring buffer and the on-disk file both stay bounded.
    this.maxEntries = Math.max(50, Math.min(Number(maxEntries) || 1000, 5000))
    // Segments are append-only; a full segment is rotated instead of rewritten.
    this.segmentBytes = Math.max(256 * 1024, Math.min(Number(segmentBytes) || 4 * 1024 * 1024, 64 * 1024 * 1024))
    this.pageSize = 100
    this.persist = persist && Boolean(this.path)
    this.entries = []
    this.active = new Map()
    this.onFlush = null
    this.segment = 0
    if (this.persist) this.#load()
  }

  #segmentPath(index) {
    return index === 0 ? this.path : `${this.path}.${index}`
  }

  #load() {
    try {
      // Newest segment wins; earlier segments only fill the tail of the ring buffer.
      let index = 0
      while (existsSync(this.#segmentPath(index + 1))) index++
      this.segment = index
      const lines = readFileSync(this.#segmentPath(index), 'utf8').split('\n').filter(Boolean)
      let parsed = lines.slice(-this.maxEntries)
        .map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
      // Top up from the previous segment when the current one is short.
      if (parsed.length < this.maxEntries && index > 0) {
        const previous = readFileSync(this.#segmentPath(index - 1), 'utf8').split('\n').filter(Boolean)
        const older = previous.slice(-(this.maxEntries - parsed.length))
          .map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
        parsed = [...older, ...parsed]
      }
      this.entries = parsed.slice(-this.maxEntries)
      this.#pruneSegments()
    } catch { /* The first run has no log. A corrupt log must not stop the API. */ }
  }

  /** Keep at most three segments so disk usage stays bounded without rewriting. */
  #pruneSegments() {
    for (const name of readdirSync(this.dir)) {
      const match = /^requests\.jsonl\.(\d+)$/.exec(name)
      if (!match) continue
      if (Number(match[1]) < this.segment - 2) {
        try { unlinkSync(resolve(this.dir, name)) } catch { /* ignore */ }
      }
    }
  }

  /** Rotate instead of rewriting: a full segment starts a new file. */
  #rotate() {
    try {
      const size = this.#fileSize()
      if (size < this.segmentBytes) return false
      this.segment++
      renameSync(this.path, `${this.path}.${this.segment}`)
      this.#pruneSegments()
      return true
    } catch { return false }
  }

  #appendLine(record) {
    try {
      this.#rotate()
      appendFileSync(this.#segmentPath(this.segment), `${JSON.stringify(record)}\n`, { mode: 0o600 })
    } catch { /* ignore */ }
  }

  /**
   * Persist one record. Always append-only: reaching maxEntries must never trigger
   * a whole-file rewrite on the request path (that blocks the event loop and
   * stalls streaming responses).
   */
  #store(entry) {
    if (this.onFlush) {
      Promise.resolve(this.onFlush(this.entries)).catch(() => {})
      return
    }
    if (!this.persist) return
    this.#appendLine(entry)
  }

  begin({ id, model, stream, route, accountId }) {
    const entry = {
      id, at: Date.now(), model: String(model || '').slice(0, 100), stream: Boolean(stream),
      route: route.selected ? 'gray' : 'stable', pool: route.pool, reason: route.reason,
      accountId: '', accountLabel: String(accountId || '').slice(0, 80), status: 'pending', ms: null,
      promptTokens: null, completionTokens: null, totalTokens: null,
      cachedTokens: null, reasoningTokens: null, rate: null, error: '',
      // Latency breakdown: first upstream byte, first streamed token, total.
      firstByteMs: null, firstTokenMs: null, ttftMs: null,
    }
    this.active.set(id, entry)
    return entry
  }

  finish(id, { status = 200, usage, error = '', accountId, rate = null, marks = null } = {}) {
    const entry = this.active.get(id)
    if (!entry) return
    this.active.delete(id)
    if (accountId) entry.accountId = String(accountId).slice(0, 80)
    delete entry.accountLabel
    entry.status = status
    entry.ms = Date.now() - entry.at
    entry.promptTokens = numberOrNull(usage?.prompt_tokens)
    entry.completionTokens = numberOrNull(usage?.completion_tokens)
    entry.totalTokens = numberOrNull(usage?.total_tokens)
    // Upstream returns OpenAI-style detail objects; keep them for cache/thinking dashboards.
    entry.cachedTokens = numberOrNull(usage?.prompt_tokens_details?.cached_tokens)
    entry.reasoningTokens = numberOrNull(usage?.completion_tokens_details?.reasoning_tokens)
    entry.rate = rate || null
    if (marks?.firstByteAt) entry.firstByteMs = marks.firstByteAt - entry.at
    if (marks?.firstTokenAt) {
      entry.firstTokenMs = marks.firstTokenAt - entry.at
      entry.ttftMs = entry.firstTokenMs
    }
    // Never record upstream response bodies: they could contain an echoed credential.
    entry.error = error ? String(error).slice(0, 160).replace(/(bearer|credential|token)\s*[:=]?\s*\S+/gi, '$1 [REDACTED]') : ''
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) this.entries = this.entries.slice(-this.maxEntries)
    this.#store(entry)
  }

  /** Newest-first page. Response size is capped regardless of client input. */
  page({ page = 1, pageSize = 50 } = {}) {
    const size = Math.max(1, Math.min(Number(pageSize) || 50, this.pageSize))
    const total = this.entries.length
    const pages = Math.max(1, Math.ceil(total / size))
    const index = Math.max(1, Math.min(Number(page) || 1, pages))
    const end = total - (index - 1) * size
    const start = Math.max(0, end - size)
    return {
      entries: this.entries.slice(start, end).reverse().map(normalizeEntry),
      page: index, pageSize: size, pages, total,
      maxEntries: this.maxEntries,
    }
  }

  recent(limit = 100) {
    return this.entries.slice(-Math.max(1, Math.min(Number(limit) || 100, 500))).reverse()
  }

  #fileSize() {
    try { return statSync(this.path).size } catch { return 0 }
  }

  /** Test seam: exercises the rewrite path without any truncation risk in production. */
  flushNow() {
    this.#appendLine({ flushed: true })
  }

  clear() {
    this.entries = []
    if (!this.path) return
    try { writeFileSync(this.path, '', { mode: 0o600 }) } catch { /* ignore */ }
  }

  /**
   * Totals must cover every record on disk, not just the in-memory ring.
   * The ring only exists for paging, so using it here made the 24h totals
   * shrink as new requests pushed old entries out.
   */
  #allEntries({ since = 0 } = {}) {
    if (!this.persist) return this.entries.filter((entry) => entry.at >= since)
    const seen = new Set()
    const out = []
    const collect = (list) => {
      for (const entry of list) {
        if (!entry || entry.flushed || entry.at < since) continue
        if (entry.id && seen.has(entry.id)) continue
        if (entry.id) seen.add(entry.id)
        out.push(entry)
      }
    }
    collect(this.entries)
    // Read every retained segment within the requested window. Previously the
    // cutoff was hard-coded to 24h, which made 72h silently discard older data.
    for (let index = this.segment; index >= 0 && index >= this.segment - 2; index--) {
      let text = ''
      try { text = readFileSync(this.#segmentPath(index), 'utf8') } catch { continue }
      collect(text.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }))
    }
    return out
  }

  modelIds() {
    return [...new Set(this.#allEntries().map((entry) => entry.model).filter(Boolean))]
  }

  stats(hours = 24) {
    const windowHours = Math.max(1, Math.min(Number(hours) || 24, 168))
    const cutoff = Date.now() - windowHours * 3600000
    const source = this.#allEntries({ since: cutoff })
    const all = this.#allEntries()
    const allDates = all.map((entry) => entry.at).filter(Number.isFinite)
    const day = source.filter((entry) => entry.at >= cutoff)
    const completed = day.filter((entry) => entry.ms !== null)
    const failed = day.filter((entry) => entry.status >= 400)
    const sum = (list, key) => list.reduce((total, entry) => total + (Number(entry[key]) || 0), 0)
    const promptTokens = sum(day, 'promptTokens')
    const cachedTokens = sum(day, 'cachedTokens')
    const reasoningTokens = sum(day, 'reasoningTokens')
    return {
      total: source.length,
      last24h: day.length,
      failed24h: failed.length,
      successRate: completed.length ? Math.round((1 - failed.length / completed.length) * 1000) / 10 : null,
      averageMs: completed.length ? Math.round(sum(completed, 'ms') / completed.length) : null,
      tokens24h: sum(day, 'totalTokens'),
      promptTokens24h: promptTokens,
      completionTokens24h: sum(day, 'completionTokens'),
      cachedTokens24h: cachedTokens,
      reasoningTokens24h: reasoningTokens,
      // Cache hit rate = cached prompt tokens / all prompt tokens observed.
      // Two decimals: a single 512-token hit against a large token total must not read as 0%.
      cacheHitRate: promptTokens > 0 ? roundRate(cachedTokens / promptTokens) : null,
      windowHours,
      oldestAt: allDates.length ? Math.min(...allDates) : null,
      newestAt: allDates.length ? Math.max(...allDates) : null,
      allTimeRequests: all.length,
      allTimeTokens: sum(all, 'totalTokens'),
      allTimePromptTokens: sum(all, 'promptTokens'),
      allTimeCompletionTokens: sum(all, 'completionTokens'),
    }
  }

  /**
   * Per-model and time-bucketed aggregates used by the dashboard charts.
   * Bucket width adapts: hourly normally, finer when all traffic sits in a
   * single hour (otherwise the series has one point and cannot form a line).
   */
  breakdown(hours = 24, { bucketMs = null } = {}) {
    const hourCount = Math.max(1, Math.min(Number(hours) || 24, 168))
    const now = Date.now()
    const span = hourCount * 3600000
    const source = this.#allEntries({ since: now - span })
    const populated = new Set()
    for (const entry of source) {
      if (entry.at >= now - span) populated.add(Math.floor(entry.at / 3600000))
    }
    // Choose granularity: keep at least ~6 buckets populated when traffic is sparse.
    const adaptiveWidth = populated.size <= 2 ? 5 * 60000 : populated.size <= 8 ? 15 * 60000 : 3600000
    // Multi-day windows must not shrink below the 288-bucket budget: 5-minute
    // buckets over 72h would otherwise cover only the most recent 24h.
    const width = bucketMs || (hourCount > 24
      ? Math.max(adaptiveWidth, Math.ceil(span / 288))
      : adaptiveWidth)
    const bucketCount = Math.max(1, Math.min(Math.ceil(span / width), 288))
    const start = now - bucketCount * width
    const byModel = new Map()
    const byHour = Array.from({ length: bucketCount }, (_, index) => ({
      at: start + index * width, requests: 0, prompt: 0, completion: 0, cached: 0, reasoning: 0, total: 0, failed: 0,
    }))
    for (const entry of source) {
      if (entry.at < start) continue
      const model = entry.model || 'unknown'
      const row = byModel.get(model) || { model, requests: 0, prompt: 0, completion: 0, cached: 0, reasoning: 0, total: 0, ms: 0, failed: 0 }
      row.requests++
      row.prompt += Number(entry.promptTokens) || 0
      row.completion += Number(entry.completionTokens) || 0
      row.cached += Number(entry.cachedTokens) || 0
      row.reasoning += Number(entry.reasoningTokens) || 0
      row.total += Number(entry.totalTokens) || 0
      row.ms += Number(entry.ms) || 0
      if (entry.status >= 400) row.failed++
      byModel.set(model, row)
      const index = Math.min(bucketCount - 1, Math.floor((entry.at - start) / width))
      const hour = byHour[index]
      hour.requests++
      hour.prompt += Number(entry.promptTokens) || 0
      hour.completion += Number(entry.completionTokens) || 0
      hour.cached += Number(entry.cachedTokens) || 0
      hour.reasoning += Number(entry.reasoningTokens) || 0
      hour.total += Number(entry.totalTokens) || 0
      if (entry.status >= 400) hour.failed++
    }
    // Short windows retain the compact focused view. Multi-day windows keep
    // their complete axis so 72h cannot collapse into only the active hours.
    let output = byHour
    if (bucketMs || hourCount <= 24) {
      const filled = byHour.map((bucket, index) => bucket.requests ? index : -1).filter((index) => index >= 0)
      if (filled.length && filled.length < byHour.length) {
        const padding = Math.max(2, Math.round(byHour.length * 0.08))
        const from = Math.max(0, filled[0] - padding)
        const to = Math.min(byHour.length - 1, filled[filled.length - 1] + padding)
        output = byHour.slice(from, to + 1)
      }
    }
    return {
      bucketMs: width,
      bucketStart: output[0]?.at ?? start,
      bucketEnd: now,
      buckets: output.length,
      byModel: [...byModel.values()].map((row) => ({
        ...row,
        averageMs: row.requests ? Math.round(row.ms / row.requests) : null,
        cacheHitRate: row.prompt ? roundRate(row.cached / row.prompt) : null,
      })).sort((a, b) => b.requests - a.requests),
      byHour: output,
      coverage: {
        requests: byHour.reduce((total, bucket) => total + bucket.requests, 0),
        firstRequestAt: byHour.find((bucket) => bucket.requests)?.at || null,
        lastRequestAt: [...byHour].reverse().find((bucket) => bucket.requests)?.at || null,
      },
    }
  }
}

function roundRate(ratio) {
  const percent = ratio * 100
  if (percent === 0) return 0
  if (percent < 1) return Math.round(percent * 100) / 100
  return Math.round(percent * 10) / 10
}

/** Rows written before a field existed must read as "unknown", never as a real zero. */
function normalizeEntry(entry) {
  return {
    ...entry,
    promptTokens: entry.promptTokens ?? null,
    completionTokens: entry.completionTokens ?? null,
    totalTokens: entry.totalTokens ?? null,
    cachedTokens: entry.cachedTokens ?? null,
    reasoningTokens: entry.reasoningTokens ?? null,
  }
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null
}
