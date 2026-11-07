<template>
  <div v-if="selectedKeyboard" class="ipa-keyboard">
    <div class="keyboard-search-row" :class="{ 'is-searching': search.trim() }">
      <label class="keyboard-search"
        ><span class="sr-only">搜索字符、名称或码位</span
        ><input
          v-model="search"
          type="search"
          class="form-control"
          placeholder="搜索字符、名称或 U+ 码位"
      /></label>
      <button v-if="search" type="button" class="btn btn-quiet btn-sm" @click="search = ''">
        清除搜索
      </button>
      <label class="keyboard-category"
        ><span class="sr-only">字符分组</span
        ><select v-model="activeSection" class="form-control" :disabled="!!search.trim()">
          <option v-if="recentKeys.length" value="__recent">
            最近使用 · {{ recentKeys.length }}
          </option>
          <option v-for="section in sections" :key="section.id" :value="section.id">
            {{ section.label }} · {{ section.keys.length }}
          </option>
        </select></label
      >
    </div>
    <div
      v-if="search.trim()"
      class="keyboard-search-results"
      role="region"
      aria-label="字符搜索结果"
    >
      <p class="text-sm text-muted" role="status">
        {{
          searchResults.length
            ? `找到 ${searchResults.length} 个字符`
            : '没有匹配字符，请尝试字符、名称或码位。'
        }}
      </p>
      <div class="ipa-keys">
        <button
          v-for="key in searchResults"
          :key="key.value"
          type="button"
          class="ipa-key"
          :title="key.hint || key.category"
          :aria-label="key.hint || `插入字符 ${key.value}`"
          @mousedown.prevent
          @click="insert(key.value)"
        >
          {{ key.label || key.value }}
        </button>
      </div>
    </div>
    <section
      v-else-if="activeSection === '__recent' && recentKeys.length"
      class="keyboard-recent"
      aria-label="最近使用字符"
    >
      <div class="ipa-keys">
        <button
          v-for="key in recentKeys"
          :key="key.value"
          type="button"
          class="ipa-key"
          :title="key.hint || `插入 ${key.value}`"
          :aria-label="`再次插入字符 ${key.value}`"
          @mousedown.prevent
          @click="insert(key.value)"
        >
          {{ key.label || key.value }}
        </button>
      </div>
    </section>
    <section
      v-for="section in sections"
      :key="section.id"
      :id="`${keyboardUid}-${section.id}`"
      v-show="!search.trim() && activeSection === section.id"
      :aria-label="section.label"
      class="ipa-section"
    >
      <div class="ipa-keys">
        <button
          v-for="(key, index) in section.keys"
          :key="`${section.id}-${index}-${key.value}`"
          type="button"
          class="ipa-key"
          :title="key.hint || `插入 ${key.value}`"
          :aria-label="key.hint || `插入字符 ${key.value}`"
          @mousedown.prevent
          @click="insert(key.value)"
        >
          {{ key.label || key.value }}
        </button>
      </div>
    </section>
    <div class="keyboard-footer">
      <label v-if="keyboards.length > 1" class="keyboard-switcher"
        ><span class="sr-only">切换项目键盘</span
        ><select v-model="selectedKeyboardId" class="form-control">
          <option
            v-for="keyboard in keyboards"
            :key="keyboard.keyboardId"
            :value="keyboard.keyboardId"
          >
            {{ keyboard.name }}
          </option>
        </select></label
      ><span v-else class="keyboard-name">{{ selectedKeyboard.name }} · {{ keyCount }} 个字符</span
      ><button
        v-if="activeSection === '__recent' && recentKeys.length"
        type="button"
        class="btn btn-quiet btn-sm"
        @click="clearRecent"
      >
        清空最近使用</button
      ><KeyboardGuide :sections="sections" />
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { currentUserId } from '@/services/authService'
import { getProjectKeyboards } from '@/services/keyboardsService'
import {
  chooseProjectKeyboard,
  countKeyboardValues,
  keyboardPreferenceKey
} from '@/lib/keyboardSelection'
import KeyboardGuide from './KeyboardGuide.vue'
import { matchingKeyboardKeys, recentKeyboardValues } from '@/lib/editorExperience'

