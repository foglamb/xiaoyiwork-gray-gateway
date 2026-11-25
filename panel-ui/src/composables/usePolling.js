import { onBeforeUnmount, onMounted, shallowRef } from 'vue'

/**
 * Interval that respects page visibility: no work while the tab is hidden and
 * no overlapping runs when a refresh takes longer than the interval.
 */
export function usePolling(task, { intervalMs = 15000, enabled = true } = {}) {
  const active = shallowRef(false)
  const running = shallowRef(false)
  let timer = null

  async function tick() {
    if (!active.value || running.value) return
    if (document.visibilityState === 'hidden') return
    running.value = true
    try { await task() } catch { /* surfaced by the caller */ } finally { running.value = false }
  }

  function start() {
    stop()
    active.value = true
    timer = setInterval(tick, intervalMs)
  }

  function stop() {
    active.value = false
    if (timer) clearInterval(timer)
    timer = null
  }

  function onVisibility() {
    if (document.visibilityState === 'visible' && active.value) tick()
  }

  onMounted(() => {
    if (enabled) start()
    document.addEventListener('visibilitychange', onVisibility)
  })
  onBeforeUnmount(() => {
    stop()
    document.removeEventListener('visibilitychange', onVisibility)
  })

  return { active, running, tick, start, stop }
}
