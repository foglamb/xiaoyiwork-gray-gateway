import { randomBytes } from 'node:crypto'
import { HttpError } from './canary.mjs'

export const DEFAULT_HEADERS = {
  'content-type': 'application/json',
  'x-request-from': 'xiaoyiWork',
  'x-businessId': 'WINPC_XIAOYI_WORK',
  'x-prd-pkg-name': 'com.huawei.hmos.vassistant',
}

export function authHeaders(account, { sse = true, trace = `xy-${randomBytes(8).toString('hex')}` } = {}) {
  return {
    ...DEFAULT_HEADERS,
    accept: sse ? 'text/event-stream' : 'application/json',
    businessCredential: account.credential,
    'x-uid': account.uid,
    'x-device-id': account.deviceId,
    'x-hag-trace-id': trace,
  }
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

export function patchChunk(value, modelHint) {
  const out = { ...value }
  out.object ??= 'chat.completion.chunk'
  out.created ??= Math.floor(Date.now() / 1000)
  if (!out.model) out.model = modelHint || ''
  out.id ??= `chatcmpl-${randomBytes(9).toString('hex')}`
  if (Array.isArray(out.choices)) {
    out.choices = out.choices.map((choice, index) => ({
      ...choice,
      index: typeof choice.index === 'number' ? choice.index : index,
    }))
  }
  return out
}

/**
 * The XiaoyiWork gateway only speaks SSE and closes without [DONE].
 * Preserve complete SSE blocks (including comments), remove its numeric id lines,
 * normalize OpenAI chunk fields, and terminate exactly once with data: [DONE].
 */
export function transformSse(upstream, modelHint, { signal, onFrame, onUsage, heartbeatMs = 15000, onFirstByte, onFirstToken, onError, fastFail = true } = {}) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let terminated = false
  let outputClosed = false
  let reader
  let lastWrite = 0
  let firstTokenSeen = false
  let firstByteSeen = false
  let upstreamErrorSeen = false
  let errorReported = false

  const reportError = (error) => {
    if (!errorReported) {
      errorReported = true
      onError?.(error)
    }
  }
  const abortFailure = () => signal?.reason instanceof HttpError
    ? signal.reason
    : new HttpError(499, '请求已取消', 'client_cancelled')

  const enqueue = (controller, text) => {
    if (!outputClosed && text) {
      lastWrite = Date.now()
      controller.enqueue(encoder.encode(text))
    }
  }
  const close = (controller) => {
    if (!outputClosed) {
      outputClosed = true
      controller.close()
    }
  }
  const emitDone = (controller) => {
    if (!terminated && !outputClosed) {
      enqueue(controller, 'data: [DONE]\n\n')
      terminated = true
    }
  }

  function normalizeBlock(block) {
    const lines = block.split(/\r\n|\n|\r/).filter((line) => !/^id\s*:/i.test(line))
    const data = lines.filter((line) => /^data\s*:/i.test(line))
      .map((line) => line.replace(/^data\s*:\s?/i, '')).join('\n').trim()
    if (!data) return `${lines.join('\n')}\n\n`
    if (data === '[DONE]') {
      terminated = true
      return 'data: [DONE]\n\n'
    }
    let parsed = parseJson(data)
    if (parsed && !parsed.choices && (parsed.code || parsed.message) && !parsed.error) {
      parsed = {
        ...parsed,
        error: {
          message: String(parsed.message || '小艺Work 上游错误'),
          type: 'upstream_error',
          ...(parsed.code !== undefined ? { code: String(parsed.code) } : {}),
        },
      }
    }
    if (parsed?.error) {
      if (fastFail) upstreamErrorSeen = true
      reportError(parsed.error)
    }
    const text = parsed
      ? `data: ${JSON.stringify(patchChunk(parsed, modelHint))}\n\n`
      : `${lines.join('\n')}\n\n`
    const hasToken = (parsed?.choices || []).some((choice) => {
      const delta = choice.delta || {}
      return (typeof delta.content === 'string' && delta.content.length > 0) ||
        (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) ||
        (Array.isArray(delta.tool_calls) && delta.tool_calls.some((call) =>
          (typeof call.function?.name === 'string' && call.function.name.length > 0) ||
          (typeof call.function?.arguments === 'string' && call.function.arguments.length > 0)))
    })
    if (!firstTokenSeen && hasToken) {
      firstTokenSeen = true
      onFirstToken?.()
    }
    onFrame?.(parsed)
    if (parsed?.usage) onUsage?.(parsed.usage)
    return text
  }

  return new ReadableStream({
    async start(controller) {
      reader = upstream.getReader()
      const abort = () => reader.cancel(signal?.reason).catch(() => {})
      if (signal?.aborted) {
        await abort()
        const error = abortFailure()
        const detail = { message: error.message, type: error.code, status: error.status }
        reportError(detail)
        enqueue(controller, `data: ${JSON.stringify({ error: detail })}\n\n`)
        emitDone(controller)
        close(controller)
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        for (;;) {
          // Race the upstream read against a heartbeat interval so a thinking model
          // that stays silent for 10-30s does not look like a dead connection.
          // Keep a single in-flight read across heartbeat ticks: dropping it would
          // silently swallow the chunk that resolves later.
          let result
          if (!(heartbeatMs > 0)) {
            // Zero disables heartbeat and, importantly, avoids a zero-delay
            // timer loop while the upstream is thinking.
            result = await reader.read()
          } else {
            let readPromise = reader.read()
            for (;;) {
              let timer
              const beat = new Promise((resolve) => {
                timer = setTimeout(() => resolve('__beat__'), heartbeatMs)
                timer.unref?.()
              })
              let raced
              try {
                raced = await Promise.race([readPromise.then((value) => ({ value })), beat])
              } finally { clearTimeout(timer) }
              if (raced === '__beat__') {
                if (Date.now() - lastWrite >= heartbeatMs) enqueue(controller, ': keepalive\n\n')
                continue
              }
              result = raced.value
              break
            }
          }
          const { value, done } = result
          if (signal?.aborted) throw abortFailure()
          if (done) break
          if (!firstByteSeen && value?.byteLength > 0) {
            firstByteSeen = true
            onFirstByte?.()
          }
          buffer += decoder.decode(value, { stream: true })
          let end
          while (!terminated && !upstreamErrorSeen && (end = findEventBoundary(buffer)) !== null) {
            const block = buffer.slice(0, end.index)
            buffer = buffer.slice(end.index + end.length)
            enqueue(controller, normalizeBlock(block))
          }
          if (terminated || upstreamErrorSeen) {
            await reader.cancel().catch(() => {})
            break
          }
        }
        if (outputClosed) return
        buffer += decoder.decode()
        if (!terminated && !upstreamErrorSeen && buffer.trim()) enqueue(controller, normalizeBlock(buffer))
        emitDone(controller)
        close(controller)
      } catch (error) {
        const failure = signal?.aborted ? abortFailure() : error
        const detail = signal?.aborted
          ? { message: failure.message, type: failure.code, status: failure.status }
          : { message: '上游流中断', type: 'upstream_stream_error', status: 502 }
        reportError(detail)
        enqueue(controller, `data: ${JSON.stringify({ error: detail })}\n\n`)
        emitDone(controller)
        close(controller)
      } finally {
        signal?.removeEventListener('abort', abort)
        reader.releaseLock()
      }
    },
    async cancel(reason) {
      outputClosed = true
      await reader?.cancel(reason).catch(() => {})
    },
  })
}

