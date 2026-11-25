// Pure formatters: no reactivity, safe to import anywhere.
export function num(value) {
  if (value === null || value === undefined || value === '') return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US')
}

export function compact(value, digits = 2) {
  const n = Number(value) || 0
  // Two decimals keep small addends visible next to a large total: with one
  // decimal, 403,512 output tokens round away and the sum looks wrong.
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(digits)}B`
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(digits)}M`
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

/** Exact integer with thousands separators, for places where sums must add up. */
export function exact(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—'
}

export function pct(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  const n = Number(value)
  return `${n < 1 && n > 0 ? n.toFixed(2) : n.toFixed(digits)}%`
}

export function ms(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`
}

export function clock(value) {
  if (!value) return '—'
  const date = new Date(value)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

export function dateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${mm}-${dd} ${clock(value)}`
}

export function ago(value) {
  if (!value) return '—'
  const diff = Date.now() - Number(value)
  if (diff < 60000) return `${Math.max(1, Math.round(diff / 1000))} 秒前`
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`
  return `${Math.round(diff / 86400000)} 天前`
}

/** Generation throughput; null means the request lacks enough timing data. */
export function tps(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  const n = Number(value)
  if (n >= 1000) return `${compact(n)} tok/s`
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} tok/s`
}
