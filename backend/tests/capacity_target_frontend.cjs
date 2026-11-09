// Disposable target-side static host and API proxy, never a load generator.
const { startHost } = require('./export_browser_host.cjs')
async function main() {
  const host = await startHost(process.argv[2], { dist: process.argv[3] })
  process.stdout.write(JSON.stringify({ origin: host.origin }) + '\n')
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await host.close()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
main().catch(() => { process.stderr.write('target_frontend_failed\n'); process.exit(1) })
