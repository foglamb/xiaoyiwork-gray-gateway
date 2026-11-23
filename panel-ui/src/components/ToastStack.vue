<script setup>
import { toasts, dismiss } from '../composables/useToast.js'
</script>

<template>
  <div class="toast-stack">
    <TransitionGroup name="toast">
      <div v-for="item in toasts" :key="item.id" class="toast" :class="item.tone" @click="dismiss(item.id)">
        <span class="toast-dot" />
        <span class="toast-text">{{ item.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-stack {
  position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; gap: 8px; z-index: 90; pointer-events: none;
}
.toast {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 15px; pointer-events: auto; cursor: pointer;
  background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 999px; box-shadow: var(--shadow-lg); font-size: 12.5px;
  max-width: min(90vw, 520px);
}
.toast-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.toast.ok .toast-dot { background: var(--green); }
.toast.err .toast-dot { background: var(--red); }
.toast.info .toast-dot { background: var(--blue); }
.toast-text { color: var(--text-2); }
.toast-enter-active, .toast-leave-active { transition: all 220ms var(--ease); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(10px) scale(0.96); }
</style>
