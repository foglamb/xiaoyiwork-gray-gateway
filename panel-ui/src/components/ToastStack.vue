<script setup>
import AppIcon from './AppIcon.vue'
import { toasts, dismiss } from '../composables/useToast.js'

const ICON = { ok: 'check', err: 'close', info: 'spark' }
</script>

<template>
  <div class="toast-stack">
    <TransitionGroup name="toast">
      <div v-for="item in toasts" :key="item.id" class="toast" :class="item.tone" @click="dismiss(item.id)">
        <span class="toast-icon"><AppIcon :name="ICON[item.tone] || 'spark'" :size="13" /></span>
        <span class="toast-text">{{ item.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-stack {
  position: fixed; bottom: calc(24px + var(--safe-b)); left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column-reverse; gap: 8px; z-index: 90; pointer-events: none;
  width: max-content; max-width: min(92vw, 460px);
}
.toast {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 15px 9px 11px; pointer-events: auto; cursor: pointer;
  background: color-mix(in srgb, var(--surface-2) 94%, transparent);
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  box-shadow: var(--shadow-lg);
  font-size: 12.5px;
  backdrop-filter: blur(14px);
}
.toast-icon {
  width: 20px; height: 20px; flex: none; border-radius: 50%;
  display: grid; place-items: center;
}
.toast.ok .toast-icon { background: var(--green-soft); color: var(--green); }
.toast.err .toast-icon { background: var(--red-soft); color: var(--red); }
.toast.info .toast-icon { background: var(--blue-soft); color: var(--blue); }
.toast-text { color: var(--text-2); }
.toast-enter-active, .toast-leave-active { transition: all 240ms var(--ease-out); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(12px) scale(0.94); }
</style>
