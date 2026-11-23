<script setup>
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: '—' },
  hint: { type: String, default: '' },
  tone: { type: String, default: '' },
  trend: { type: Number, default: null },
})
</script>

<template>
  <div class="stat" :class="tone">
    <div class="stat-head">
      <span class="stat-label">{{ label }}</span>
      <span v-if="trend !== null" class="stat-trend" :class="trend >= 0 ? 'up' : 'down'">
        {{ trend >= 0 ? '▲' : '▼' }} {{ Math.abs(trend).toFixed(1) }}%
      </span>
    </div>
    <div class="stat-value">{{ value }}</div>
    <div v-if="hint" class="stat-hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.stat {
  position: relative; overflow: hidden;
  padding: 15px 16px 13px;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-md); min-width: 0;
  transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.stat::after {
  content: ''; position: absolute; inset: 0 0 auto 0; height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent-glow), transparent);
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.stat:hover { border-color: var(--dim-2); }
.stat:hover::after { opacity: 1; }
.stat-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.stat-label { font-size: 11px; color: var(--dim); font-weight: 500; }
.stat-value {
  margin-top: 5px; font-size: 23px; font-weight: 650; letter-spacing: -0.02em;
  font-family: var(--font-mono); line-height: 1.2;
}
.stat-hint { margin-top: 3px; font-size: 10.5px; color: var(--dim-2); }
.stat-trend { font-size: 10.5px; font-family: var(--font-mono); }
.stat-trend.up { color: var(--green); }
.stat-trend.down { color: var(--red); }
.stat.ok .stat-value { color: var(--green); }
.stat.err .stat-value { color: var(--red); }
.stat.accent .stat-value { color: var(--accent-2); }
.stat.warn .stat-value { color: var(--amber); }
</style>