function findEventBoundary(buffer) {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
  return match ? { index: match.index, length: match[0].length } : null
}

export async function aggregateSse(upstream, modelHint, { signal, onUsage, onFirstByte, onFirstToken, onError, fastFail = true } = {}) {
  const text = await new Response(transformSse(upstream, modelHint, {
    signal, onUsage, onFirstByte, onFirstToken, onError, fastFail, heartbeatMs: 0,
  })).text()
  if (signal?.aborted) throw signal.reason instanceof HttpError
    ? signal.reason : new HttpError(499, '请求已取消', 'client_cancelled')
  const message = { role: 'assistant', content: '' }
  let reasoning = ''
  const toolCalls = new Map()
  let id = `chatcmpl-${randomBytes(9).toString('hex')}`
  let created = Math.floor(Date.now() / 1000)
  let model = modelHint
  let finishReason = null
  let usage
  let upstreamError = null

  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim()).join('\n')
    if (!data || data === '[DONE]') continue
    const chunk = parseJson(data)
    if (!chunk) continue
    if (chunk.error) upstreamError = chunk.error
    id = chunk.id || id
    created = chunk.created || created
    model = chunk.model || model
    usage = chunk.usage || usage
    for (const choice of chunk.choices || []) {
      const delta = choice.delta || {}
      if (typeof delta.content === 'string') message.content += delta.content
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
      if (delta.role) message.role = delta.role
      for (const call of delta.tool_calls || []) {
        const key = Number.isInteger(call.index) ? call.index : toolCalls.size
        const previous = toolCalls.get(key) || { id: '', type: 'function', function: { name: '', arguments: '' } }
        previous.id = call.id || previous.id
        previous.type = call.type || previous.type
        previous.function.name += call.function?.name || ''
        previous.function.arguments += call.function?.arguments || ''
        toolCalls.set(key, previous)
      }
      if (choice.finish_reason) finishReason = choice.finish_reason
    }
  }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.size) message.tool_calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
  if (upstreamError && !message.content && !reasoning && !toolCalls.size) {
    const code = upstreamError.code ? `（${upstreamError.code}）` : ''
    throw new HttpError(502, `小艺Work 上游错误${code}：${upstreamError.message || '未知错误'}`, 'upstream_error')
  }
  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, finish_reason: finishReason || (toolCalls.size ? 'tool_calls' : 'stop') }],
    ...(usage ? { usage } : {}),
    ...(upstreamError ? { error: upstreamError } : {}),
  }
}
