<script setup>
import { computed, onBeforeUnmount, shallowRef } from 'vue'
import BaseDialog from './BaseDialog.vue'
import CodeBlock from './CodeBlock.vue'
import { api } from '../composables/useApi.js'
import { notify } from '../composables/useToast.js'

const props = defineProps({ pool: { type: String, default: 'gray' } })
const emit = defineEmits(['close', 'done'])

const session = shallowRef(null)
const callbackUrl = shallowRef('')
const status = shallowRef('idle')
const message = shallowRef('')
const importText = shallowRef('')
const mode = shallowRef('oauth')
let timer = null

const poolLabel = computed(() => (props.pool === 'gray' ? '灰度池' : '稳定池'))

async function startLogin() {
  status.value = 'starting'
  message.value = ''
  try {
    session.value = await api('/api/auth/oauth/start', { method: 'POST', body: JSON.stringify({ pool: props.pool }) })
    status.value = 'waiting'
    // Poll for the local-callback case; a remote browser finishes via the paste field.
    timer = setInterval(poll, 2000)
  } catch (error) {
    status.value = 'idle'
    message.value = error.message
  }
}

async function poll() {
  if (!session.value) return
  try {
    const result = await api(`/api/auth/oauth/status?state=${encodeURIComponent(session.value.state)}`)
    if (result.status === 'success') {
      stop()
      notify(`账号 ${result.account?.id || ''} ${result.account?.replaced ? '已替换原凭据' : `已加入${poolLabel.value}`}`, 'ok')
      emit('done')
    } else if (result.status === 'failed') {
      stop()
      status.value = 'failed'
      message.value = result.error || '授权失败'
    }
  } catch { /* keep polling; a transient error is not a failure */ }
}

async function submitCallback() {
  const value = callbackUrl.value.trim()
  if (!value) return
  status.value = 'completing'
  message.value = ''
  try {
    const result = await api('/api/auth/oauth/complete', { method: 'POST', body: JSON.stringify({ url: value }) })
    stop()
    notify(`账号 ${result.account?.id || ''} ${result.account?.replaced ? '已替换原凭据' : `已加入${poolLabel.value}`}`, 'ok')
    emit('done')
  } catch (error) {
    status.value = 'waiting'
    message.value = error.message
  }
}

async function doImport() {
  if (!importText.value.trim()) return
  status.value = 'completing'
  message.value = ''
  try {
    const result = await api('/api/auth/import', { method: 'POST', body: JSON.stringify({ text: importText.value, pool: props.pool }) })
    notify(`账号 ${result.account?.id || ''} ${result.account?.replaced ? '已替换原凭据' : `已导入${poolLabel.value}`}`, 'ok')
    emit('done')
  } catch (error) {
    message.value = error.message
    status.value = 'idle'
  } finally {
    status.value = status.value === 'completing' ? 'idle' : status.value
  }
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

async function cancel() {
  stop()
  if (session.value) await api('/api/auth/oauth/cancel', { method: 'POST', body: JSON.stringify({ state: session.value.state }) }).catch(() => {})
  emit('close')
}

onBeforeUnmount(stop)
</script>

<template>
  <BaseDialog title="添加小艺账号" :subtitle="`加入${poolLabel}，使用华为账号授权，无需填写接口凭据`" :width="620" @close="cancel">
    <div class="seg mode">
      <button type="button" :class="{ on: mode === 'oauth' }" @click="mode = 'oauth'">华为账号登录</button>
      <button type="button" :class="{ on: mode === 'import' }" @click="mode = 'import'">导入已有登录态</button>
    </div>

    <template v-if="mode === 'oauth'">
      <button v-if="!session" class="btn btn-primary start" type="button" :disabled="status === 'starting'" @click="startLogin">
        {{ status === 'starting' ? '生成中…' : '生成登录链接' }}
      </button>

      <div v-else class="steps">
        <section class="step">
          <div class="step-head"><span class="step-no">1</span><span>复制链接，在浏览器打开并用华为账号登录</span></div>
          <CodeBlock :code="session.url" multiline />
          <div class="row">
            <a class="btn btn-sm" :href="session.url" target="_blank" rel="noopener noreferrer">本机新窗口打开</a>
            <span class="muted tiny">授权页在华为域名下</span>
          </div>
        </section>

        <section class="step">
          <div class="step-head"><span class="step-no">2</span><span>登录后会跳到 127.0.0.1:17355，把地址栏整条网址粘到这里</span></div>
          <p class="muted tiny">打不开是正常的：回调地址指向网关所在机器，远程浏览器访问不到。</p>
          <input v-model="callbackUrl" class="input mono-input" placeholder="http://127.0.0.1:17355/auth/callback?code=…&state=…" spellcheck="false" />
          <button class="btn btn-primary" type="button" :disabled="!callbackUrl.trim() || status === 'completing'" @click="submitCallback">
            {{ status === 'completing' ? '登录中…' : '完成登录' }}
          </button>
        </section>

        <p v-if="status === 'waiting'" class="muted tiny waiting"><span class="pulse" />正在等待授权…</p>
        <p v-if="message" class="err">{{ message }}</p>
      </div>
    </template>

    <template v-else>
      <p class="muted tiny">从 magpie / OpenCode 小艺插件配置里复制账号 JSON（含 credential、uid、deviceId）。不要填别人分享的凭据。</p>
      <textarea v-model="importText" class="textarea mono-input" rows="6" placeholder='{"credential":"…","uid":"…","deviceId":"…","refreshToken":"…"}' spellcheck="false" />
      <p v-if="message" class="err">{{ message }}</p>
      <button class="btn btn-primary" type="button" :disabled="!importText.trim()" @click="doImport">导入到{{ poolLabel }}</button>
    </template>

    <template #footer>
      <button class="btn" type="button" @click="cancel">关闭</button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.mode { margin-bottom: 16px; }
.seg { display: inline-flex; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 2px; }
.seg button { border: 0; background: transparent; color: var(--dim); font-size: 11.5px; padding: 5px 13px; border-radius: 6px; font-weight: 500; }
.seg button.on { background: var(--surface-3); color: var(--text); font-weight: 600; }
.start { width: 100%; height: 38px; }
.steps { display: flex; flex-direction: column; gap: 18px; }
.step { display: flex; flex-direction: column; gap: 9px; }
.step-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: var(--text-2); }
.step-no {
  width: 19px; height: 19px; flex: none; border-radius: 50%;
  display: grid; place-items: center; font-size: 10.5px;
  background: var(--accent-soft); color: var(--accent-2); font-weight: 700;
}
.err { font-size: 11.5px; color: var(--red); margin: 0; }
.waiting { display: flex; align-items: center; gap: 7px; }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1.4s var(--ease) infinite; }
@keyframes pulse { 0%, 100% { opacity: 0.35 } 50% { opacity: 1 } }
</style>
