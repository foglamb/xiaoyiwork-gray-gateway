<script setup>
import { computed, ref, shallowRef, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { mergeConfirmed } from '../lib/panel.js'
import { state, models, acceptGraySnapshot } from '../composables/useDashboard.js'
import { saveGray, previewBucket } from '../composables/useGray.js'
import { notify } from '../composables/useToast.js'
import { num, pct } from '../composables/useFormat.js'

const emit = defineEmits(['saved'])

const enabled = ref(false)
const percentage = ref(0)
const pool = ref('gray')
const salt = ref('')
const headerOverride = ref(false)
const cookieOverride = ref(false)
const shadow = ref(false)
const allowGrayModels = ref(false)
const allowlistText = ref('')
const denylistText = ref('')
const selectedModels = ref([])
const saving = shallowRef(false)
const previewInput = ref('')
const preview = shallowRef(null)
const previewBusy = shallowRef(false)

const serverGray = computed(() => state.value?.gray || {})

function syncFromServer(source = state.value) {
  const g = source?.gray || {}
  enabled.value = Boolean(g.enabled)
  percentage.value = Number(g.percentage) || 0
  pool.value = g.pool || 'gray'
  salt.value = g.salt || ''
  headerOverride.value = Boolean(g.allowHeaderOverride)
  cookieOverride.value = Boolean(g.allowCookieOverride)
  shadow.value = Boolean(g.shadow)
  allowGrayModels.value = Boolean(source?.allowGrayModels)
  allowlistText.value = (g.allowlist || []).join('\n')
  denylistText.value = (g.denylist || []).join('\n')
  selectedModels.value = [...(g.models || [])]
}



const lines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean)

const readDraft = () => ({
  enabled: enabled.value, percentage: Number(percentage.value), pool: pool.value, salt: salt.value,
  allowHeaderOverride: headerOverride.value, allowCookieOverride: cookieOverride.value,
  shadow: shadow.value, allowGrayModels: allowGrayModels.value,
  allowlist: lines(allowlistText.value), denylist: lines(denylistText.value), models: [...selectedModels.value],
})
const baseline = shallowRef(null)
const dirty = computed(() => baseline.value !== null && Object.keys(readDraft()).some((key) => JSON.stringify(readDraft()[key]) !== JSON.stringify(baseline.value[key])))
watch(() => state.value, (value) => {
  if (!value?.gray || dirty.value || saving.value) return
  syncFromServer(value)
  baseline.value = readDraft()
}, { immediate: true })

async function save() {
  saving.value = true
  try {
    const submitted = readDraft()
    const response = await saveGray(submitted)
    const confirmed = { ...response.gray, allowGrayModels: response.allowGrayModels }
    const merged = mergeConfirmed(readDraft(), submitted, confirmed)
    syncFromServer({ gray: merged, allowGrayModels: merged.allowGrayModels })
    baseline.value = confirmed
    acceptGraySnapshot(confirmed)
    notify('灰度配置已热更新', 'ok')
    emit('saved')
  } catch (error) {
    notify(error.message, 'err')
  } finally {
    saving.value = false
  }
}

function revert() { if (baseline.value) syncFromServer({ gray: baseline.value, allowGrayModels: baseline.value.allowGrayModels }) }

const PRESETS = [0, 1, 5, 10, 25, 50, 100]

function bucketPct(bucket) { return (bucket / 10000) * 100 }

async function runPreview() {
  if (previewBusy.value) return
  const identity = previewInput.value.trim() || 'anonymous'
  const submittedSalt = salt.value
  const submittedPercentage = percentage.value
  previewBusy.value = true
  preview.value = null
  try {
    const result = await previewBucket(identity, submittedSalt, submittedPercentage)
    if (identity === (previewInput.value.trim() || 'anonymous') && submittedSalt === salt.value && submittedPercentage === percentage.value) preview.value = result
  } catch (error) {
    notify(error.message || '分流预览失败，请重试', 'err')
  } finally {
    previewBusy.value = false
  }
}

watch([salt, percentage, previewInput], () => { preview.value = null })

const grayModelList = computed(() => models.value.filter((m) => m.gatewayGray))

const distTotal = computed(() => {
  const s = state.value?.stats
  return (s?.stable || 0) + (s?.gray || 0) || 1
})
</script>

