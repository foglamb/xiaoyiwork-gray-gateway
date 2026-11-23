<script setup>
import { computed, shallowRef } from 'vue'
import BaseDialog from './BaseDialog.vue'
import LoginDialog from './LoginDialog.vue'
import { accounts, refreshQuota } from '../composables/useDashboard.js'
import { api } from '../composables/useApi.js'
import { notify } from '../composables/useToast.js'
import { num, ago, pct } from '../composables/useFormat.js'

defineProps({ gray: { type: Object, default: () => ({}) } })
const emit = defineEmits(['changed'])

const busy = shallowRef('')
const dialogOpen = shallowRef(false)
const targetPool = shallowRef('gray')
const confirmDelete = shallowRef(null)

const pools = computed(() => [
  { id: 'stable', label: '稳定池', desc: '常规流量', items: accounts.value.filter((a) => a.pool === 'stable') },
  { id: 'gray', label: '灰度池', desc: '按比例分流', items: accounts.value.filter((a) => a.pool === 'gray') },
])

function quotaTotal(account) {
  return (account.quota?.windows || []).reduce((sum, w) => sum + (typeof w.remaining === 'number' ? w.remaining : 0), 0)
}

async function doRefreshQuota(account) {
  busy.value = `q:${account.id}`
  try {
    await refreshQuota(account.id)
    notify(`${account.id} 余额已刷新`, 'ok')
    emit('changed')
  } catch (error) {
    notify(error.message, 'err')
  } finally {
    busy.value = ''
  }
}

async function doProbe(account) {
  busy.value = `p:${account.id}`
  try {
    const result = await api('/api/accounts/probe', { method: 'POST', body: {} })
    const mine = result.results.find((row) => row.id === account.id)
    notify(mine ? (mine.ok ? `${account.id} 凭据正常` : `${account.id} 异常：${mine.message}`) : '探测完成', mine?.ok ? 'ok' : 'err')
    emit('changed')
  } catch (error) {
    notify(error.message, 'err')
  } finally {
    busy.value = ''
  }
}

