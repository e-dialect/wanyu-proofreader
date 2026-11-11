function currentRound(page) {
  return page.getInt("proofread_round") || 1
}

function proofreadAttempts(dao, page) {
  const round = currentRound(page)
  return dao.findRecordsByFilter(
    "proofreading_attempts",
    `page = "${page.id}" && round = ${round} && kind = "proofread"`,
    "pass_no,created",
    1000,
    0
  )
}

function ownProofreadAttempt(dao, page, userId) {
  const round = currentRound(page)
  const attempts = dao.findRecordsByFilter(
    "proofreading_attempts",
    `page = "${page.id}" && round = ${round} && proofreader = "${userId}" && kind = "proofread"`,
    "",
    1,
    0
  )
  return attempts.length ? attempts[0] : null
}

// A reviewed-task cursor needs only this user's current-round attempt and the
// page identity/order. Loading every project page here copied private corpus
// bodies into the JS VM on each editor navigation, even for an empty history.
// The unique (page,round,proofreader,kind) index guarantees one result per page.
// Return the complete own history; no arbitrary 100k/100-row truncation.
function reviewedProofreads(dao, projectId, userId) {
  return reviewedProofreadHistory(dao, projectId, userId).items
}

// Only metadata enters the JS VM. Pagination and cursor position use the same
// filter and order; a cursor on another page keeps its global position.
function reviewedProofreadHistory(dao, projectId, userId, options = {}) {
  const params = { user: userId, project: projectId }
  let from = `FROM proofreading_attempts a JOIN pages p ON p.id=a.page AND p.project=a.project
    WHERE a.proofreader={:user} AND a.project={:project} AND a.kind='proofread'
      AND a.round=COALESCE(NULLIF(p.proofread_round,0),1)`
  if (options.number) {
    from += " AND p.page_number={:number}"
    params.number = options.number
  }
  const order = options.sort === "recent" ? "a.submitted_at DESC,p.page_number,p.id" : "p.page_number,p.id"
  const select = "SELECT p.id,p.page_number,a.submitted_at " + from
  const paginated = options.page !== undefined
  let total, page, totalPages
  let suffix = " ORDER BY " + order
  if (paginated) {
    const count = new DynamicModel({ count: 0 })
    dao.db().newQuery("SELECT COUNT(*) AS count " + from).bind(params).one(count)
    total = Number(count.count)
    totalPages = Math.max(1, Math.ceil(total / options.perPage))
    page = Math.min(options.page, totalPages)
    params.limit = options.perPage
    params.offset = (page - 1) * options.perPage
    suffix += " LIMIT {:limit} OFFSET {:offset}"
  }
  const rows = arrayOf(new DynamicModel({ id: "", page_number: 0, submitted_at: "" }))
  dao.db().newQuery(select + suffix).bind(params).all(rows)
  const items = rows.map(row => ({ id: row.id, page_number: Number(row.page_number), submitted_at: String(row.submitted_at || "") }))
  let position = 0
  if (options.pageId) {
    if (paginated) {
      const cursor = new DynamicModel({ position: 0 })
      dao.db().newQuery(`SELECT COALESCE(MAX(position),0) AS position FROM (
        SELECT p.id,ROW_NUMBER() OVER (ORDER BY ${order}) AS position ${from}
      ) WHERE id={:cursor}`).bind({ ...params, cursor: options.pageId }).one(cursor)
      position = Number(cursor.position)
    } else {
      position = items.findIndex(item => item.id === options.pageId) + 1
    }
  }
  return {
    items, position, total: paginated ? total : items.length,
    ...(paginated ? { page, perPage: options.perPage, totalPages } : {})
  }
}

function arbitrationAttempt(dao, page) {
  const round = currentRound(page)
  const attempts = dao.findRecordsByFilter(
    "proofreading_attempts",
    `page = "${page.id}" && round = ${round} && kind = "arbitration"`,
    "created",
    1,
    0
  )
  return attempts.length ? attempts[0] : null
}

function requiredProofreads(dao, projectId) {
  const project = dao.findRecordById("projects", projectId)
  return Math.max(2, project.getInt("required_proofreads") || 2)
}

// Precomposed and decomposed spellings of the same reading are the same reading.
// This corpus is full of nasalised vowels with combining tildes, and U+00E3 (ã)
// versus a + U+0303 render identically while differing in bytes, so raw string
// comparison reported two proofreaders as disagreeing when no one could see a
// difference. That false divergence went straight into arbitration and counted
// against the proofreaders' accuracy, because it spends the scarcest resource
// in the project on a difference that does not exist.
//
// NFC only, never NFKC. NFKC goes further and folds compatibility forms —
// fullwidth Ａ to A, superscript ² to 2 and ʰ to h, the ﬁ ligature to fi — which
// would erase distinctions this project deliberately keeps. That is a worse
// error than the one being fixed here, so the direction is pinned by a test.
//
// Reading those tests: ɑ (U+0251) and Ǿ (U+01FE) survive NFKC unchanged, so a
// pair like ɑ/a cannot tell the two forms apart and stays green under an NFKC
// implementation. Only a pair NFKC really folds can pin this direction.
//
// This is a comparison key, never a write-back: an attempt's row_json keeps the
// exact codepoints its proofreader typed.
function normalizeNFC(value) {
  // goja implements String.prototype.normalize with a real NFC branch, so this
  // needs no Go-side comparison rewrite and no new dependency. A probe test
  // pins it: swapping the JSVM for one without it would silently turn this into
  // the identity function and bring the false divergences straight back.
  return String(value ?? "").normalize("NFC")
}