<template>
  <div class="stack">
    <section class="card hero-card">
      <div class="hero-left">
        <div class="hero-title">
          <span class="kicker">Canary</span>
          <h2>{{ enabled ? '灰度分流已启用' : '灰度分流已停用' }}</h2>
          <p class="muted">
            {{ enabled ? `约 ${percentage}% 的流量进入${pool === 'gray' ? '灰度池' : '稳定池'}` : '全部流量走稳定池，切换不影响在途请求' }}
          </p>
        </div>
        <label class="switch" :class="{ on: enabled }">
          <input v-model="enabled" type="checkbox" />
          <span class="track"><span class="thumb" /></span>
          <span class="switch-label">{{ enabled ? '跑灰度' : '全稳定' }}</span>
        </label>
      </div>

      <div class="dist">
        <div class="dist-bar">
          <div class="dist-seg stable" :style="{ width: `${(state?.stats?.stable || 0) / distTotal * 100}%` }" />
          <div class="dist-seg gray" :style="{ width: `${(state?.stats?.gray || 0) / distTotal * 100}%` }" />
        </div>
        <div class="dist-legend">
          <span><i class="dot-stable" />稳定 {{ num(state?.stats?.stable || 0) }}</span>
          <span><i class="dot-gray" />灰度 {{ num(state?.stats?.gray || 0) }}</span>
        </div>
      </div>
    </section>

    <div class="cols">
      <div class="col">
        <section class="card card-pad">
          <span class="kicker">Rollout</span>
          <h3 class="mt">分流比例</h3>

          <div class="pct-display">
            <span class="pct-num">{{ percentage }}</span><span class="pct-sign">%</span>
          </div>

          <input v-model.number="percentage" class="slider" type="range" min="0" max="100" step="1" :disabled="!enabled" />
          <div class="presets">
            <button
              v-for="p in PRESETS" :key="p" type="button" class="chip"
              :class="{ on: percentage === p }" :disabled="!enabled" @click="percentage = p"
            >{{ p }}%</button>
          </div>

          <div class="field mt-18">
            <label>灰度目标池</label>
            <div class="seg full">
              <button type="button" :class="{ on: pool === 'gray' }" @click="pool = 'gray'">灰度池</button>
              <button type="button" :class="{ on: pool === 'stable' }" @click="pool = 'stable'">稳定池</button>
            </div>
          </div>

          <div class="field mt-14">
            <label>分桶盐值 salt</label>
            <input v-model="salt" class="input mono-input" spellcheck="false" placeholder="修改后所有客户端重新分组" />
            <span class="muted tiny">同一 salt + 身份永远落在同一桶，改 salt 会整体重新洗牌</span>
          </div>
        </section>
        <section class="card card-pad">
          <span class="kicker">Bucket Preview</span>
          <h3 class="mt">分流预览</h3>
          <p class="muted tiny mb">用与服务端一致的 SHA256 分桶算法演算，验证某个客户端会落到哪一侧。</p>
          <div class="row">
            <input v-model="previewInput" class="input mono-input" placeholder="token:xy_xxx 或 user-42" spellcheck="false" @keyup.enter="runPreview" />
            <button class="btn btn-sm" type="button" :disabled="previewBusy" @click="runPreview">{{ previewBusy ? '演算中…' : '演算' }}</button>
          </div>
          <div v-if="preview" class="result" :class="{ gray: preview.gray }">
            <div class="result-main">
              <b>{{ preview.gray ? (pool === 'gray' ? '进入灰度池' : '进入灰度（映射到稳定池）') : '留在稳定池' }}</b>
              <span class="mono tiny">bucket {{ preview.bucket }} / 10000</span>
            </div>
            <div class="bucket-track">
              <div class="bucket-fill" :style="{ width: `${bucketPct(preview.bucket)}%` }" />
              <div class="bucket-threshold" :style="{ left: `${percentage}%` }" title="灰度阈值" />
            </div>
            <span class="muted tiny">阈值 {{ percentage }}%（对应 bucket {{ percentage * 100 }}）</span>
          </div>
        </section>
      </div>
      <div class="col">
        <section class="card card-pad">
          <span class="kicker">Rules</span>
          <h3 class="mt">覆盖与名单</h3>

          <div class="toggle-list">
            <label class="toggle-row">
              <input v-model="headerOverride" type="checkbox" />
              <span class="toggle-text"><b>允许 Header 覆盖</b><em>X-Gray-Force / X-Gray-Enabled</em></span>
            </label>
            <label class="toggle-row">
              <input v-model="cookieOverride" type="checkbox" />
              <span class="toggle-text"><b>允许 Cookie 覆盖</b><em>gray_force=1 / 0</em></span>
            </label>
            <label class="toggle-row">
              <input v-model="shadow" type="checkbox" />
              <span class="toggle-text"><b>影子模式</b><em>只记录命中，不真正切换账号池</em></span>
            </label>
            <label class="toggle-row">
              <input v-model="allowGrayModels" type="checkbox" />
              <span class="toggle-text"><b>对外暴露灰度模型</b><em>关闭时 /v1/models 隐藏下列模型</em></span>
            </label>
          </div>

          <div class="field mt-18">
            <label>强制灰度名单（每行一个身份）</label>
            <textarea v-model="allowlistText" class="textarea mono-input" rows="3" spellcheck="false" placeholder="token:xy_xxx&#10;user-42" />
          </div>
          <div class="field mt-12">
            <label>强制稳定名单</label>
            <textarea v-model="denylistText" class="textarea mono-input" rows="3" spellcheck="false" placeholder="对应身份永不进入灰度" />
          </div>
        </section>
        <section class="card card-pad">
          <span class="kicker">Models</span>
          <h3 class="mt">灰度模型</h3>
          <p class="muted tiny mb">勾选加入灰度的模型；是否对外可见由上方「对外暴露灰度模型」控制。</p>
          <div class="model-pick">
            <label v-for="m in grayModelList" :key="m.id" class="pick" :class="{ on: selectedModels.includes(m.id) }">
              <input v-model="selectedModels" type="checkbox" :value="m.id" />
              <span class="pick-name">{{ m.name || m.id }}</span>
              <AppIcon v-if="selectedModels.includes(m.id)" name="check" :size="12" />
            </label>
            <p v-if="!grayModelList.length" class="muted tiny">没有标记为灰度的模型</p>
          </div>
        </section>
      </div>
    </div>

    <footer class="save-bar card">
      <span class="muted tiny">{{ dirty ? '有未保存的改动' : '与线上一致' }}</span>
      <button class="btn btn-sm" type="button" :disabled="!dirty || saving" @click="revert">撤销</button>
      <button class="btn btn-sm btn-primary" type="button" :disabled="!dirty || saving" @click="save">
        {{ saving ? '保存中…' : '保存并热更新' }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: 16px; }
