// Loaded only by the disposable remote-capacity generators. Preserve Playwright's
// detached group semantics; give that group a registered, stable guardian leader.
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const originalSpawn = childProcess.spawn
const registry = process.env.CAPACITY_PROCESS_REGISTRY
const python = process.env.CAPACITY_GUARDIAN_PYTHON
const guardian = path.join(__dirname, 'capacity_process_ownership.py')
if (!registry || !python || !path.isAbsolute(registry) || !path.isAbsolute(python)) {
  throw new Error('capacity_generator_ownership_missing')
}
if (fs.realpathSync(__filename) !== __filename || fs.realpathSync(guardian) !== guardian) {
  throw new Error('capacity_generator_helper_outside_checkout')
}
childProcess.spawn = function (command, args, options) {
  if (!Array.isArray(args)) { options = args || {}; args = [] }
  options = options || {}
  if (!options.detached) return originalSpawn.call(this, command, args, options)
  const ticket = crypto.randomBytes(16).toString('hex')
  const pending = path.join(registry, ticket + '.pending')
  fs.writeFileSync(pending, fs.readFileSync(path.join(registry, 'nonce')), { mode: 0o600, flag: 'wx' })
  const child = originalSpawn.call(this, python,
    [guardian, registry, ticket, '--', command, ...args], options)
  child.once('error', () => { if (!child.pid) fs.rmSync(pending, { force: true }) })
  return child
}
