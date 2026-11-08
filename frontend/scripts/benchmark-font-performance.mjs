// Opt-in local evidence. Timing is descriptive, never a CI speed threshold.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { effectScope, nextTick, ref } from 'vue'
import * as currentLookup from '../src/lib/rareCharacters.js'
import * as currentAvailability from '../src/composables/useFontAvailability.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const baseline = process.argv[2] || 'f3834f5'
const output = path.resolve(
  process.argv[3] || 'output/playwright/ui-performance/font-performance.json'
)
const temporary = await mkdtemp(path.join(os.tmpdir(), 'wanyu-font-performance-'))
const modules = [
  'lib/rareCharacters.js',
  'lib/fontCoverage.json',
  'composables/useFontAvailability.js'
]
try {
  await writeFile(path.join(temporary, 'package.json'), '{"type":"module"}')
  await symlink(path.join(root, 'frontend/node_modules'), path.join(temporary, 'node_modules'))
  for (const file of modules) {
    const dest = path.join(temporary, 'src', file)
    await mkdir(path.dirname(dest), { recursive: true })
    await writeFile(
      dest,
      execFileSync('git', ['show', `${baseline}:frontend/src/${file}`], { cwd: root })
    )
  }
  const beforeLookup = await import(
    pathToFileURL(path.join(temporary, 'src/lib/rareCharacters.js'))
  )
  const beforeAvailability = await import(
    pathToFileURL(path.join(temporary, 'src/composables/useFontAvailability.js'))
  )
  const glyphs = Array.from({ length: 256 }, (_, i) =>
    String.fromCodePoint(i % 2 ? 0x20 + i : 0x20000 + i)
  )
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
  function lookup(module) {
    const times = []
    let checksum = 0
    for (let run = 0; run < 8; run++) {
      const started = performance.now()
      for (let repeat = 0; repeat < 100; repeat++)
        for (const glyph of glyphs) checksum += module.fontFamilyForCharacter(glyph).length
      if (run) times.push(performance.now() - started)
    }
    return { lookupsPerRun: glyphs.length * 100, runsMs: times, medianMs: median(times), checksum }
  }
  async function checks(module) {
    const previous = globalThis.document
    let calls = 0
    globalThis.document = {
      fonts: {
        load: async () => {
          calls++
          return [{}]
        }
      }
    }
    const scope = effectScope()
    try {
      const texts = ref(['ɡ⁵́𢶀ɑ'])
      const result = scope.run(() => module.useFontAvailability(texts))
      for (let i = 0; i < 10; i++) {
        texts.value = [i % 2 ? 'ɡ⁵́𢶀ɑ' : 'ɑ𢶀́⁵ɡ ordinary text']
        await nextTick()
      }
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(result.state.value, 'ready')
      return calls
    } finally {
      scope.stop()
      globalThis.document = previous
    }
  }
  const before = { lookup: lookup(beforeLookup), fontApiCalls: await checks(beforeAvailability) }
  const after = { lookup: lookup(currentLookup), fontApiCalls: await checks(currentAvailability) }
  assert.equal(after.lookup.checksum, before.lookup.checksum)
  assert.equal(before.fontApiCalls, 55)
  assert.equal(after.fontApiCalls, 5)
  const report = {
    baseline,
    synthetic: true,
    environment: process.version,
    note: 'Node microbenchmark; font API calls are not network downloads',
    before,
    after
  }
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
