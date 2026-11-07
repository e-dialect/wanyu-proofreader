import { readFileSync } from 'node:fs'

// Resolve the production modules explicitly, so moving a handler cannot silently
// leave a source-executing regression test pointed at an abandoned copy.
export function projectDetailSource() {
  return [
    'views/admin/ProjectDetailView.vue',
    'components/admin/project/projectPanels.js',
    'components/admin/project/ProjectEntriesPanel.vue',
    'composables/project/useProjectEntries.js',
    'components/admin/project/ProjectPdfUpload.vue',
    'components/admin/project/ProjectCsvImport.vue',
    'components/admin/project/ProjectImportLedger.vue',
    'components/admin/project/ProjectExportPanel.vue',
    'components/admin/project/ProjectAssistPanel.vue',
    'components/admin/project/ProjectSchemePanel.vue'
  ]
    .map((file) =>
      readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(file.startsWith('composables/') ? /^ {2}/gm : /$^/g, '')
    )
    .join('\n')
}
