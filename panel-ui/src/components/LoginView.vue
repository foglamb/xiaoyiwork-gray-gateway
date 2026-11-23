<script setup>
import { shallowRef } from 'vue'
import { api, setAdminKey } from '../composables/useApi.js'
import { notify } from '../composables/useToast.js'

const emit = defineEmits(['authenticated'])
const key = shallowRef('')
const busy = shallowRef(false)
const error = shallowRef('')

async function submit() {
  const value = key.value.trim()
  if (!value) return
  busy.value = true
  error.value = ''
  try {
    await api('/api/state', { key: value })
    setAdminKey(value)
    notify('管理密钥验证成功', 'ok')
    emit('authenticated')
  } catch (err) {
    error.value = err.status === 401 ? '管理密钥不正确' : err.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card card">
      <div class="mark">艺</div>
      <h1>小艺Work 灰度网关</h1>
      <p class="sub">输入管理密钥以进入控制台</p>
      <form class="login-form" @submit.prevent="submit">
        <div class="field">
          <label for="admin-key">管理密钥 Admin Key</label>
          <input
            id="admin-key" v-model="key" type="password" class="input mono-input"
            placeholder="xyadm_…" autocomplete="off" spellcheck="false" autofocus
          />
        </div>
        <p v-if="error" class="err">{{ error }}</p>
        <button class="btn btn-primary login-btn" type="submit" :disabled="busy || !key.trim()">
          {{ busy ? '验证中…' : '进入控制台' }}
        </button>
      </form>
      <p class="foot">密钥仅保存在浏览器 sessionStorage，关闭标签页即失效</p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh; display: grid; place-items: center; padding: 24px;
  background: var(--bg); background-image: var(--grad-hero);
}
.login-card {
  width: 100%; max-width: 372px; padding: 34px 30px 26px;
  display: flex; flex-direction: column; align-items: center; text-align: center;
  border-radius: var(--r-xl); box-shadow: var(--shadow-lg);
}
.mark {
  width: 46px; height: 46px; border-radius: 13px; display: grid; place-items: center;
  background: linear-gradient(145deg, var(--accent), var(--accent-2));
  color: #fff; font-size: 22px; font-weight: 700;
  box-shadow: 0 10px 26px -10px var(--accent-glow);
}
h1 { margin-top: 16px; font-size: 18px; font-weight: 650; letter-spacing: -0.02em; }
.sub { margin-top: 5px; font-size: 12px; color: var(--dim); }
.login-form { width: 100%; margin-top: 22px; display: flex; flex-direction: column; gap: 12px; text-align: left; }
.login-btn { width: 100%; height: 38px; margin-top: 2px; }
.err { font-size: 11.5px; color: var(--red); margin: 0; }
.foot { margin-top: 18px; font-size: 10.5px; color: var(--dim-2); line-height: 1.5; }
</style>
