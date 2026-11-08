import { computed, ref, watch } from 'vue'
import { charsRequiringFont, unavailableRareCharacters } from '../lib/rareCharacters.js'

export function useFontAvailability(texts) {
  const chars = computed(() => charsRequiringFont(texts.value))
  // Text/order changes can keep the exact same glyph set. They do not require
  // another font API round-trip or a loading-state flicker; retry still does.
  const characterSet = computed(() => JSON.stringify([...chars.value].sort()))
  const state = ref('ready')
  const unavailable = ref([])
  const attempt = ref(0)
  watch(
    [characterSet, attempt],
    async (_, __, onCleanup) => {
      const value = chars.value
      let active = true
      onCleanup(() => {
        active = false
      })
      unavailable.value = []
      if (!value.length) {
        state.value = 'ready'
        return
      }
      state.value = 'loading'
      const missing = await unavailableRareCharacters(value, globalThis.document?.fonts)
      if (!active) return
      unavailable.value = missing
      state.value = missing.length ? 'error' : 'ready'
    },
    { immediate: true }
  )
  return {
    chars,
    state,
    unavailable,
    retry: () => {
      attempt.value += 1
    }
  }
}
