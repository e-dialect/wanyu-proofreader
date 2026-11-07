<template>
  <div v-if="selectedKeyboard" class="ipa-keyboard">
    <div class="ipa-keyboard-heading">
      <div>
        <div class="ipa-keyboard-title">{{ selectedKeyboard.name }}</div>
        <p>
          {{
            selectedKeyboard.description ||
            (mobile
              ? '切换分组，字符插入当前字段。'
              : '字符会插入当前字段的光标位置；展开需要的分组即可。')
          }}
        </p>
      </div>
      <label v-if="keyboards.length > 1" class="keyboard-switcher">
        <span class="sr-only">切换项目键盘</span>
        <select v-model="selectedKeyboardId" class="form-control">
          <option
            v-for="keyboard in keyboards"
            :key="keyboard.keyboardId"
            :value="keyboard.keyboardId"
          >
            {{ keyboard.name }}
          </option>
        </select>
      </label>
      <span v-else>{{ keyCount }} 个字符</span>
    </div>

    <div class="keyboard-search-row">
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
      <KeyboardGuide :sections="sections" />
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
    <section v-else-if="recentKeys.length" class="keyboard-recent" aria-label="最近使用字符">
      <div class="keyboard-recent-heading">
        <span>最近使用</span
        ><button type="button" class="btn btn-quiet btn-sm" @click="clearRecent">清空</button>
      </div>
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
    <div
      v-if="!search.trim() && mobile && sections.length > 1"
      class="keyboard-section-switcher"
      role="group"
      aria-label="字符分组"
    >
      <button
        v-for="section in sections"
        :key="section.id"
        type="button"
        :aria-pressed="activeSection === section.id"
        :aria-controls="`${keyboardUid}-${section.id}`"
        @mousedown.prevent
        @click="activeSection = section.id"
      >
        {{ section.label }} <span>{{ section.keys.length }}</span>
      </button>
    </div>
    <details
      v-for="section in sections"
      :key="`${section.id}-${mobile}`"
      :id="`${keyboardUid}-${section.id}`"
      v-show="!search.trim() && (!mobile || activeSection === section.id)"
      :aria-label="section.label"
      class="ipa-section"
      :open="mobile || section.defaultOpen"
    >
      <summary class="ipa-section-label">
        <span>{{ section.label }}</span>
        <span>{{ section.keys.length }}</span>
      </summary>
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
    </details>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, useId, watch } from 'vue'
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
const mobile = ref(false)
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
watch(recentKey, (key) => {
  search.value = ''
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '[]')
    recentValues.value = recentKeyboardValues(Array.isArray(stored) ? stored : [], '', [
      ...allKeys.value.keys()
    ])
  } catch {
    recentValues.value = []
  }
})
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
  persistRecent()
}

const updateMobile = () => {
  mobile.value = window.innerWidth <= 768
}
onMounted(() => {
  updateMobile()
  window.addEventListener('resize', updateMobile)
})
onBeforeUnmount(() => {
  loadGeneration++
  window.removeEventListener('resize', updateMobile)
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
