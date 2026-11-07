import { readFileSync, readdirSync } from 'node:fs'

// Audit the assembled editor, including every delegated UI and local controller.
// Keep blind proofreading and own-review guards covered after structural splits.
export function proofreadSource() {
  const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8')
  const components = new URL('../../src/components/editor/', import.meta.url)
  const controllers = new URL('../../src/composables/proofread/', import.meta.url)
  return [
    read('../../src/views/proofreader/ProofreadEditorView.vue'),
    ...readdirSync(components)
      .filter((name) => /^Proofread.*\.vue$/.test(name))
      .map((name) => read(`../../src/components/editor/${name}`)),
    ...readdirSync(controllers)
      .filter((name) => name.endsWith('.js'))
      .map((name) => read(`../../src/composables/proofread/${name}`).replace(/^ {2}/gm, ''))
  ].join('\n')
}
