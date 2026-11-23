<script setup>
// Single stroke-based icon set: consistent weight, size and joins everywhere.
const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 16 },
})

const PATHS = {
  overview: 'M3 12.5 9 6l4.4 4.4M13.4 10.4 21 3M21 3h-5.4M21 3v5.4M3 21h18',
  accounts: 'M16 19v-1.6a3.4 3.4 0 0 0-3.4-3.4H6.4A3.4 3.4 0 0 0 3 17.4V19M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 19v-1.6a3.4 3.4 0 0 0-2.6-3.3M15.5 4.2a3.4 3.4 0 0 1 0 6.6',
  models: 'M12 3 4 7.5v9L12 21l8-4.5v-9L12 3ZM12 12l8-4.5M12 12v9M12 12 4 7.5',
  logs: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-3.5a8 8 0 0 0-.14-1.5l2-1.55-2-3.46-2.36.95a8 8 0 0 0-2.6-1.5L14.5 3h-4l-.4 2.5a8 8 0 0 0-2.6 1.5L5.14 6.05l-2 3.46L5.14 11a8 8 0 0 0 0 3l-2 1.55 2 3.46 2.36-.95a8 8 0 0 0 2.6 1.5l.4 2.44h4l.4-2.44a8 8 0 0 0 2.6-1.5l2.36.95 2-3.46-2-1.55c.09-.5.14-1 .14-1.5Z',
  refresh: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 4v5h-5',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  copy: 'M9 9V5.5A2.5 2.5 0 0 1 11.5 3h7A2.5 2.5 0 0 1 21 5.5v7a2.5 2.5 0 0 1-2.5 2.5H15M4.5 9h7A2.5 2.5 0 0 1 14 11.5v7A2.5 2.5 0 0 1 11.5 21h-7A2.5 2.5 0 0 1 2 18.5v-7A2.5 2.5 0 0 1 4.5 9Z',
  check: 'M20 6 9 17l-5-5',
  close: 'M18 6 6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  chevronsLeft: 'M11 17l-5-5 5-5M18 17l-5-5 5-5',
  chevronsRight: 'M13 7l5 5-5 5M6 7l5 5-5 5',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
  pulse: 'M3 12h4l3 8 4-16 3 8h4',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  trash: 'M3 6h18M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6M19 6l-.8 13.1a2 2 0 0 1-2 1.9H7.8a2 2 0 0 1-2-1.9L5 6',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  wallet: 'M3 8.5A2.5 2.5 0 0 1 5.5 6H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5.5A2.5 2.5 0 0 1 3 16.5v-8ZM3 9h13.5a2.5 2.5 0 0 1 0 5H3',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5.2l3.4 2',
  box: 'M12 3 3 7.8v8.4L12 21l9-4.8V7.8L12 3ZM3.3 7.9 12 12.6l8.7-4.7M12 12.6V21',
}
</script>

<template>
  <svg
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false"
  >
    <path :d="PATHS[props.name] || PATHS.box" />
  </svg>
</template>
