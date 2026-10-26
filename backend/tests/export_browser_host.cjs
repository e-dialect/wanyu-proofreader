const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

exports.startHost = async function (base) {
  const root = path.resolve(__dirname, '../..')
  const dist = path.join(root, 'frontend/dist')
  const sources = {
    '/projectExport.js': path.join(root, 'frontend/src/lib/projectExport.js'),
    '/legacy_csv_oracle.mjs': path.join(__dirname, 'legacy_csv_oracle.mjs'),
    '/structuredRow.js': path.join(root, 'frontend/src/lib/structuredRow.js')
  }
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      const target = new URL(req.url, base)
      const proxy = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (upstream) => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res) })
      proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      res.on('close', () => proxy.destroy())
      req.pipe(proxy)
      return
    }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (pathname === '/benchmark.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Synthetic export measurement</title>'); return }
    let file = sources[pathname]
    if (!file) {
      const asset = path.resolve(dist, `.${pathname}`)
      if (!asset.startsWith(dist + path.sep) && asset !== dist) { res.writeHead(403); res.end(); return }
      file = fs.existsSync(asset) && fs.statSync(asset).isFile() ? asset : path.join(dist, 'index.html')
    }
    res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) }
}
