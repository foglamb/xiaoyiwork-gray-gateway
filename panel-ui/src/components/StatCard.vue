<script setup>
import AppIcon from './AppIcon.vue'

defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: '—' },
  hint: { type: String, default: '' },
  tone: { type: String, default: '' },
  icon: { type: String, default: '' },
})
// Root element inherits fallthrough attrs (title, aria-*), so an exact value
// can be exposed on hover without adding another prop.
</script>

<template>
  <div class="stat" :class="tone">
    <div class="stat-head">
      <span class="stat-label">{{ label }}</span>
      <span v-if="icon" class="stat-icon"><AppIcon :name="icon" :size="14" /></span>
    </div>
    <div class="stat-value">{{ value }}</div>
    <div v-if="hint" class="stat-hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.stat {
  position: relative; overflow: hidden; min-width: 0;
  padding: 15px 16px 14px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-xs), var(--inner-top);
  transition: border-color var(--dur-2) var(--ease), box-shadow var(--dur-2) var(--ease);
}
.stat::before {
  content: ''; position: absolute; inset: 0 0 auto 0; height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent-line), transparent);
  opacity: 0; transition: opacity var(--dur-2) var(--ease);
}
.stat:hover { border-color: var(--line-strong); box-shadow: var(--shadow-sm), var(--inner-top); }
.stat:hover::before { opacity: 1; }
.stat-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.stat-label { font-size: 11px; color: var(--dim); font-weight: 550; }
.stat-icon { color: var(--dim-2); display: grid; place-items: center; }
.stat-value {
  margin-top: 6px;
  font-size: 24px; font-weight: 640; line-height: 1.18;
  letter-spacing: -0.03em;
  font-family: var(--font-mono);
}
.stat-hint { margin-top: 4px; font-size: 10.5px; color: var(--dim-2); }
.stat.ok .stat-value { color: var(--green); }
.stat.err .stat-value { color: var(--red); }
.stat.accent .stat-value { color: var(--accent-2); }
.stat.warn .stat-value { color: var(--amber); }

@media (max-width: 720px) {
  .stat { padding: 12px 13px 11px; }
  .stat-value { font-size: 20px; }
  .stat-hint { font-size: 10px; }
}
</style>
