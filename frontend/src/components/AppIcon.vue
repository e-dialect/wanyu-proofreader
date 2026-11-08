<template>
  <svg
    class="app-icon"
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.project" />
  </svg>
</template>
<script setup>
defineProps({ name: { type: String, default: 'project' } })
const paths = {
  keyboard:
    'M3 5h18v14H3V5Zm3 3h.01M10 8h.01M14 8h.01M18 8h.01M6 11h.01M10 11h.01M14 11h.01M18 11h.01M7 15h10',
  search: 'M21 21l-5-5m2-6a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  chevron: 'm6 9 6 6 6-6',
  'chevron-up': 'm6 15 6-6 6 6',
  home: 'M3 10 12 3l9 7v10H3V10Zm6 10v-7h6v7',
  task: 'M8 5H5v16h14V5h-3M8 3h8v4H8V3Zm0 9 2 2 5-5M8 18h8',
  project: 'M3 7V4h7l2 3h9v13H3V7Z',
  source: 'M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1v15',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M9 15v6',
  menu: 'M4 6h16M4 12h16M4 18h16',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  back: 'M19 12H5m5-5-5 5 5 5',
  plus: 'M12 5v14M5 12h14',
  help: 'M9 8a3 3 0 0 1 6 0c0 2-3 2-3 5m0 4h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',
  alert: 'M12 3 2 21h20L12 3Zm0 6v5m0 3h.01',
  refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
  check: 'm5 12 4 4L19 6'
}
</script>
