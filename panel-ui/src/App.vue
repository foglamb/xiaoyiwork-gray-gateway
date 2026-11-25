<script setup>
import { computed, onMounted, shallowRef, watch } from 'vue'
import AppShell from './components/AppShell.vue'
import LoginView from './components/LoginView.vue'
import OverviewView from './components/OverviewView.vue'
import GrayView from './components/GrayView.vue'
import AccountsView from './components/AccountsView.vue'
import ModelsView from './components/ModelsView.vue'
import LogsView from './components/LogsView.vue'
import SettingsView from './components/SettingsView.vue'
import ToastStack from './components/ToastStack.vue'
import { adminKey, setAdminKey } from './composables/useApi.js'
import { state, loading, refreshAll } from './composables/useDashboard.js'
import { loadTableLogs } from './composables/useLogs.js'
import { usePolling } from './composables/usePolling.js'
import { notify } from './composables/useToast.js'

const ready = shallowRef(false)
const authed = shallowRef(false)
const tab = shallowRef('overview')
const autoRefresh = shallowRef(true)

const tabs = computed(() => [
  { id: 'overview', label: '总览', hint: '流量、Token 与缓存一目了然', icon: 'overview' },
  { id: 'gray', label: '灰度', hint: '按比例分流、覆盖规则与分桶预览', icon: 'spark' },
  { id: 'accounts', label: '账号池', hint: '稳定池与灰度池的账号与余额', icon: 'accounts', badge: state.value?.accounts?.length },
  { id: 'models', label: '模型', hint: '可用模型与能力', icon: 'models', badge: state.value?.models?.length },
  { id: 'logs', label: '请求记录', hint: '逐条查看调用、延迟与 Token 构成', icon: 'logs' },
  { id: 'settings', label: '设置', hint: '接入地址、密钥与运行状态', icon: 'settings' },
])

const healthy = computed(() => {
  const accounts = state.value?.accounts || []
  if (!accounts.length) return false
  return accounts.some((a) => !a.cooling && a.health?.ok !== false)
})

async function refreshCurrent() {
  await Promise.all([refreshAll(), ...(tab.value === 'logs' ? [loadTableLogs()] : [])])
}
const poller = usePolling(refreshCurrent, { intervalMs: 20000, enabled: false })

async function boot() {
  if (!adminKey.value) { ready.value = true; return }
  try {
    await refreshAll()
    authed.value = true
    if (autoRefresh.value) poller.start()
  } catch (error) {
    if (error.status === 401) setAdminKey('')
    else notify(error.message, 'err')
  } finally {
    ready.value = true
  }
}

function onAuthenticated() {
  authed.value = true
  boot()
}

function logout() {
  setAdminKey('')
  authed.value = false
  poller.stop()
}

async function manualRefresh() {
  try { await refreshCurrent() } catch (error) { notify(error.message, 'err') }
}

watch(autoRefresh, (on) => (on ? poller.start() : poller.stop()))

onMounted(boot)
</script>

<template>
  <ToastStack />
  <div v-if="!ready" class="boot"><span class="spinner" /></div>
  <LoginView v-else-if="!authed" @authenticated="onAuthenticated" />
  <AppShell
    v-else
    :tabs="tabs" :active="tab" :service="state?.service || {}" :loading="loading" :healthy="healthy"
    @update:active="tab = $event" @refresh="manualRefresh" @logout="logout"
  >
    <OverviewView v-if="tab === 'overview'" />
    <GrayView v-else-if="tab === 'gray'" @saved="manualRefresh" />
    <AccountsView v-else-if="tab === 'accounts'" :gray="state?.gray || {}" @changed="manualRefresh" />
    <ModelsView v-else-if="tab === 'models'" @changed="manualRefresh" />
    <LogsView v-else-if="tab === 'logs'" v-model:polling="autoRefresh" />
    <SettingsView v-else-if="tab === 'settings'" @logout="logout" @changed="manualRefresh" />
  </AppShell>
</template>

<style scoped>
.boot { min-height: 100vh; display: grid; place-items: center; background: var(--bg); }
.spinner {
  width: 26px; height: 26px; border-radius: 50%;
  border: 2px solid var(--line); border-top-color: var(--accent);
  animation: spin 700ms linear infinite;
}
@keyframes spin { to { transform: rotate(360deg) } }
</style>
