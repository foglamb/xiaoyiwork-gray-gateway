// Independent of Vue so query, timing and export invariants can run under node:test.
export const defaultLogQuery = () => ({ page: 1, pageSize: 20, hours: 24, model: '', accountId: '', status: 'all', q: '', sort: 'at', order: 'desc', until: null })

export function changeLogQuery(current, patch, snapshotUntil, now = Date.now()) {
  const next = { ...current, ...patch }
  if (Object.keys(patch).some((key) => !['page', 'until'].includes(key))) next.page = 1
  if (next.page > 1 && !next.until) next.until = snapshotUntil || now
  return next
}

export function logQueryString(query) {
  return new URLSearchParams(Object.entries(query).filter(([, value]) => value !== '' && value !== null && value !== undefined)).toString()
}

export function createRequestGate() {
  let revision = 0
  return { next: () => ++revision, current: (id) => id === revision, invalidate: () => ++revision }
}

function duration(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
}

export function latencyStages(entry) {
  const total = duration(entry.ms)
  const headers = duration(entry.responseHeadersMs)
  const token = duration(entry.ttftMs)
  const validHeaders = headers !== null && total !== null && headers <= total
  const validToken = token !== null && total !== null && token <= total
  return [
    { key: 'network', label: '响应等待', value: validHeaders ? headers : null, offset: 0 },
    { key: 'prefill', label: '首输出等待', value: validHeaders && validToken && token >= headers ? token - headers : null, offset: headers },
    { key: 'generation', label: '输出阶段', value: validToken ? total - token : null, offset: token },
  ]
}

export function stageStyle(stage, entry) {
  const total = duration(entry.ms)
  return { left: `${total > 0 && stage.offset !== null ? stage.offset / total * 100 : 0}%`, width: `${total > 0 && stage.value !== null ? stage.value / total * 100 : 0}%` }
}

export function measuredOutputTps(entry) {
  const total = duration(entry.ms)
  const token = duration(entry.ttftMs)
  return token !== null && total !== null && total > token ? duration(entry.outputTps) : null
}

export function csvCell(value) {
  let text = String(value ?? '')
  // Spreadsheet engines trim leading whitespace/control characters before formulas.
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

export function logsCsv(entries) {
  const fields = ['id', 'model', 'route', 'accountId', 'status', 'ms', 'timingVersion', 'firstByteMeaning', 'responseHeadersMs', 'firstByteMs', 'ttftMs', 'generationMs', 'promptTokens', 'cachedTokens', 'reasoningTokens', 'completionTokens', 'totalTokens', 'prefillTps', 'outputTps', 'endToEndTps', 'errorType', 'error', 'attempts']
  const rows = entries.map((entry) => {
    const date = new Date(entry.at)
    return [Number.isFinite(date.getTime()) ? date.toISOString() : '', ...fields.map((field) => field === 'attempts' ? JSON.stringify(entry.attempts || []) : field === 'outputTps' ? measuredOutputTps(entry) : entry[field])]
  })
  return '\ufeff' + [['time', ...fields], ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
}

export function proportionalHeight(value, maximum) {
  return maximum > 0 ? Math.max(0, value / maximum * 100) : 0
}
