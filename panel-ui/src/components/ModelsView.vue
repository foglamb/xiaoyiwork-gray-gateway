<script setup>
import { computed, shallowRef } from 'vue'
import AppIcon from './AppIcon.vue'
import { models, state } from '../composables/useDashboard.js'
import { api } from '../composables/useApi.js'
import { notify } from '../composables/useToast.js'

const emit = defineEmits(['changed'])
const query = shallowRef('')
const refreshing = shallowRef(false)
const catalog = computed(() => state.value?.modelCatalog || {})
const sourceLabel = { upstream: '上游', observed: '调用记录', config: '配置', 'upstream-cache': '上游缓存' }

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
      <button class="btn btn-sm" type="button" :disabled="refreshing" @click="refreshModels">
        <AppIcon name="refresh" :size="12" /> {{ refreshing ? '刷新中…' : '从上游刷新' }}
      </button>
    </div>
    <div class="catalog-note" :class="{ warn: catalog.ok === false }">
      {{ catalog.message || '模型目录准备中' }}；标记为「调用记录」的模型来自真实请求，不是上游目录。
    </div>

    <div class="grid">
      <article v-for="model in filtered" :key="model.id" class="model card" @click="copy(model.id)">
        <div class="model-head">
          <strong class="truncate">{{ model.name || model.id }}</strong>
          <span v-if="model.gray" class="badge warn">灰度</span>
        </div>
        <code class="model-id truncate">{{ model.id }}</code>
        <div class="model-meta">
          <span v-if="model.vision" class="badge info">视觉</span>
          <span class="badge">{{ sourceLabel[model.source] || model.source || '记录' }}</span>
          <span class="grow" />
          <span class="copy-hint"><AppIcon name="copy" :size="11" /> 复制</span>
        </div>
      </article>
      <div v-if="!filtered.length" class="empty-state">没有匹配的模型</div>
    </div>
  </div>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: 14px; }
.toolbar { display: flex; align-items: center; gap: 12px; padding: 11px 14px; }
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
.model-meta { display: flex; align-items: center; gap: 5px; }
.catalog-note { padding: 0 2px; font-size: 11px; color: var(--dim); line-height: 1.55; }
.catalog-note.warn { color: var(--amber); }
.copy-hint { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--dim-2); opacity: 0; transition: opacity var(--dur-1) var(--ease); }
.model:hover .copy-hint { opacity: 1; }
</style>
