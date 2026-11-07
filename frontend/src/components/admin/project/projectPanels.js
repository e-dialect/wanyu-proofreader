import { defineAsyncComponent, h } from 'vue'
import AppStatusPanel from '@/components/AppStatusPanel.vue'

const loadingComponent = {
  render: () => h(AppStatusPanel, { state: 'pending', message: '正在打开工作面板…' })
}
const lazyPanel = (loader) => defineAsyncComponent({ loader, loadingComponent, delay: 0 })

export const ProjectPdfUpload = lazyPanel(
  () => import('@/components/admin/project/ProjectPdfUpload.vue')
)
export const ProjectCsvImport = lazyPanel(
  () => import('@/components/admin/project/ProjectCsvImport.vue')
)
export const ProjectOcrImport = lazyPanel(
  () => import('@/components/admin/project/ProjectOcrImport.vue')
)
export const ProjectImportLedger = lazyPanel(
  () => import('@/components/admin/project/ProjectImportLedger.vue')
)
export const ProjectExportPanel = lazyPanel(
  () => import('@/components/admin/project/ProjectExportPanel.vue')
)
export const ProjectProcessExport = lazyPanel(
  () => import('@/components/admin/project/ProjectProcessExport.vue')
)
export const ProjectAssistPanel = lazyPanel(
  () => import('@/components/admin/project/ProjectAssistPanel.vue')
)
export const ProjectSchemePanel = lazyPanel(
  () => import('@/components/admin/project/ProjectSchemePanel.vue')
)

export const ProjectBundleImport = lazyPanel(
  () => import('@/components/admin/project/ProjectBundleImport.vue')
)
