<script setup>
import { shallowRef } from 'vue'
import AppIcon from './AppIcon.vue'
import { api, setAdminKey } from '../composables/useApi.js'
import { notify } from '../composables/useToast.js'

const emit = defineEmits(['authenticated'])
const key = shallowRef('')
const busy = shallowRef(false)
const error = shallowRef('')
const reveal = shallowRef(false)

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
    <div class="aurora" aria-hidden="true" />
    <form class="login-card card card-elev" @submit.prevent="submit">
      <div class="mark">艺</div>
      <h1>小艺Work 灰度网关</h1>
      <p class="sub">输入管理密钥进入控制台</p>

      <div class="field">
        <label for="admin-key">管理密钥 Admin Key</label>
        <div class="key-row">
          <input
            id="admin-key" v-model="key" :type="reveal ? 'text' : 'password'"
            class="input mono-input" placeholder="xyadm_…"
            autocomplete="off" spellcheck="false" autofocus
          />
          <button class="btn btn-icon reveal" type="button" :title="reveal ? '隐藏' : '显示'" @click="reveal = !reveal">
            <AppIcon :name="reveal ? 'shield' : 'search'" :size="15" />
          </button>
        </div>
      </div>

      <p v-if="error" class="err">{{ error }}</p>

      <button class="btn btn-primary submit" type="submit" :disabled="busy || !key.trim()">
        {{ busy ? '验证中…' : '进入控制台' }}
      </button>

      <p class="foot">密钥只保存在浏览器 sessionStorage，关闭标签页即失效</p>
    </form>
  </div>
</template>

<style scoped>
.login-page {
  position: relative; min-height: 100vh; display: grid; place-items: center;
  padding: 24px; overflow: hidden;
}
.aurora {
  position: absolute; inset: -20% -10% auto -10%; height: 70vh; pointer-events: none;
  background:
    radial-gradient(46% 60% at 32% 24%, var(--accent-soft), transparent 70%),
    radial-gradient(38% 52% at 76% 12%, var(--blue-soft), transparent 72%);
  filter: blur(26px);
}
.login-card {
  position: relative; width: 100%; max-width: 380px;
  padding: 34px 30px 26px;
  display: flex; flex-direction: column; gap: 16px;
  border-radius: var(--r-2xl);
  box-shadow: var(--shadow-lg);
}
.mark {
  width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center;
  background: linear-gradient(150deg, var(--accent), var(--accent-2));
  color: #fff; font-size: 22px; font-weight: 700; line-height: 1;
  box-shadow: 0 12px 28px -12px var(--accent-line), var(--inner-top);
}
h1 { font-size: 19px; font-weight: 660; line-height: 1.3; }
.sub { margin-top: -10px; font-size: 12.5px; color: var(--dim); }
.key-row { display: flex; gap: 7px; }
.reveal { flex: none; }
.err { font-size: 11.5px; color: var(--red); margin: -6px 0 0; }
.submit { width: 100%; height: 40px; font-size: 13px; }
.foot { font-size: 10.5px; color: var(--dim-2); line-height: 1.6; text-align: center; margin-top: -4px; }

@media (max-width: 720px) {
  .login-page { padding: 16px; }
  .login-card { padding: 26px 20px 22px; gap: 14px; }
  h1 { font-size: 17px; }
}
</style>
