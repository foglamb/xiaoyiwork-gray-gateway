import { onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'

/**
 * Interval that respects page visibility: no work while the tab is hidden and
 * no overlapping runs when a refresh takes longer than the interval.
 */
export function usePolling(task, { intervalMs = 15000, enabled = true } = {}) {
  const active = shallowRef(true)
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
    if (!active.value) return
    timer = setInterval(tick, intervalMs)
  }

  function stop() {
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
  watch(active, (value) => (value ? start() : stop()))

  return { active, running, tick, start, stop }
}