function canonicalRow(raw, policy) {
  return require(typeof __hooks === "undefined" ? "./source_comparison.js" : `${__hooks}/lib/source_comparison.js`).canonicalRow(raw, policy)
}

function setAttemptOutcomes(dao, attempts, outcome) {
  for (const attempt of attempts) {
    if (attempt.getString("outcome") === outcome) continue
    attempt.set("outcome", outcome)
    dao.save(attempt)
  }
}

function resetPageForMoreProofreads(dao, page, attempts) {
  const { clearLease } = require(`${__hooks}/lib/task_leases.js`)
  page.set("proofread_count", attempts.length)
  page.set("proofread_row_json", "")
  page.set("proofread_text", "")
  page.set("proofreader", null)
  page.set("status", attempts.length ? "proofread" : "pending")
  clearLease(dao, page)
  setAttemptOutcomes(dao, attempts, "waiting")
  dao.save(page)
  return { status: page.getString("status"), count: attempts.length, outcome: "waiting" }
}

function evaluatePage(dao, page) {
  const { clearLease } = require(`${__hooks}/lib/task_leases.js`)
  const attempts = proofreadAttempts(dao, page)
  const required = requiredProofreads(dao, page.getString("project"))
  page.set("proofread_count", attempts.length)
  if (attempts.length < required) return resetPageForMoreProofreads(dao, page, attempts)

  const fidelity = require(`${__hooks}/lib/source_fidelity.js`)
  const policy = fidelity.policyFor(dao, page.getString("project"))
  const values = attempts.map((attempt) => canonicalRow(attempt.getString("row_json"), policy))
  const matched = values.every((value) => value === values[0])
  page.set("proofreader", null)
  clearLease(dao, page)
  if (matched) {
    const source = attempts[0]
    page.set("proofread_row_json", source.getString("row_json"))
    page.set("proofread_text", source.getString("text"))
    // 缺字已补：正式采纳的内容不再含 @N 时，退出缺字待登记队列。
    // 只清自动状态（missing_glyph），不碰人工 blocked_reason。
    if (page.getBool("missing_glyph")) {
      const { PLACEHOLDER } = require(`${__hooks}/lib/assist_rules.js`)
      if (!(source.getString("text") || "").match(PLACEHOLDER)) {
        page.set("missing_glyph", false)
      }
    }
    page.set("proofread_at", String(source.get("submitted_at") || new Date().toISOString()))
    page.set("status", "approved")
    const context = fidelity.parse(source.getString("verification_context_json"))
    page.set("verification_basis", context.basis || "")
    page.set("verification_context_json", JSON.stringify(context))
    fidelity.recordAdoption(dao, page, "system", fidelity.parse(source.getString("row_json")), {}, source.id)
    setAttemptOutcomes(dao, attempts, "matched")
    dao.save(page)
    return { status: "approved", count: attempts.length, outcome: "matched" }
  }

  const alreadyMismatched = attempts.some((attempt) => attempt.getString("outcome") === "mismatched")
  page.set("proofread_row_json", "")
  page.set("proofread_text", "")
  page.set("status", "arbitration")
  if (!alreadyMismatched) {
    page.set("mismatch_count", page.getInt("mismatch_count") + 1)
    page.set("last_mismatch_at", new Date().toISOString())
  }
  setAttemptOutcomes(dao, attempts, "mismatched")
  dao.save(page)
  return { status: "arbitration", count: attempts.length, outcome: "mismatched" }
}

function reconcileProjectQuorum(dao, projectId) {
  const { leaseForPage, leaseExpired, clearLease } = require(`${__hooks}/lib/task_leases.js`)
  const pages = dao.findRecordsByFilter("pages", `project = "${projectId}"`, "page_number", 100000, 0)
  const required = requiredProofreads(dao, projectId)
  for (const page of pages) {
    // Quorum changes are not a recovery action for excluded/staged/rework rows.
    // In particular, historical matching attempts must not re-approve a row the
    // manager has explicitly classified as empty/not applicable.
    if (page.getBool("source_empty") || !["pending", "proofread", "approved", "claimed", "proofreading", "arbitration"].includes(page.getString("status"))) continue
    if (arbitrationAttempt(dao, page)) continue
    if (page.getString("status") === "arbitration") continue
    const attempts = proofreadAttempts(dao, page)
    page.set("proofread_count", attempts.length)
    const active = ["claimed", "proofreading"].includes(page.getString("status"))
    if (active) {
      const lease = leaseForPage(dao, page.id)
      if (lease && !leaseExpired(lease)) {
        dao.save(page)
        continue
      }
      clearLease(dao, page)
    }
    if (attempts.length >= required) evaluatePage(dao, page)
    else if (page.getString("status") === "approved" || active) resetPageForMoreProofreads(dao, page, attempts)
    else dao.save(page)
  }
}

module.exports = {
  proofreadAttempts,
  ownProofreadAttempt,
  reviewedProofreads,
  reviewedProofreadHistory,
  arbitrationAttempt,
  requiredProofreads,
  canonicalRow,
  evaluatePage,
  reconcileProjectQuorum
}
