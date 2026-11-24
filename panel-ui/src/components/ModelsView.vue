<script setup>
import { computed, shallowRef } from 'vue'
import AppIcon from './AppIcon.vue'
import BaseDialog from './BaseDialog.vue'
import { models, state } from '../composables/useDashboard.js'
import { api } from '../composables/useApi.js'
import { notify } from '../composables/useToast.js'

const emit = defineEmits(['changed'])
const query = shallowRef('')
const refreshing = shallowRef(false)
const sessionOpen = shallowRef(false)
const sessionBusy = shallowRef(false)
const cookieInput = shallowRef('')
const catalog = computed(() => state.value?.modelCatalog || {})
const sourceLabel = { upstream: '上游', observed: '调用记录', config: '配置', 'upstream-cache': '上游缓存' }

async function saveSession() {
  if (!cookieInput.value.trim()) { notify('请粘贴小艺网页版 Cookie', 'err'); return }
  sessionBusy.value = true
  try {
    const result = await api('/api/models/session', { method: 'POST', body: { cookie: cookieInput.value } })
    cookieInput.value = ''
    sessionOpen.value = false
    notify(result.status.message, result.status.ok ? 'ok' : 'info')
    emit('changed')
  } catch (error) { notify(error.message, 'err') } finally { sessionBusy.value = false }
}

async function clearSession() {
  if (!window.confirm('清除模型目录网页会话？聊天账号不受影响。')) return
  try {
    await api('/api/models/session', { method: 'DELETE' })
    notify('目录会话已清除；保留真实上游缓存', 'ok')
    emit('changed')
  } catch (error) { notify(error.message, 'err') }
}

async function refreshModels() {
  refreshing.value = true
  try {
    const result = await api('/api/models/refresh', { method: 'POST', body: {} })
    notify(result.status.message, result.status.ok ? 'ok' : 'info')
    emit('changed')
  } catch (error) { notify(error.message, 'err') } finally { refreshing.value = false }
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return models.value
  return models.value.filter((m) => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))
})

async function copy(id) {
  await navigator.clipboard.writeText(id).catch(() => {})
  notify(`已复制 ${id}`, 'ok', 1600)
}
</script>

<template>
  <div class="stack">
    <div class="toolbar card">
      <div class="search-wrap">
        <AppIcon name="search" :size="14" class="search-icon" />
        <input v-model="query" class="input search" placeholder="搜索模型 ID 或名称…" spellcheck="false" />
      </div>
      <span class="muted tiny">{{ filtered.length }} / {{ models.length }} 个模型</span>
      <button class="btn btn-sm" type="button" @click="sessionOpen = true">
        {{ catalog.sessionConfigured ? '更新目录会话' : '导入目录 Cookie' }}
      </button>
      <button v-if="catalog.sessionConfigured" class="btn btn-sm btn-ghost" type="button" @click="clearSession">清除会话</button>
      <button class="btn btn-sm" type="button" :disabled="refreshing" @click="refreshModels">
        <AppIcon name="refresh" :size="12" /> {{ refreshing ? '刷新中…' : '从上游刷新' }}
      </button>
    </div>
    <div class="catalog-note" :class="{ warn: catalog.ok === false }">
      {{ catalog.message || '模型目录准备中' }}；{{ catalog.sessionConfigured ? '网页目录会话已保存' : '尚未保存网页目录会话' }}。
      标记为「调用记录」的模型来自真实请求，不是上游目录。
    </div>

    <div class="grid">
      <article v-for="model in filtered" :key="model.id" class="model card" @click="copy(model.id)">
        <div class="model-head">
          <strong class="truncate">{{ model.name || model.id }}</strong>
          <span v-if="model.gray" class="badge warn">灰度</span>
        </div>
        <code class="model-id truncate">{{ model.id }}</code>
        <p v-if="model.description" class="model-desc">{{ model.description }}</p>
        <div class="model-meta">
          <span v-if="model.vision" class="badge info">视觉</span>
          <span class="badge">{{ sourceLabel[model.source] || model.source || '记录' }}</span>
          <span class="grow" />
          <span class="copy-hint"><AppIcon name="copy" :size="11" /> 复制</span>
        </div>
      </article>
      <div v-if="!filtered.length" class="empty-state">没有匹配的模型</div>
    </div>
    <BaseDialog
      v-if="sessionOpen" title="导入模型目录会话" width="600"
      subtitle="仅用于 xiaoyi.huawei.com 的 getWorkModelList；不会改变聊天账号。"
      @close="sessionOpen = false"
    >
      <label class="session-label" for="model-cookie">小艺网页版 Cookie</label>
      <textarea
        id="model-cookie" v-model="cookieInput" class="input cookie-input"
        placeholder="粘贴浏览器请求中的 Cookie 请求头，例如 xy_csrf_token=…; …"
        autocomplete="off" spellcheck="false"
      />
      <p class="session-help">仅保存在网关本机的 model-catalog-session.json（权限 0600），不会进入日志、状态接口或 GitHub。</p>
      <template #footer>
        <button class="btn" type="button" @click="sessionOpen = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="sessionBusy" @click="saveSession">
          {{ sessionBusy ? '验证中…' : '保存并获取模型' }}
        </button>
      </template>
    </BaseDialog>
  </div>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: 14px; }
.toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 11px 14px; }
.session-label { display: block; margin-bottom: 7px; font-size: 12px; color: var(--text-2); }
.cookie-input { width: 100%; min-height: 130px; padding: 10px 12px; resize: vertical; font-family: var(--font-mono); font-size: 11px; line-height: 1.6; }
.session-help { margin-top: 9px; font-size: 11px; color: var(--dim); line-height: 1.6; }
.search-wrap { position: relative; flex: 1; max-width: 360px; }
.search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--dim-2); pointer-events: none; }
.search { height: 34px; padding-left: 33px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(228px, 1fr)); gap: 11px; }
@media (max-width: 720px) { .grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 9px; } .model { padding: 11px 12px; } }
.model { padding: 13px 14px; display: flex; flex-direction: column; gap: 7px; cursor: pointer; transition: border-color var(--dur-2) var(--ease), transform var(--dur-2) var(--ease), box-shadow var(--dur-2) var(--ease); }
.model:hover { border-color: var(--accent); transform: translateY(-1px); }
.model-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.model-head strong { font-size: 12.5px; font-weight: 620; }
.model-id { font-size: 10.5px; color: var(--dim); }
.model-desc { min-height: 16px; font-size: 10.5px; line-height: 1.5; color: var(--dim); }
.model-meta { display: flex; align-items: center; gap: 5px; margin-top: auto; }
.catalog-note { padding: 0 2px; font-size: 11px; color: var(--dim); line-height: 1.55; }
.catalog-note.warn { color: var(--amber); }
.copy-hint { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--dim-2); opacity: 0; transition: opacity var(--dur-1) var(--ease); }
.model:hover .copy-hint { opacity: 1; }
</style>
