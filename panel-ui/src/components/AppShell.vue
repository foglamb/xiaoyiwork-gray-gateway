<script setup>
import { computed, shallowRef } from 'vue'
import { theme, toggleTheme } from '../composables/useTheme.js'

const props = defineProps({
  tabs: { type: Array, required: true },
  active: { type: String, required: true },
  service: { type: Object, default: () => ({}) },
  loading: { type: Boolean, default: false },
  healthy: { type: Boolean, default: true },
})
const emit = defineEmits(['update:active', 'refresh', 'logout'])
const collapsed = shallowRef(false)

const current = computed(() => props.tabs.find((tab) => tab.id === props.active))
</script>

<template>
  <div class="shell" :class="{ collapsed }">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">艺</div>
        <div v-show="!collapsed" class="brand-text">
          <strong>小艺Work</strong>
          <span>灰度网关</span>
        </div>
      </div>

      <nav class="nav">
        <button
          v-for="tab in tabs" :key="tab.id" type="button"
          class="nav-item" :class="{ on: tab.id === active }"
          :title="tab.label" @click="emit('update:active', tab.id)"
        >
          <span class="nav-icon" v-html="tab.icon" />
          <span v-show="!collapsed" class="nav-label">{{ tab.label }}</span>
          <span v-if="tab.badge && !collapsed" class="nav-badge">{{ tab.badge }}</span>
        </button>
      </nav>

      <div class="sidebar-foot">
        <button class="nav-item ghost" type="button" :title="collapsed ? '展开' : '收起'" @click="collapsed = !collapsed">
          <span class="nav-icon" v-html="collapsed ? '&#8594;' : '&#8592;'" />
          <span v-show="!collapsed" class="nav-label">收起</span>
        </button>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div class="title-block">
          <h1>{{ current?.label }}</h1>
          <p v-if="current?.hint" class="hint">{{ current.hint }}</p>
        </div>
        <div class="top-actions">
          <span class="health" :class="healthy ? 'ok' : 'err'">
            <span class="dot" />{{ healthy ? '运行中' : '异常' }}
          </span>
          <span v-if="service.version" class="version">v{{ service.version }}</span>
          <button class="btn btn-icon" type="button" title="刷新数据" :disabled="loading" @click="emit('refresh')">
            <span :class="{ spin: loading }">⟳</span>
          </button>
          <button class="btn btn-icon" type="button" :title="theme === 'dark' ? '切换浅色' : '切换深色'" @click="toggleTheme">
            {{ theme === 'dark' ? '☀' : '☾' }}
          </button>
          <button class="btn btn-sm" type="button" @click="emit('logout')">退出</button>
        </div>
      </header>
      <div class="content"><slot /></div>
    </main>
  </div>
</template>

<style scoped>
.shell { display: grid; grid-template-columns: 216px minmax(0, 1fr); min-height: 100vh; }
.shell.collapsed { grid-template-columns: 66px minmax(0, 1fr); }

.sidebar {
  display: flex; flex-direction: column; gap: 6px;
  padding: 16px 12px; background: var(--bg-elev);
  border-right: 1px solid var(--line); position: sticky; top: 0; height: 100vh;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 6px 6px 16px; }
.brand-mark {
  width: 32px; height: 32px; flex: none; border-radius: 9px;
  display: grid; place-items: center;
  background: linear-gradient(145deg, var(--accent), var(--accent-2));
  color: #fff; font-size: 16px; font-weight: 700;
  box-shadow: 0 6px 16px -6px var(--accent-glow);
}
.brand-text { display: flex; flex-direction: column; line-height: 1.25; overflow: hidden; }
.brand-text strong { font-size: 13px; font-weight: 650; letter-spacing: -0.01em; }
.brand-text span { font-size: 10.5px; color: var(--dim); }

.nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  display: flex; align-items: center; gap: 10px;
  height: 36px; padding: 0 10px; border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--dim); font-size: 12.5px; font-weight: 500;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
  text-align: left; width: 100%;
}
.nav-item:hover { background: var(--surface-2); color: var(--text-2); }
.nav-item.on { background: var(--accent-soft); color: var(--accent-2); font-weight: 600; }
.nav-item.ghost { color: var(--dim-2); }
.nav-icon { width: 16px; display: grid; place-items: center; font-size: 13px; flex: none; }
.nav-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-badge {
  font-size: 10px; font-family: var(--font-mono); color: var(--dim);
  background: var(--surface-3); border-radius: 999px; padding: 0 6px;
}
.sidebar-foot { margin-top: auto; }

.main { min-width: 0; display: flex; flex-direction: column; }
.topbar {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 15px 26px; background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: blur(14px); border-bottom: 1px solid var(--line);
}
.title-block h1 { font-size: 17px; font-weight: 650; letter-spacing: -0.02em; }
.hint { margin-top: 2px; font-size: 11.5px; color: var(--dim); }
.top-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.health {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  height: 27px; padding: 0 11px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
  white-space: nowrap;
}
.health.ok { background: var(--green-soft); color: var(--green); }
.health.err { background: var(--red-soft); color: var(--red); }
.version { font-size: 10.5px; color: var(--dim-2); font-family: var(--font-mono); }
.spin { display: inline-block; animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg) } }

.content { padding: 22px 26px 40px; display: flex; flex-direction: column; gap: 18px; }

@media (max-width: 860px) {
  .shell, .shell.collapsed { grid-template-columns: 1fr; }
  .sidebar {
    position: fixed; inset: auto 0 0 0; height: auto; flex-direction: row;
    align-items: center; gap: 4px; padding: 7px 8px; z-index: 40;
    border-right: 0; border-top: 1px solid var(--line); overflow-x: auto;
  }
  .brand, .sidebar-foot { display: none; }
  .nav { flex-direction: row; gap: 2px; }
  .nav-item { height: 42px; flex-direction: column; gap: 2px; padding: 4px 9px; font-size: 10px; }
  .nav-label { flex: none; font-size: 9.5px; }
  .nav-badge { display: none; }
  .content { padding: 16px 14px 84px; }
  .topbar { padding: 12px 14px; }
  .title-block { min-width: 0; }
  .title-block h1 { font-size: 15px; white-space: nowrap; }
  .hint { display: none; }
  .top-actions { gap: 5px; }
  .top-actions .version { display: none; }
}
</style>
