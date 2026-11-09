import { createApp, h, ref } from 'vue'
import pb from '../../src/lib/pocketbase.js'
import { useJobObserver } from '../../src/composables/useJobObserver.js'
import JobStatusPanel from '../../src/components/admin/project/JobStatusPanel.vue'
import ProjectCsvImport from '../../src/components/admin/project/ProjectCsvImport.vue'
import ProjectOcrImport from '../../src/components/admin/project/ProjectOcrImport.vue'
import '../../src/style.css'

const token = () =>
  `test.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.test`
pb.authStore.save(token(), { id: 'user-a' })
const job = ref({ id: 'conversion-a', project: 'project-a', status: 'processing', total_count: 7 })
const mounted = ref(true),
  shown = ref(true)
const Observer = {
  setup() {
    const panel = ref(null)
    const { observation, retry } = useJobObserver({
      projectId: 'project-a',
      kind: 'conversion',
      job,
      panel,
      read: (id, { signal }) => pb.send(`/api/test/jobs/${id}`, { signal, requestKey: null })
    })
    return () =>
      h('div', { ref: panel }, [
        h(JobStatusPanel, {
          label: '转换',
          kind: 'conversion',
          observation: observation.value,
          onRetry: retry
        })
      ])
  }
}
window.jobFixture = {
  show: (value) => {
    shown.value = value
  },
  mount: (value) => {
    mounted.value = value
  },
  refreshAuth: () => pb.authStore.save(token(), { id: 'user-a' }),
  logout: () => pb.authStore.clear()
}
const noop = () => {}
createApp({
  setup: () => () =>
    h('main', { class: 'container page' }, [
      h('h1', '作业状态与导入预检 · 合成夹具'),
      h('div', { hidden: !shown.value }, mounted.value ? [h(Observer), h(Observer)] : []),
      h(ProjectCsvImport, {
        projectId: 'project-a',
        refreshPages: noop,
        refreshStats: noop,
        refreshQuality: noop,
        refreshLedger: noop,
        clearSelection: noop
      }),
      h(ProjectOcrImport, { projectId: 'project-a' })
    ])
}).mount('#app')
