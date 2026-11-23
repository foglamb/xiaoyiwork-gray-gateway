<script setup>
import { computed, shallowRef } from 'vue'
import AppIcon from './AppIcon.vue'
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
          :title="collapsed ? tab.label : tab.hint"
          @click="emit('update:active', tab.id)"
        >
          <span class="nav-icon"><AppIcon :name="tab.icon" :size="17" /></span>
          <span v-show="!collapsed" class="nav-label">{{ tab.label }}</span>
          <span v-if="tab.badge && !collapsed" class="nav-badge">{{ tab.badge }}</span>
        </button>
      </nav>

      <div class="sidebar-foot">
        <button class="nav-item collapse" type="button" :title="collapsed ? '展开侧栏' : '收起侧栏'" @click="collapsed = !collapsed">
          <span class="nav-icon"><AppIcon :name="collapsed ? 'chevronRight' : 'chevronLeft'" :size="16" /></span>
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
            <AppIcon name="refresh" :size="15" :class="{ spin: loading }" />
          </button>
          <button class="btn btn-icon" type="button" :title="theme === 'dark' ? '切换浅色' : '切换深色'" @click="toggleTheme">
            <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="15" />
          </button>
          <button class="btn btn-icon logout" type="button" title="退出登录" @click="emit('logout')">
            <AppIcon name="logout" :size="15" />
          </button>
        </div>
      </header>
      <div class="content"><slot /></div>
    </main>
  </div>
</template>

<style scoped>
.shell { display: grid; grid-template-columns: 224px minmax(0, 1fr); min-height: 100vh; }
.shell.collapsed { grid-template-columns: 68px minmax(0, 1fr); }

.sidebar {
  display: flex; flex-direction: column; gap: 4px;
  padding: 18px 12px 14px;
  background: color-mix(in srgb, var(--bg-elev) 92%, transparent);
  backdrop-filter: blur(18px);
  border-right: 1px solid var(--line);
  position: sticky; top: 0; height: 100vh;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 6px 20px; }
.brand-mark {
  width: 34px; height: 34px; flex: none; border-radius: 10px;
  display: grid; place-items: center;
  background: linear-gradient(150deg, var(--accent), var(--accent-2));
  color: #fff; font-size: 16px; font-weight: 700; line-height: 1;
  box-shadow: 0 8px 20px -8px var(--accent-line), var(--inner-top);
}
.brand-text { display: flex; flex-direction: column; line-height: 1.3; overflow: hidden; }
.brand-text strong { font-size: 13px; font-weight: 650; }
.brand-text span { font-size: 10.5px; color: var(--dim-2); }

.nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  display: flex; align-items: center; gap: 10px;
  height: 38px; padding: 0 10px; border: 1px solid transparent; border-radius: var(--r-sm);
  background: transparent; color: var(--dim);
  font-size: 12.5px; font-weight: 550; text-align: left; width: 100%;
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
}
.nav-item:hover { background: var(--surface-2); color: var(--text-2); }
.nav-item.on {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-2);
  font-weight: 620;
  box-shadow: var(--inner-top);
}
.nav-icon { width: 18px; display: grid; place-items: center; flex: none; }
.nav-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-badge {
  font-size: 10px; font-family: var(--font-mono); font-weight: 600;
  color: var(--dim); background: var(--surface-3);
  border-radius: 999px; padding: 1px 7px; line-height: 1.5;
}
.nav-item.on .nav-badge { background: var(--accent-line); color: var(--accent-2); }
.nav-item.collapse { color: var(--dim-2); }
.sidebar-foot { margin-top: auto; }

.main { min-width: 0; display: flex; flex-direction: column; }
.topbar {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 16px 28px;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(20px) saturate(150%);
  border-bottom: 1px solid var(--line);
}
.title-block { min-width: 0; }
.title-block h1 { font-size: 18px; font-weight: 660; line-height: 1.3; }
.hint { margin-top: 2px; font-size: 12px; color: var(--dim); }
.top-actions { display: flex; align-items: center; gap: 7px; flex: none; }
.health {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  height: 28px; padding: 0 11px; border-radius: 999px;
  font-size: 11.5px; font-weight: 620; white-space: nowrap;
  border: 1px solid transparent;
}
.health.ok { background: var(--green-soft); border-color: var(--green-line); color: var(--green); }
.health.err { background: var(--red-soft); border-color: rgba(255, 111, 138, 0.3); color: var(--red); }
.health .dot { width: 6px; height: 6px; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 22%, transparent); }
.version { font-size: 10.5px; color: var(--dim-2); font-family: var(--font-mono); }
.logout:hover { color: var(--red) !important; background: var(--red-soft) !important; }
.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg) } }

.content {
  padding: 24px 28px 44px;
  display: flex; flex-direction: column; gap: 18px;
  max-width: 1520px; width: 100%;
}

/* ---------- tablet ---------- */
@media (max-width: 1080px) {
  .shell, .shell.collapsed { grid-template-columns: 68px minmax(0, 1fr); }
  .sidebar .brand-text, .sidebar .nav-label, .sidebar .nav-badge { display: none !important; }
  .sidebar { align-items: stretch; padding: 16px 10px; }
  .brand { justify-content: center; padding: 4px 0 18px; }
  .nav-item { justify-content: center; padding: 0; }
  .content { padding: 20px 20px 40px; }
  .topbar { padding: 14px 20px; }
}

/* ---------- phone ---------- */
@media (max-width: 720px) {
  .shell, .shell.collapsed { grid-template-columns: minmax(0, 1fr); }
  .sidebar {
    position: fixed; inset: auto 0 0 0; height: auto;
    flex-direction: row; align-items: center; justify-content: space-around;
    gap: 0; padding: 6px 6px calc(6px + var(--safe-b));
    border-right: 0; border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--bg-elev) 94%, transparent);
    backdrop-filter: blur(22px) saturate(160%);
    z-index: 50;
  }
  .brand, .sidebar-foot { display: none; }
  .nav { flex-direction: row; flex: 1; justify-content: space-around; gap: 0; }
  .nav-item {
    height: 46px; flex-direction: column; justify-content: center; gap: 3px;
    padding: 0 4px; font-size: 9.5px; font-weight: 550; flex: 1;
    border-radius: var(--r-xs);
  }
  .nav-item .nav-label,
  .sidebar .nav-label { display: block !important; flex: none; font-size: 9.5px; letter-spacing: 0; }
  .nav-icon { width: auto; }
  .nav-item.on { background: transparent; border-color: transparent; color: var(--accent-2); }
  .nav-item.on .nav-label { font-weight: 650; }

  .topbar {
    padding: 11px 14px; gap: 10px;
    align-items: center;
  }
  .title-block h1 { font-size: 16px; white-space: nowrap; }
  .hint { display: none; }
  .top-actions { gap: 4px; }
  .top-actions .version { display: none; }
  .top-actions .btn-icon { width: 32px; height: 32px; }
  .health { height: 26px; padding: 0 9px; font-size: 10.5px; }

  .content {
    padding: 14px 13px calc(78px + var(--safe-b));
    gap: 13px;
  }
}
</style>
