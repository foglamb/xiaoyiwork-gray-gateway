import { computed, ref, shallowRef } from 'vue'
import { api } from './useApi.js'
import { createRequestGate } from '../lib/logs.js'

// Shared overview state: one owner (App.vue) polls, every view reads.
export const state = ref(null)
export const logData = ref(null)
export const loading = shallowRef(false)
export const lastError = shallowRef('')
// Time window is shared state: the chart range buttons drive the request, so
// polling and manual refresh must read it instead of hard-coding 24.
export const windowHours = ref(24)

const quotaInflight = new Set()
const stateRequests = createRequestGate()
const overviewRequests = createRequestGate()
let refreshCount = 0

export const accounts = computed(() => state.value?.accounts || [])
export const models = computed(() => state.value?.models || [])
export const logs = computed(() => logData.value?.entries || [])
export const logStats = computed(() => logData.value?.stats || {})
export const hourly = computed(() => logData.value?.breakdown?.byHour || [])
export const byModel = computed(() => logData.value?.breakdown?.byModel || [])
export const bucketMs = computed(() => logData.value?.breakdown?.bucketMs || 3600000)

export async function loadState() {
  const id = stateRequests.next()
  const data = await api('/api/state')
  if (stateRequests.current(id)) state.value = data
  return data
}

// A successful settings write supersedes every state read begun before it.
export function acceptSettingsSnapshot(snapshot) {
  stateRequests.invalidate()
  if (!state.value) return
  const { requestTimeoutMs, ...settings } = snapshot
  state.value = { ...state.value, requestTimeoutMs, settings: { ...state.value.settings, ...settings } }
}

export async function loadLogs({ page = 1, pageSize = 50, hours = windowHours.value } = {}) {
  const id = overviewRequests.next()
  const data = await api(`/api/logs?page=${page}&pageSize=${pageSize}&hours=${hours}`)
  if (overviewRequests.current(id) && hours === windowHours.value) logData.value = data
  return data
}

export async function refreshAll({ page = 1, pageSize = 50, hours = windowHours.value } = {}) {
  refreshCount += 1
  loading.value = true
  try {
    const [a, b] = await Promise.allSettled([loadState(), loadLogs({ page, pageSize, hours })])
    const failure = [a, b].find((r) => r.status === 'rejected')
    lastError.value = failure ? failure.reason?.message || '刷新失败' : ''
    if (failure) throw failure.reason
  } finally {
    loading.value = --refreshCount > 0
  }
}

export async function refreshQuota(id) {
  if (!id || quotaInflight.has(id)) return null
  quotaInflight.add(id)
  try {
    return await api(`/api/accounts/${encodeURIComponent(id)}/quota`, { method: 'POST', body: {} })
  } finally {
    quotaInflight.delete(id)
  }
}

export function stopPolling() {
  stateRequests.invalidate()
  overviewRequests.invalidate()
}
