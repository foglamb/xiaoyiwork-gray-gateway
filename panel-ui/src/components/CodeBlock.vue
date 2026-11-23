<script setup>
import { shallowRef } from 'vue'
import { notify } from '../composables/useToast.js'

const props = defineProps({
  code: { type: String, required: true },
  label: { type: String, default: '' },
  multiline: { type: Boolean, default: false },
})
const copied = shallowRef(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(props.code)
  } catch {
    const area = document.createElement('textarea')
    area.value = props.code
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
  copied.value = true
  notify('已复制', 'ok', 1600)
  setTimeout(() => (copied.value = false), 1600)
}
</script>

<template>
  <div class="code-wrap">
    <div v-if="label" class="code-label">{{ label }}</div>
    <div class="code-row" :class="{ multiline }">
      <code>{{ code }}</code>
      <button class="btn btn-sm btn-icon" type="button" :title="copied ? '已复制' : '复制'" @click="copy">
        {{ copied ? '✓' : '⧉' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.code-wrap { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.code-label { font-size: 11px; color: var(--dim); }
.code-row {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px 7px 11px;
  background: var(--bg-elev); border: 1px solid var(--line);
  border-radius: var(--r-sm);
}
.code-row.multiline { align-items: flex-start; }
.code-row code {
  flex: 1; min-width: 0; color: var(--text-2); font-size: 11.5px;
  overflow-x: auto; white-space: nowrap;
}
.code-row.multiline code { white-space: pre-wrap; word-break: break-all; max-height: 110px; }
</style>
