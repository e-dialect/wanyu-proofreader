import { listLocalAccountDrafts } from './localAccountData.js'

// Only the shell's explicit logout action uses this registry. It never wraps
// auth-store clearing, server revocation or another account's login.
export function createDraftExitRegistry() {
  const editors = new Set()
  return {
    register(editor) {
      editors.add(editor)
      return () => editors.delete(editor)
    },
    captureReturn(userId) {
      const restore = [...editors]
        .filter((editor) => editor.userId === userId)
        .map((editor) => editor.captureReturn?.())
        .filter(Boolean)
      return () => restore.forEach((fn) => fn())
    },
    prepare(userId, storage) {
      if (!userId) return { ok: false, message: '登录状态已变化，请重新核对。' }
      try {
        for (const editor of editors) {
          if (editor.userId !== userId) continue
          if (editor.flush().ok !== true)
            return { ok: false, message: '当前编辑内容尚未保存，请返回页面处理后再退出。' }
        }
        if (!storage) throw new Error('storage unavailable')
        const drafts = listLocalAccountDrafts(storage, userId)
        return {
          ok: true,
          total: drafts.length,
          history: drafts.filter((draft) => draft.history).length
        }
      } catch {
        return { ok: false, message: '无法保存或检查本机草稿，请返回页面处理后再退出。' }
      }
    },
    allowNavigation(userId) {
      const restore = [...editors]
        .filter((editor) => editor.userId === userId)
        .map((editor) => editor.allowNavigation?.())
        .filter(Boolean)
      return () => restore.forEach((fn) => fn())
    },
    clear() {
      editors.clear()
    }
  }
}