.mt { margin-top: 5px; font-size: 15px; font-weight: 640; }
.mt-12 { margin-top: 12px; }
.mt-14 { margin-top: 14px; }
.mt-18 { margin-top: 18px; }
.mb { margin: 4px 0 12px; }

.hero-card { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 20px 22px; flex-wrap: wrap; background-image: var(--hero); }
.hero-left { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.hero-title h2 { margin-top: 4px; font-size: 18px; font-weight: 660; }
.hero-title p { margin-top: 3px; font-size: 12px; }
.switch { display: inline-flex; align-items: center; gap: 9px; cursor: pointer; user-select: none; }
.switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.track {
  width: 44px; height: 25px; border-radius: 999px; background: var(--surface-3);
  border: 1px solid var(--line); position: relative; transition: background var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease);
}
.thumb {
  position: absolute; top: 2px; left: 2px; width: 19px; height: 19px; border-radius: 50%;
  background: var(--dim); transition: transform var(--dur-2) var(--ease-out), background var(--dur-2) var(--ease);
}
.switch.on .track { background: var(--accent-soft); border-color: var(--accent-line); }
.switch.on .thumb { transform: translateX(19px); background: var(--accent); }
.switch-label { font-size: 12px; font-weight: 600; color: var(--dim); }
.switch.on .switch-label { color: var(--accent-2); }

