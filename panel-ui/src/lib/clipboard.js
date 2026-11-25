export async function copyText(text, browser = globalThis) {
  try {
    if (browser.navigator?.clipboard?.writeText) {
      await browser.navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* HTTP LAN and browser permissions can require the fallback. */ }
  const doc = browser.document
  if (!doc?.createElement || !doc.execCommand) throw new Error('复制不可用，请手动选中复制')
  const previous = doc.activeElement
  const area = doc.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  doc.body.append(area)
  try {
    area.select()
    if (!doc.execCommand('copy')) throw new Error('复制失败，请手动选中复制')
    return true
  } finally {
    area.remove()
    previous?.focus?.({ preventScroll: true })
  }
}
