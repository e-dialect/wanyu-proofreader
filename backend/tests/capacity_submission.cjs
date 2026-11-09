// Local synthetic capacity evidence only. Never return row text, leases or credentials.
const { createHash } = require('node:crypto')

function submissionEvidence(pathname, actorId, body) {
  const pageId = /^\/api\/fangji\/pages\/([^/]+)\/submit$/.exec(pathname)?.[1]
  if (!pageId || !actorId || typeof body?.rowJson !== 'string') {
    throw new Error('invalid_submission_evidence')
  }
  const row = JSON.parse(body.rowJson)
  if (!row || Array.isArray(row) || typeof row !== 'object' ||
      !Object.keys(row).length || Object.values(row).some((value) => typeof value !== 'string')) {
    throw new Error('invalid_submission_row')
  }
  return {
    page_id: pageId,
    actor_id: actorId,
    row_sha256: createHash('sha256').update(JSON.stringify(row), 'utf8').digest('hex')
  }
}

module.exports = { submissionEvidence }
