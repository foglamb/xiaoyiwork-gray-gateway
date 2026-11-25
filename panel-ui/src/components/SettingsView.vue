<script setup>
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import CodeBlock from './CodeBlock.vue'
import { state, acceptSettingsSnapshot } from '../composables/useDashboard.js'
import { api, setAdminKey } from '../composables/useApi.js'
import { notify } from '../composables/useToast.js'
import { cloneSettings, settingsFromState, settingsEqual, settingsSync, settingsPayload, savedSettings } from '../lib/settings.js'

const emit = defineEmits(['logout', 'changed'])
const keys = shallowRef({ apiKey: '', adminKey: '' })
const tune = ref(settingsFromState(state.value))
const baseline = shallowRef(cloneSettings(tune.value))
const dirty = computed(() => !settingsEqual(tune.value, baseline.value))
const savingTune = shallowRef(false)
const allModels = computed(() => state.value?.models || [])
const draft = shallowRef({ apiKey: '', adminKey: '' })
const busy = shallowRef(false)
const revealed = shallowRef(false)

const baseUrl = computed(() => state.value?.endpoint?.currentUrl || '')
const lanUrls = computed(() => state.value?.endpoint?.lanUrls || [])

function syncTune() {
  const next = settingsSync(tune.value, baseline.value, state.value, savingTune.value)
  if (!next) return
  baseline.value = cloneSettings(next)
  tune.value = next
}
watch(() => state.value, syncTune, { immediate: true })
function resetTune() { tune.value = cloneSettings(baseline.value) }

async function saveTune() {
  const submitted = cloneSettings(tune.value)
  savingTune.value = true
  try {
    await api('/api/settings', { method: 'POST', body: settingsPayload(submitted) })
    const saved = savedSettings(tune.value, submitted)
    baseline.value = saved.baseline
    tune.value = saved.draft
    acceptSettingsSnapshot(submitted)
    notify('运行参数已保存并生效', 'ok')
    emit('changed')
  } catch (error) {
    notify(error.message, 'err')
  } finally {
    savingTune.value = false
  }
}

onMounted(async () => {
  try {
    keys.value = await api('/api/keys')
    draft.value = { ...keys.value }
  } catch (error) {
    notify(error.message, 'err')
  }
})

const masked = (value) => (revealed.value ? value : value ? '••••••••••••••••' : '—')

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
  apiKey: revealed.value ? keys.value.apiKey : 'YOUR_API_KEY',
  model: state.value?.models?.[0]?.id || 'Kimi_K3.1_Pro_VE',
}, null, 2))

