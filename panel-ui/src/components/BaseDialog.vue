<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  width: { type: Number, default: 560 },
})
const emit = defineEmits(['close'])
const panel = ref(null)

function onKey(event) {
  if (event.key === 'Escape') emit('close')
}
onMounted(() => {
  document.addEventListener('keydown', onKey)
  document.body.style.overflow = 'hidden'
  panel.value?.focus()
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @mousedown.self="emit('close')">
      <div ref="panel" class="panel" :style="{ maxWidth: `${width}px` }" tabindex="-1" role="dialog" aria-modal="true">
        <header class="panel-head">
          <div>
            <h3>{{ title }}</h3>
            <p v-if="subtitle" class="sub">{{ subtitle }}</p>
          </div>
          <button class="btn btn-ghost btn-icon" type="button" aria-label="关闭" @click="emit('close')">✕</button>
        </header>
        <div class="panel-body"><slot /></div>
        <footer v-if="$slots.footer" class="panel-foot"><slot name="footer" /></footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: center; justify-content: center;
  padding: 20px; background: rgba(4, 5, 9, 0.62); backdrop-filter: blur(6px);
  animation: fade 160ms var(--ease);
}
.panel {
  width: 100%; max-height: calc(100vh - 40px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-xl); box-shadow: var(--shadow-lg); overflow: hidden;
  animation: rise 220ms var(--ease);
}
.panel-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding: 18px 20px 14px; border-bottom: 1px solid var(--line-soft);
}
.panel-head h3 { font-size: 15px; font-weight: 620; letter-spacing: -0.01em; }
.sub { margin-top: 3px; font-size: 11.5px; color: var(--dim); }
.panel-body { padding: 18px 20px; overflow-y: auto; }
.panel-foot {
  display: flex; justify-content: flex-end; gap: 9px;
  padding: 13px 20px; border-top: 1px solid var(--line-soft); background: var(--surface-2);
}
@keyframes fade { from { opacity: 0 } }
@keyframes rise { from { opacity: 0; transform: translateY(14px) scale(0.985) } }
</style>
