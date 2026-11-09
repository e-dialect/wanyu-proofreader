migrate((app) => {
  const attempts = app.findCollectionByNameOrId('proofreading_attempts')
  attempts.indexes = [...attempts.indexes,
    'CREATE INDEX idx_attempt_own_review_cursor ON proofreading_attempts (proofreader, project, kind, page, round, submitted_at)']
  app.save(attempts)
}, (app) => {
  const attempts = app.findCollectionByNameOrId('proofreading_attempts')
  attempts.indexes = attempts.indexes.filter(sql => !sql.includes('idx_attempt_own_review_cursor'))
  app.save(attempts)
})
