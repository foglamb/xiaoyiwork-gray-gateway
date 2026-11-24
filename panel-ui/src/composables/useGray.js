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

/** Same bucketing the server uses, so the preview matches real routing. */
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function previewBucket(identity, salt, percentage) {
  const hash = await sha256Hex(`${salt}:${identity}`)
  // Mirror the server exactly: unsigned big-endian uint32 of the first 4 bytes.
  const bucket = parseInt(hash.slice(0, 8), 16) >>> 0
  const value = bucket % 10000
  return { identity, salt, bucket: value, gray: value < Number(percentage) * 100 }
}
