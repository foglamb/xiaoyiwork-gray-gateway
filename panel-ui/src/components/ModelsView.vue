<script setup>
import { computed, shallowRef } from 'vue'
import AppIcon from './AppIcon.vue'
import { models } from '../composables/useDashboard.js'
import { notify } from '../composables/useToast.js'

const query = shallowRef('')

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
          <span v-if="model.rate" class="badge">{{ model.rate }}</span>
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
.copy-hint { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--dim-2); opacity: 0; transition: opacity var(--dur-1) var(--ease); }
.model:hover .copy-hint { opacity: 1; }
</style>