.dist { min-width: 220px; flex: 1; max-width: 320px; }
.dist-bar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: var(--surface-3); }
.dist-seg { transition: width var(--dur-3) var(--ease-out); }
.dist-seg.stable { background: var(--dim-2); }
.dist-seg.gray { background: var(--accent); }
.dist-legend { display: flex; gap: 14px; margin-top: 7px; font-size: 11px; color: var(--dim); }
.dist-legend span { display: inline-flex; align-items: center; gap: 5px; }
.dot-stable, .dot-gray { width: 7px; height: 7px; border-radius: 2px; display: inline-block; }
.dot-stable { background: var(--dim-2); }
.dot-gray { background: var(--accent); }

.cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
.col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }

.pct-display { display: flex; align-items: baseline; gap: 2px; margin: 14px 0 4px; }
.pct-num { font-size: 40px; font-weight: 660; letter-spacing: -0.04em; font-family: var(--font-mono); line-height: 1; }
.pct-sign { font-size: 17px; color: var(--dim); font-family: var(--font-mono); }
.slider { width: 100%; margin: 10px 0 12px; accent-color: var(--accent); height: 4px; }
.presets { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  height: 27px; padding: 0 11px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--surface-2);
  color: var(--dim); font-size: 11.5px; font-weight: 550;
  transition: all var(--dur-1) var(--ease);
}
.chip:hover:not(:disabled) { border-color: var(--line-strong); color: var(--text-2); }
.chip.on { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent-2); font-weight: 640; }
.chip:disabled { opacity: 0.4; cursor: not-allowed; }

.seg.full { display: grid; grid-template-columns: 1fr 1fr; width: 100%; }
.seg { display: inline-flex; padding: 2px; gap: 2px; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-sm); }
.seg button { border: 0; background: transparent; color: var(--dim); font-size: 11.5px; font-weight: 550; padding: 5px 11px; border-radius: var(--r-xs); }
.seg button.on { background: var(--surface-3); color: var(--text); font-weight: 620; box-shadow: var(--shadow-xs); }

.toggle-list { display: flex; flex-direction: column; gap: 2px; margin-top: 14px; }
.toggle-row { display: flex; align-items: flex-start; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--line-soft); cursor: pointer; }
.toggle-row:last-child { border-bottom: 0; }
.toggle-row input { accent-color: var(--accent); margin-top: 2px; flex: none; }
.toggle-text { display: flex; flex-direction: column; gap: 1px; }
.toggle-text b { font-size: 12.5px; font-weight: 580; color: var(--text-2); }
.toggle-text em { font-style: normal; font-size: 10.5px; color: var(--dim-2); font-family: var(--font-mono); }

.result { margin-top: 14px; padding: 13px 14px; border-radius: var(--r-md); background: var(--surface-2); border: 1px solid var(--line); }
.result.gray { border-color: var(--accent-line); background: var(--accent-soft); }
.result-main { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.result-main b { font-size: 13.5px; font-weight: 640; }
.result.gray .result-main b { color: var(--accent-2); }
.bucket-track { position: relative; height: 7px; border-radius: 999px; background: var(--surface-3); margin: 11px 0 7px; overflow: visible; }
.bucket-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--dim-2), var(--dim)); }
.bucket-threshold { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--accent); border-radius: 2px; }

.model-pick { display: flex; flex-wrap: wrap; gap: 7px; }
.pick {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 11px; border-radius: var(--r-sm);
  border: 1px solid var(--line); background: var(--surface-2);
  font-size: 11.5px; color: var(--dim); cursor: pointer;
  transition: all var(--dur-1) var(--ease);
}
.pick input { display: none; }
.pick:hover { border-color: var(--line-strong); color: var(--text-2); }
.pick.on { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent-2); font-weight: 600; }

.save-bar {
  position: sticky; bottom: 14px; z-index: 10;
  display: flex; align-items: center; gap: 10px; justify-content: flex-end;
  padding: 11px 16px; box-shadow: var(--shadow);
}
.save-bar .muted { margin-right: auto; }

@media (max-width: 720px) {
  .hero-card { padding: 16px; gap: 14px; }
  .hero-left { gap: 0; width: 100%; justify-content: space-between; }
  .hero-title h2 { font-size: 16px; }
  .dist { max-width: none; width: 100%; }
  .cols { grid-template-columns: minmax(0, 1fr); gap: 13px; }
  .col { gap: 13px; }
  .pct-num { font-size: 34px; }
  .save-bar { bottom: calc(66px + var(--safe-b)); }
}
</style>
