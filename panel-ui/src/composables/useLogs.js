import { computed, shallowRef } from 'vue'
import { api, onSessionChange } from './useApi.js'
import { changeLogQuery, createRequestGate, defaultLogQuery, logQueryString } from '../lib/logs.js'

// Table state has its own lifetime and never writes overview data.
export const logQuery = shallowRef(defaultLogQuery())
export const tableData = shallowRef(null)
export const tableBusy = shallowRef(false)
export const tableError = shallowRef('')
export const tableEntries = computed(() => tableData.value?.entries || [])
export const tableStats = computed(() => tableData.value?.stats || {})
const requests = createRequestGate()

export async function loadTableLogs() {
  const id = requests.next()
  const query = { ...logQuery.value }
  tableBusy.value = true
  tableError.value = ''
  try {
    const data = await api(`/api/logs?${logQueryString(query)}`)
    if (!requests.current(id)) return
    tableData.value = data
    logQuery.value = { ...query, page: data.page ?? query.page, pageSize: data.pageSize ?? query.pageSize }
    return data
  } catch (error) {
    if (requests.current(id)) tableError.value = error.message
  } finally {
    if (requests.current(id)) tableBusy.value = false
  }
}

export function updateLogQuery(patch) {
  requests.invalidate()
  logQuery.value = changeLogQuery(logQuery.value, patch, tableData.value?.until)
  // Never label previous-query rows with a new page/filter or export them as it.
  tableData.value = null
  return loadTableLogs()
}

export function resumeLatestLogs() {
  return updateLogQuery({ page: 1, until: null })
}

onSessionChange(() => {
  requests.invalidate()
  tableData.value = null
  logQuery.value = defaultLogQuery()
  tableBusy.value = false
  tableError.value = ''
})
