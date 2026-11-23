import { shallowRef, watch } from 'vue'

const stored = localStorage.getItem('xy-theme')
const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches
export const theme = shallowRef(stored || (prefersLight ? 'light' : 'dark'))

function apply(value) {
  document.documentElement.dataset.theme = value
  localStorage.setItem('xy-theme', value)
}

watch(theme, apply, { immediate: true })

export function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
}
