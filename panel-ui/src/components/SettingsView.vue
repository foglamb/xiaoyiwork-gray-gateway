<script setup>
import { computed, onMounted, shallowRef } from 'vue'
import CodeBlock from './CodeBlock.vue'
import { state, refreshAll } from '../composables/useDashboard.js'
import { api, setAdminKey } from '../composables/useApi.js'
import { notify } from '../composables/useToast.js'

const emit = defineEmits(['logout', 'changed'])
const keys = shallowRef({ apiKey: '', adminKey: '' })
const draft = shallowRef({ apiKey: '', adminKey: '' })
const busy = shallowRef(false)
const revealed = shallowRef(false)

const baseUrl = computed(() => state.value?.endpoint?.currentUrl || '')
const lanUrls = computed(() => state.value?.endpoint?.lanUrls || [])

onMounted(async () => {
  try {
    keys.value = await api('/api/keys')
    draft.value = { ...keys.value }
  } catch (error) {
    notify(error.message, 'err')
  }
})

const masked = (value) => (revealed.value ? value : `${value.slice(0, 8)}${'•'.repeat(18)}${value.slice(-4)}`)

async function saveKeys() {
  busy.value = true
  try {
    const next = await api('/api/keys', { method: 'POST', body: draft.value })
    keys.value = next
    draft.value = { ...next }
    setAdminKey(next.adminKey)
    notify('密钥已更新，管理密钥同步生效', 'ok')
    emit('changed')
  } catch (error) {
    notify(error.message, 'err')
  } finally {
    busy.value = false
  }
}

async function rotate(field) {
  const prefix = field === 'adminKey' ? 'xyadm_' : 'xy_'
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const body = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 32)
  draft.value = { ...draft.value, [field]: `${prefix}${body}` }
  notify('已生成新密钥，记得点保存', 'info')
}

const clientConfig = computed(() => JSON.stringify({
  baseURL: baseUrl.value,
  apiKey: keys.value.apiKey,
  model: state.value?.models?.[0]?.id || 'Kimi_K3.1_Pro_VE',
}, null, 2))

const curlSample = computed(() => `curl ${baseUrl.value}/chat/completions \\
  -H "Authorization: Bearer ${keys.value.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${state.value?.models?.[0]?.id || 'Kimi_K3.1_Pro_VE'}","messages":[{"role":"user","content":"你好"}]}'`)
</script>

<template>
  <div class="stack">
    <section class="card card-pad">
      <span class="kicker">ENDPOINT</span>
      <h3 class="mt">接入地址</h3>
      <div class="endpoints">
        <CodeBlock :code="baseUrl" label="当前访问地址（推荐）" />
        <CodeBlock v-if="lanUrls[0] && lanUrls[0] !== baseUrl" :code="lanUrls[0]" label="局域网地址" />
      </div>
    </section>

    <section class="card card-pad">
      <div class="row">
        <div class="grow">
          <span class="kicker">CREDENTIALS</span>
          <h3 class="mt">访问密钥</h3>
        </div>
        <button class="btn btn-sm" type="button" @click="revealed = !revealed">{{ revealed ? '隐藏' : '显示' }}</button>
      </div>

      <div class="key-grid">
        <div class="field">
          <label>Admin Key（面板登录）</label>
          <div class="row">
            <input v-model="draft.adminKey" class="input mono-input" spellcheck="false" />
            <button class="btn btn-sm" type="button" @click="rotate('adminKey')">生成</button>
          </div>
          <span class="muted tiny">当前：{{ masked(keys.adminKey || '') }}</span>
        </div>
        <div class="field">
          <label>API Key（客户端调用）</label>
          <div class="row">
            <input v-model="draft.apiKey" class="input mono-input" spellcheck="false" />
            <button class="btn btn-sm" type="button" @click="rotate('apiKey')">生成</button>
          </div>
          <span class="muted tiny">当前：{{ masked(keys.apiKey || '') }}</span>
        </div>
      </div>

      <div class="row save-row">
        <button class="btn btn-primary" type="button" :disabled="busy" @click="saveKeys">{{ busy ? '保存中…' : '保存密钥' }}</button>
        <span class="muted tiny">修改 Admin Key 后需要用它重新登录</span>
      </div>
    </section>

    <section class="two">
      <div class="card card-pad">
        <span class="kicker">CLIENT</span>
        <h3 class="mt">客户端配置</h3>
        <p class="muted tiny mb">OpenAI 兼容，填进任意支持自定义 baseURL 的客户端。</p>
        <CodeBlock :code="clientConfig" multiline />
      </div>
      <div class="card card-pad">
        <span class="kicker">CURL</span>
        <h3 class="mt">快速验证</h3>
        <p class="muted tiny mb">复制到终端执行，能返回 JSON 即接入成功。</p>
        <CodeBlock :code="curlSample" multiline />
      </div>
    </section>

    <section class="card card-pad">
      <span class="kicker">RUNTIME</span>
      <h3 class="mt">运行状态</h3>
      <div class="runtime">
        <div><span>版本</span><b>{{ state?.service?.version || '—' }}</b></div>
        <div><span>监听</span><b>{{ state?.service?.listen }}:{{ state?.service?.port }}</b></div>
        <div><span>启动时间</span><b>{{ state?.service?.startedAt ? new Date(state.service.startedAt).toLocaleString('zh-CN') : '—' }}</b></div>
        <div><span>请求超时</span><b>{{ state?.requestTimeoutMs }} ms</b></div>
        <div><span>灰度比例</span><b>{{ state?.gray?.percentage ?? 0 }}%</b></div>
        <div><span>账号数</span><b>{{ (state?.accounts || []).length }}</b></div>
      </div>
    </section>

    <section class="card card-pad danger-zone">
      <div class="row">
        <div class="grow">
          <span class="kicker">SESSION</span>
          <h3 class="mt">退出登录</h3>
          <p class="muted tiny">清除浏览器里保存的管理密钥，不影响网关运行。</p>
        </div>
        <button class="btn btn-danger" type="button" @click="emit('logout')">退出</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: 14px; }
.mt { margin-top: 4px; font-size: 14.5px; font-weight: 640; }
.mb { margin: 4px 0 12px; }
.endpoints { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.key-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 16px; margin-top: 14px; }
.save-row { margin-top: 16px; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.runtime { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 14px; }
.runtime div { display: flex; flex-direction: column; gap: 2px; }
.runtime span { font-size: 10.5px; color: var(--dim); }
.runtime b { font-size: 12.5px; font-family: var(--font-mono); font-weight: 600; color: var(--text-2); }
.danger-zone { border-color: color-mix(in srgb, var(--red) 30%, var(--line)); }
</style>
