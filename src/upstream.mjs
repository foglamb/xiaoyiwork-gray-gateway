import { randomBytes } from 'node:crypto'

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
export function transformSse(upstream, modelHint, { signal, onFrame, onUsage } = {}) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let terminated = false
  let outputClosed = false
  let reader

  const enqueue = (controller, text) => {
    if (!outputClosed && text) controller.enqueue(encoder.encode(text))
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
    const parsed = parseJson(data)
    const text = parsed
      ? `data: ${JSON.stringify(patchChunk(parsed, modelHint))}\n\n`
      : `${lines.join('\n')}\n\n`
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
        close(controller)
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let end
          while (!terminated && (end = findEventBoundary(buffer)) !== null) {
            const block = buffer.slice(0, end.index)
            buffer = buffer.slice(end.index + end.length)
            enqueue(controller, normalizeBlock(block))
          }
          if (terminated) {
            await reader.cancel().catch(() => {})
            break
          }
        }
        if (outputClosed) return
        buffer += decoder.decode()
        if (!terminated && buffer.trim()) enqueue(controller, normalizeBlock(buffer))
        emitDone(controller)
        close(controller)
      } catch (error) {
        if (signal?.aborted) {
          close(controller)
          return
        }
        enqueue(controller, `data: ${JSON.stringify({ error: { message: `上游流中断：${error.message}`, type: 'upstream_stream_error' } })}\n\n`)
        emitDone(controller)
        close(controller)
      } finally {
        signal?.removeEventListener('abort', abort)
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

export async function aggregateSse(upstream, modelHint, { signal, onUsage } = {}) {
  const text = await new Response(transformSse(upstream, modelHint, { signal })).text()
  const message = { role: 'assistant', content: '' }
  let reasoning = ''
  const toolCalls = new Map()
  let id = `chatcmpl-${randomBytes(9).toString('hex')}`
  let created = Math.floor(Date.now() / 1000)
  let model = modelHint
  let finishReason = null
  let usage

  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim()).join('\n')
    if (!data || data === '[DONE]') continue
    const chunk = parseJson(data)
    if (!chunk) continue
    id = chunk.id || id
    created = chunk.created || created
    model = chunk.model || model
    usage = chunk.usage || usage
    if (chunk.usage) onUsage?.(chunk.usage)
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
  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, finish_reason: finishReason || (toolCalls.size ? 'tool_calls' : 'stop') }],
    ...(usage ? { usage } : {}),
  }
}
