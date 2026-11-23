import { readonly, shallowRef } from 'vue'

// Notifications are app-wide and short lived, so they live in one queue.
const items = shallowRef([])
let seq = 0

export const toasts = readonly(items)

export function dismiss(id) {
  items.value = items.value.filter((item) => item.id !== id)
}

export function notify(message, tone = 'ok', ttl = 3600) {
  const id = ++seq
  items.value = [...items.value, { id, message: String(message), tone }]
  setTimeout(() => dismiss(id), ttl)
  return id
}
