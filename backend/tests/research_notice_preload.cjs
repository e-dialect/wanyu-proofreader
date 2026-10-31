// 其他集成测试在这条门禁之前就有提交。它们测的是租约、人数和字段，
// 不是研究用途。这里在真正提交前补一条「同意」，让那些断言保持原样。
// 研究用途自己的套件会先设 __fangjiManualResearchNotice，从而跳过自动同意。
const original = global.fetch
if (typeof original === 'function') {
  global.fetch = async function researchNoticeFetch(input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      const manual = global.__fangjiManualResearchNotice
      if (!manual && url.includes('/api/fangji/pages/') && /\/submit(?:\?.*)?$/.test(url)) {
        const headers = new Headers((init && init.headers) || (typeof input !== 'string' && input && input.headers) || {})
        const auth = headers.get('authorization')
        if (auth) {
          const noticeUrl = url.replace(/\/pages\/[^/]+\/submit(?:\?.*)?$/, '/research-notice')
          await original(noticeUrl, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ choice: 'participate' })
          })
        }
      }
    } catch {
      // 提交请求自己的状态码才是测试断言的对象。
    }
    return original(input, init)
  }
}
