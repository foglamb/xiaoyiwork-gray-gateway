import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export class RequestLog {
  constructor({ configPath = null, maxEntries = 200, persist = true } = {}) {
    this.path = configPath ? resolve(dirname(configPath), 'requests.jsonl') : null
    this.maxEntries = Math.max(10, Math.min(maxEntries, 1000))
    this.persist = persist && Boolean(this.path)
    this.entries = []
    this.active = new Map()
    this.onFlush = null
    this.onFlush = null
    if (this.persist) this.#load()
  }

  #load() {
    try {
      this.entries = readFileSync(this.path, 'utf8').split('\n').filter(Boolean).slice(-this.maxEntries)
        .map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    } catch { /* The first run has no log. A corrupt log must not stop the API. */ }
  }

  #store(entry, append = true) {
    if (this.onFlush) {
      Promise.resolve(this.onFlush(this.entries)).catch(() => {})
      return
    }
    if (!this.persist) return
    try {
      if (append) appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
      else {
        const temporary = `${this.path}.${process.pid}.tmp`
        writeFileSync(temporary, `${this.entries.map((item) => JSON.stringify(item)).join('\n')}\n`, { mode: 0o600 })
        renameSync(temporary, this.path)
      }
    } catch { /* Diagnostics must never break a streaming response. */ }
  }

  begin({ id, model, stream, route, accountId }) {
    const entry = {
      id, at: Date.now(), model: String(model || '').slice(0, 100), stream: Boolean(stream),
      route: route.selected ? 'gray' : 'stable', pool: route.pool, reason: route.reason,
      accountId: '', accountLabel: String(accountId || '').slice(0, 80), status: 'pending', ms: null,
      promptTokens: null, completionTokens: null, totalTokens: null, error: '',
    }
    this.active.set(id, entry)
    return entry
  }

  finish(id, { status = 200, usage, error = '', accountId } = {}) {
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
    // Never record upstream response bodies: they could contain an echoed credential.
    entry.error = error ? String(error).slice(0, 160).replace(/(bearer|credential|token)\s*[:=]?\s*\S+/gi, '$1 [REDACTED]') : ''
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) this.entries = this.entries.slice(-this.maxEntries)
    this.#store(entry, this.entries.length < this.maxEntries)
  }

  recent(limit = 100) {
    return this.entries.slice(-Math.max(1, Math.min(Number(limit) || 100, 500))).reverse()
  }

  clear() {
    this.entries = []
    this.#store({ cleared: true }, false)
  }

  stats() {
    const cutoff = Date.now() - 86400000
    const day = this.entries.filter((entry) => entry.at >= cutoff)
    const completed = day.filter((entry) => entry.ms !== null)
    const failed = day.filter((entry) => entry.status >= 400)
    return {
      total: this.entries.length,
      last24h: day.length,
      failed24h: failed.length,
      successRate: completed.length ? Math.round((1 - failed.length / completed.length) * 1000) / 10 : null,
      averageMs: completed.length ? Math.round(completed.reduce((sum, entry) => sum + entry.ms, 0) / completed.length) : null,
      tokens24h: day.reduce((sum, entry) => sum + (entry.totalTokens || 0), 0),
    }
  }
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null
}
