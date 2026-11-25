import { computed, ref } from 'vue'
import { api } from './useApi.js'

// Gray-rollout state lives here: the panel edits a draft, then commits it as a
// single hot-update patch. Nothing is applied until the user saves.
export const draft = ref(null)
export const saving = ref(false)
export const error = ref('')

export function initDraft(gray = {}, allowGrayModels = false) {
  draft.value = {
    enabled: Boolean(gray.enabled),
    percentage: Number(gray.percentage) || 0,
    pool: gray.pool || 'gray',
    salt: gray.salt || '',
    allowHeaderOverride: Boolean(gray.allowHeaderOverride),
    allowCookieOverride: Boolean(gray.allowCookieOverride),
    allowlist: [...(gray.allowlist || [])],
    denylist: [...(gray.denylist || [])],
    models: [...(gray.models || [])],
    shadow: Boolean(gray.shadow),
    allowGrayModels: Boolean(allowGrayModels),
  }
  error.value = ''
}

export const dirty = computed(() => Boolean(draft.value))

export async function saveGray(patch) {
  saving.value = true
  error.value = ''
  try {
    const result = await api('/_admin/gray', { method: 'POST', body: patch })
    return result
  } catch (err) {
    error.value = err.message
    throw err
  } finally {
    saving.value = false
  }
}

/** Server preview also works on HTTP LAN pages without Web Crypto. */
export async function previewBucket(identity, salt, percentage) {
  return api('/api/gray/preview', { method: 'POST', body: { identity, salt, percentage: Number(percentage) } })
}
