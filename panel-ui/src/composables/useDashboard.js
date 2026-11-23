import { computed, ref, shallowRef } from 'vue'
import { api } from './useApi.js'

// Shared dashboard state: one owner (main.js) polls, every view reads.
export const state = ref(null)
export const logData = ref(null)
export const loading = shallowRef(false)
export const lastError = shallowRef('')

const quotaInflight = new Set()
let controllers = []

export const accounts = computed(() => state.value?.accounts || [])
export const models = computed(() => state.value?.models || [])
export const logs = computed(() => logData.value?.entries || [])
export const logStats = computed(() => logData.value?.stats || {})
export const hourly = computed(() => logData.value?.breakdown?.byHour || [])
export const byModel = computed(() => logData.value?.breakdown?.byModel || [])
export const bucketMs = computed(() => logData.value?.breakdown?.bucketMs || 3600000)

export async function loadState() {
  state.value = await api('/api/state')
  return state.value
}

export async function loadLogs({ page = 1, pageSize = 50, hours = 24 } = {}) {
  logData.value = await api(`/api/logs?page=${page}&pageSize=${pageSize}&hours=${hours}`)
  return logData.value
}

export async function refreshAll({ page = 1, pageSize = 50, hours = 24 } = {}) {
  loading.value = true
  try {
    const [a, b] = await Promise.allSettled([loadState(), loadLogs({ page, pageSize, hours })])
    const failure = [a, b].find((r) => r.status === 'rejected')
    lastError.value = failure ? failure.reason?.message || '刷新失败' : ''
    if (a.status === 'rejected' && b.status === 'fulfilled') throw a.reason
    if (a.status === 'fulfilled' && b.status === 'rejected') throw b.reason
  } finally {
    loading.value = false
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
  for (const controller of controllers) controller.abort()
  controllers = []
}