const curlSample = computed(() => `curl ${baseUrl.value}/chat/completions \\
  -H "Authorization: Bearer ${revealed.value ? keys.value.apiKey : 'YOUR_API_KEY'}" \\
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
        <button class="btn btn-sm" type="button" @click="revealed = !revealed">
          <AppIcon :name="revealed ? 'shield' : 'search'" :size="12" /> {{ revealed ? '隐藏' : '显示' }}
        </button>
      </div>

      <div class="key-grid">
        <div class="field">
          <label>Admin Key（面板登录）</label>
          <div class="row">
            <input v-model="draft.adminKey" :type="revealed ? 'text' : 'password'" autocomplete="new-password" class="input mono-input" spellcheck="false" />
            <button class="btn btn-sm" type="button" @click="rotate('adminKey')"><AppIcon name="spark" :size="12" /> 生成</button>
          </div>
          <span class="muted tiny">当前：{{ masked(keys.adminKey || '') }}</span>
        </div>
        <div class="field">
          <label>API Key（客户端调用）</label>
          <div class="row">
            <input v-model="draft.apiKey" :type="revealed ? 'text' : 'password'" autocomplete="new-password" class="input mono-input" spellcheck="false" />
            <button class="btn btn-sm" type="button" @click="rotate('apiKey')"><AppIcon name="spark" :size="12" /> 生成</button>
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
      <span class="kicker">Tuning</span>
      <h3 class="mt">运行调优</h3>
      <p class="muted tiny mb">这些参数保存后立即生效，无需重启。{{ dirty ? '有未保存修改，自动刷新会保留编辑内容。' : '当前设置已同步。' }}</p>
      <button v-if="dirty" class="btn btn-sm mb" type="button" :disabled="savingTune" @click="resetTune">撤销未保存修改</button>
      <div class="tune-grid">
        <div class="field">
          <label>请求超时 requestTimeoutMs</label>
          <input v-model.number="tune.requestTimeoutMs" class="input" type="number" min="1000" step="1000" />
          <span class="muted tiny">流式请求的总超时，思考型模型建议 ≥ 120000</span>
        </div>
        <div class="field">
          <label>请求体上限 maxBodyBytes</label>
          <input v-model.number="tune.maxBodyBytes" class="input" type="number" min="1024" step="1024" />
          <span class="muted tiny">网关接收约 {{ (tune.maxBodyBytes / 1048576).toFixed(1) }} MB；上游仍受下方 4.5 MiB 限制</span>
        </div>
        <div class="field">
          <label>账号探活间隔 accountProbeMinutes</label>
          <input v-model.number="tune.accountProbeMinutes" class="input" type="number" min="0" step="1" />
          <span class="muted tiny">0 = 关闭定时探活</span>
        </div>
        <div class="field">
          <label>流式心跳 streamHeartbeatMs</label>
          <input v-model.number="tune.streamHeartbeatMs" class="input" type="number" min="0" step="1000" />
          <span class="muted tiny">上游静默多久注入 keepalive，0 = 关闭</span>
        </div>
        <div class="field">
          <label>日志分页缓存 logMaxEntries</label>
          <input v-model.number="tune.logMaxEntries" class="input" type="number" min="50" max="5000" step="50" />
          <span class="muted tiny">仅内存与分页，不影响磁盘统计；50–5000</span>
        </div>
        <div class="field">
          <label>面板局域网访问</label>
          <label class="inline-check">
            <input v-model="tune.allowPanelFromLan" type="checkbox" />
            <span>允许局域网打开面板</span>
          </label>
          <span class="muted tiny">关闭后仅本机可访问管理面板</span>
        </div>
      </div>
      <div class="row save-row">
        <button class="btn btn-primary" type="button" :disabled="savingTune || !dirty" @click="saveTune">
          {{ savingTune ? '保存中…' : '保存调优' }}
        </button>
        <span class="muted tiny">端口、监听地址与上游地址需改配置文件并重启</span>
      </div>
    </section>

    <section class="card card-pad">
      <span class="kicker">UPSTREAM MODELS</span>
      <h3 class="mt">模型目录与请求兼容</h3>
      <p class="muted tiny mb">这些开关只影响转发适配，不改变模型目录的真实来源。</p>
      <div class="tune-grid">
        <div class="field">
          <label>目录自动刷新 modelCatalogMinutes</label>
          <input v-model.number="tune.modelCatalogMinutes" class="input" type="number" min="0" step="1" />
          <span class="muted tiny">从 HAG 获取真实模型；0 = 仅启动和手动刷新</span>
        </div>
        <div class="field">
          <label>上游体积上限 upstreamBodyLimitBytes</label>
          <input v-model.number="tune.upstreamBodyLimitBytes" class="input" type="number" min="65536" max="4718592" step="1024" />
          <span class="muted tiny">{{ (tune.upstreamBodyLimitBytes / 1048576).toFixed(2) }} MiB；最高 4.5 MiB，超出返回 413</span>
        </div>
        <div class="field">
          <label>Kimi 参数兼容</label>
          <label class="inline-check"><input v-model="tune.kimiCompatibility" type="checkbox" /><span>修正 temperature 与具名 tool_choice</span></label>
          <span class="muted tiny">避免 11115 / server inner</span>
        </div>
        <div class="field">
          <label>工具 Schema 归一化</label>
          <label class="inline-check"><input v-model="tune.normalizeToolSchemas" type="checkbox" /><span>内联 $ref 并补全 enum/const 类型</span></label>
          <span class="muted tiny">关闭后原样转发工具 Schema</span>
        </div>
        <div class="field">
          <label>SSE 错帧快速失败</label>
          <label class="inline-check"><input v-model="tune.upstreamErrorFastFail" type="checkbox" /><span>收到错误帧立即中断上游读取</span></label>
          <span class="muted tiny">仍向客户端发送标准错误和 [DONE]</span>
        </div>
      </div>
      <div class="row save-row">
        <button class="btn btn-primary" type="button" :disabled="savingTune || !dirty" @click="saveTune">保存模型兼容设置</button>
        <span class="muted tiny">保存后立即应用到新请求，无需重启</span>
      </div>
    </section>

    <section class="card card-pad">
      <span class="kicker">Models</span>
      <h3 class="mt">灰度模型白名单</h3>
      <p class="muted tiny mb">勾选的模型默认不对普通请求开放，需在灰度控制台里决定是否对外暴露。</p>
      <div class="model-pick">
        <label v-for="m in allModels" :key="m.id" class="pick" :class="{ on: tune.grayModelIds.includes(m.id) }">
          <input v-model="tune.grayModelIds" type="checkbox" :value="m.id" />
          <span>{{ m.name || m.id }}</span>
        </label>
      </div>
      <div class="row save-row">
        <button class="btn btn-primary" type="button" :disabled="savingTune || !dirty" @click="saveTune">保存模型白名单</button>
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
        <button class="btn btn-danger" type="button" @click="emit('logout')"><AppIcon name="logout" :size="13" /> 退出</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: 16px; }
.mt { margin-top: 5px; font-size: 15px; font-weight: 640; }
.mb { margin: 4px 0 12px; }
.endpoints { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.key-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 16px; margin-top: 14px; }
.save-row { margin-top: 16px; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.runtime { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 14px; }
.runtime div { display: flex; flex-direction: column; gap: 2px; }
.runtime span { font-size: 10.5px; color: var(--dim); }
.runtime b { font-size: 12.5px; font-family: var(--font-mono); font-weight: 600; color: var(--text-2); }
.danger-zone { border-color: color-mix(in srgb, var(--red) 26%, var(--line)); }
.tune-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 15px; }
.inline-check { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-2); cursor: pointer; height: 36px; }
.inline-check input { accent-color: var(--accent); }
.model-pick { display: flex; flex-wrap: wrap; gap: 7px; }
.pick {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  padding: 6px 11px; border-radius: var(--r-sm);
  border: 1px solid var(--line); background: var(--surface-2);
  font-size: 11.5px; color: var(--dim);
  transition: all var(--dur-1) var(--ease);
}
.pick input { accent-color: var(--accent); }
.pick:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.pick:hover { border-color: var(--line-strong); color: var(--text-2); }
.pick.on { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent-2); font-weight: 600; }

@media (max-width: 720px) {
  .tune-grid { grid-template-columns: minmax(0, 1fr); }
  .key-grid { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .card-pad { padding: 16px; }
  .two { grid-template-columns: minmax(0, 1fr); }
  .runtime { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