const props = defineProps({ projectId: { type: String, default: '' } })
const emit = defineEmits(['insert', 'availability'])

const keyboards = ref([])
const projectDefaultId = ref('')
const selectedKeyboardId = ref('')
let loadGeneration = 0
const keyboardUid = useId()
const activeSection = ref('')
const search = ref('')
const recentValues = ref([])
const searchResults = computed(() => matchingKeyboardKeys(sections.value, search.value))
const allKeys = computed(() => {
  const entries = new Map()
  for (const section of sections.value)
    for (const key of section.keys) if (!entries.has(key.value)) entries.set(key.value, key)
  return entries
})
const recentKeys = computed(() =>
  recentValues.value.map((value) => allKeys.value.get(value)).filter(Boolean)
)
const recentKey = computed(
  () =>
    `${keyboardPreferenceKey(currentUserId(), props.projectId)}:recent:${selectedKeyboardId.value}`
)
function persistRecent() {
  try {
    localStorage.setItem(recentKey.value, JSON.stringify(recentValues.value))
  } catch {
    /* private mode still permits character insertion */
  }
}
function insert(value) {
  emit('insert', value)
  recentValues.value = recentKeyboardValues(recentValues.value, value, [...allKeys.value.keys()])
  persistRecent()
}
function clearRecent() {
  recentValues.value = []
  activeSection.value =
    sections.value.find((section) => section.defaultOpen)?.id || sections.value[0]?.id || ''
  persistRecent()
}
onBeforeUnmount(() => {
  loadGeneration++
})

const selectedKeyboard = computed(
  () => keyboards.value.find((item) => item.keyboardId === selectedKeyboardId.value) || null
)
const sections = computed(() => selectedKeyboard.value?.definition?.sections || [])
watch(
  selectedKeyboard,
  (keyboard) => {
    emit('availability', Boolean(keyboard))
    activeSection.value =
      sections.value.find((section) => section.defaultOpen)?.id || sections.value[0]?.id || ''
  },
  { immediate: true }
)
const keyCount = computed(() => countKeyboardValues(sections.value))
watch(
  [recentKey, allKeys],
  ([key]) => {
    search.value = ''
    try {
      const stored = JSON.parse(localStorage.getItem(key) || '[]')
      recentValues.value = recentKeyboardValues(Array.isArray(stored) ? stored : [], '', [
        ...allKeys.value.keys()
      ])
    } catch {
      recentValues.value = []
    }
    if (recentValues.value.length) activeSection.value = '__recent'
  },
  { immediate: true }
)

watch(() => props.projectId, load, { immediate: true })
watch(selectedKeyboardId, (keyboardId) => {
  if (!keyboardId || !props.projectId) return
  try {
    localStorage.setItem(keyboardPreferenceKey(currentUserId(), props.projectId), keyboardId)
  } catch {
    /* private mode or quota: a lost preference must not break the editor */
  }
})

async function load(projectId) {
  const generation = ++loadGeneration
  const requestedUser = currentUserId()
  keyboards.value = []
  selectedKeyboardId.value = ''
  if (!projectId) return
  try {
    const result = await getProjectKeyboards(projectId)
    if (generation !== loadGeneration || requestedUser !== currentUserId()) return
    keyboards.value = Array.isArray(result.items) ? result.items : []
    projectDefaultId.value = result.defaultKeyboardId || ''
    let remembered = ''
    try {
      remembered = localStorage.getItem(keyboardPreferenceKey(currentUserId(), projectId)) || ''
    } catch {
      /* an unreadable preference falls back to the project default */
    }
    selectedKeyboardId.value =
      chooseProjectKeyboard(keyboards.value, projectDefaultId.value, remembered)?.keyboardId || ''
  } catch {
    if (generation === loadGeneration) keyboards.value = []
  }
}
</script>
