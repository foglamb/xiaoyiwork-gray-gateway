<script setup>
import { shallowRef } from 'vue'
import { copyText } from '../lib/clipboard.js'
import AppIcon from './AppIcon.vue'
import { notify } from '../composables/useToast.js'

const props = defineProps({
  code: { type: String, required: true },
  label: { type: String, default: '' },
  multiline: { type: Boolean, default: false },
})
const copied = shallowRef(false)

async function copy() {
  try { await copyText(props.code) }
  catch (error) { notify(error.message, 'err'); return }
  copied.value = true
  notify('已复制', 'ok', 1500)
  setTimeout(() => (copied.value = false), 1500)
}
</script>

<template>
  <div class="code-wrap">
    <div v-if="label" class="code-label">{{ label }}</div>
    <div class="code-row" :class="{ multiline }">
      <code>{{ code }}</code>
      <button class="copy" type="button" :title="copied ? '已复制' : '复制'" @click="copy">
        <AppIcon :name="copied ? 'check' : 'copy'" :size="13" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.code-wrap { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.code-label { font-size: 11px; color: var(--dim); font-weight: 550; }
.code-row {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 9px 9px 12px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  transition: border-color var(--dur-1) var(--ease);
}
.code-row:hover { border-color: var(--line-strong); }
.code-row.multiline { align-items: flex-start; }
.code-row code {
  flex: 1; min-width: 0; color: var(--text-2);
  font-size: 11.5px; line-height: 1.6;
  overflow-x: auto; white-space: nowrap;
}
.code-row.multiline code { white-space: pre-wrap; word-break: break-all; max-height: 132px; overflow-y: auto; }
.copy {
  width: 26px; height: 26px; flex: none;
  display: grid; place-items: center;
  background: transparent; border: 1px solid transparent; border-radius: var(--r-xs);
  color: var(--dim); transition: all var(--dur-1) var(--ease);
}
.copy:hover { background: var(--surface-3); border-color: var(--line); color: var(--text); }
</style>