async function remove(account) {
  busy.value = `d:${account.id}`
  try {
    await api(`/api/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' })
    notify(`${account.id} 已删除`, 'ok')
    confirmDelete.value = null
    emit('changed')
  } catch (error) {
    notify(error.message, 'err')
  } finally {
    busy.value = ''
  }
}

function openLogin(pool) {
  targetPool.value = pool
  dialogOpen.value = true
}
</script>

<template>
  <div class="stack">
    <div class="pool-grid">
      <section v-for="pool in pools" :key="pool.id" class="pool card">
        <header class="pool-head">
          <div>
            <div class="row">
              <span class="kicker">{{ pool.id === 'gray' ? 'GRAY' : 'STABLE' }}</span>
              <span class="badge">{{ pool.items.length }}</span>
            </div>
            <h3>{{ pool.label }}</h3>
            <p class="muted tiny">{{ pool.desc }}</p>
          </div>
          <button class="btn btn-sm" type="button" @click="openLogin(pool.id)">+ 添加</button>
        </header>

        <div v-if="!pool.items.length" class="empty-state">这个池还没有账号</div>
        <article v-for="account in pool.items" :key="account.id" class="account">
          <div class="account-top">
            <div class="account-id">
              <span class="avatar">{{ (account.displayName || account.id).slice(0, 1).toUpperCase() }}</span>
              <div class="min0">
                <strong class="truncate">{{ account.displayName || account.id }}</strong>
                <span class="muted tiny mono">UID {{ account.uid }}</span>
              </div>
            </div>
            <div class="badges">
              <span v-if="account.cooling" class="badge warn" :title="`冷却至 ${ago(account.coolingUntil)}`"><span class="dot" />冷却</span>
              <span v-else-if="account.health && !account.health.ok" class="badge err" :title="account.health.message"><span class="dot" />异常</span>
              <span v-else-if="account.health?.ok" class="badge ok"><span class="dot" />正常</span>
              <span class="badge">{{ account.source === 'oauth' ? 'OAuth' : '导入' }}</span>
            </div>
          </div>

          <div class="metrics">
            <div class="metric">
              <span>余额</span>
              <b :class="{ dim: !account.quota }">{{ account.quota ? num(quotaTotal(account)) : '加载中' }}</b>
            </div>
            <div class="metric">
              <span>余额单位</span>
              <b class="tiny">{{ account.quota ? account.quota.plan || '点' : '—' }}</b>
            </div>
            <div class="metric">
              <span>请求</span>
              <b>{{ num(account.requests) }}</b>
            </div>
            <div class="metric">
              <span>凭据</span>
              <b class="tiny">{{ account.hasRefreshToken ? '可续期' : '固定' }}</b>
            </div>
          </div>

          <div v-if="account.quota?.windows?.length" class="windows">
            <div v-for="w in account.quota.windows" :key="w.name" class="window-row">
              <span class="truncate">{{ w.name }}</span>
              <b>{{ w.remaining === null ? '—' : num(w.remaining) }}</b>
            </div>
          </div>
          <p v-if="account.quotaError" class="quota-err">{{ account.quotaError }}</p>

          <footer class="account-foot">
            <button class="btn btn-sm btn-ghost" type="button" :disabled="busy === `q:${account.id}`" @click="doRefreshQuota(account)">
              {{ busy === `q:${account.id}` ? '刷新中…' : '刷新余额' }}
            </button>
            <button class="btn btn-sm btn-ghost" type="button" :disabled="busy === `p:${account.id}`" @click="doProbe(account)">
              {{ busy === `p:${account.id}` ? '检测中…' : '检测' }}
            </button>
            <span class="grow" />
            <button class="btn btn-sm btn-danger" type="button" @click="confirmDelete = account">删除</button>
          </footer>
        </article>
      </section>
    </div>

    <LoginDialog v-if="dialogOpen" :pool="targetPool" @close="dialogOpen = false" @done="dialogOpen = false; emit('changed')" />

    <BaseDialog v-if="confirmDelete" title="删除账号" :subtitle="confirmDelete.id" :width="420" @close="confirmDelete = null">
      <p class="muted">删除后该账号将不再参与请求分流，凭据会从配置中移除。</p>
      <template #footer>
        <button class="btn" type="button" @click="confirmDelete = null">取消</button>
        <button class="btn btn-danger" type="button" :disabled="busy.startsWith('d:')" @click="remove(confirmDelete)">确认删除</button>
      </template>
    </BaseDialog>
  </div>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: 16px; }
.pool-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 16px; align-items: start; }
.pool { padding: 18px; display: flex; flex-direction: column; gap: 12px; }
.pool-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.pool-head h3 { margin-top: 4px; font-size: 14.5px; font-weight: 640; }
.account {
  border: 1px solid var(--line); border-radius: var(--r-md);
  padding: 13px 14px; background: var(--surface-2);
  display: flex; flex-direction: column; gap: 11px;
  transition: border-color var(--dur) var(--ease);
}
.account:hover { border-color: var(--dim-2); }
.account-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.account-id { display: flex; align-items: center; gap: 9px; min-width: 0; }
.avatar {
  width: 30px; height: 30px; flex: none; border-radius: 9px; display: grid; place-items: center;
  background: var(--accent-soft); color: var(--accent-2); font-weight: 700; font-size: 13px;
}
.min0 { min-width: 0; display: flex; flex-direction: column; line-height: 1.35; }
.min0 strong { font-size: 12.5px; font-weight: 620; }
.badges { display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.metric { display: flex; flex-direction: column; gap: 1px; }
.metric span { font-size: 10px; color: var(--dim); }
.metric b { font-size: 15px; font-family: var(--font-mono); font-weight: 620; }
.metric b.dim { color: var(--dim-2); }
.windows { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--line-soft); padding-top: 9px; }
.window-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 11.5px; color: var(--dim); }
.window-row b { font-family: var(--font-mono); color: var(--text-2); }
.quota-err { font-size: 11px; color: var(--red); }
.account-foot { display: flex; align-items: center; gap: 4px; border-top: 1px solid var(--line-soft); padding-top: 9px; }
</style>
