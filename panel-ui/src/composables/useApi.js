import { shallowRef } from 'vue'
import { createAuthLifecycle } from '../lib/auth.js'

export const authLifecycle = createAuthLifecycle()
const sessionCleanups = new Set()
export function onSessionChange(cleanup) { sessionCleanups.add(cleanup) }

// One place for transport concerns: auth header, JSON parsing, error shape.
export const adminKey = shallowRef(sessionStorage.getItem('xy-admin') || '')

export function setAdminKey(value) {
  authLifecycle.invalidate()
  for (const cleanup of sessionCleanups) cleanup()
  adminKey.value = value || ''
  if (value) sessionStorage.setItem('xy-admin', value)
  else sessionStorage.removeItem('xy-admin')
}

export class ApiError extends Error {
  constructor(message, status, type) {
    super(message)
    this.status = status
    this.type = type
  }
}

export async function api(path, { method = 'GET', body, key } = {}) {
  const generation = authLifecycle.capture()
  const headers = { accept: 'application/json' }
  const token = key ?? adminKey.value
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await response.text()
  if (!authLifecycle.current(generation)) throw new ApiError('会话已变更，忽略过期请求', 0, 'session_changed')
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (!response.ok) {
    const info = data?.error || {}
    throw new ApiError(info.message || `HTTP ${response.status}`, response.status, info.type || 'error')
  }
  return data
}
