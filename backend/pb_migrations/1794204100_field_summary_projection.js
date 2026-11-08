// Transactional, disposable read model. No source text/value/context is copied.
// PocketBase runs each migration in one transaction: readers see either the
// old SQL path or the complete backfill plus every maintenance trigger.
const counters = ['submitted_fields', 'correct_count', 'incorrect_count', 'pending_count', 'withdrawn_count', 'unrecorded_count']
const columns = counters.join(', ')
const definitions = counters.map(name => `${name} INTEGER NOT NULL CHECK (${name} >= 0)`).join(', ')
const balanced = 'CHECK (submitted_fields = correct_count + incorrect_count + pending_count + withdrawn_count + unrecorded_count)'

// This is deliberately frozen with the migration, not imported from live hooks.
// A latest mismatching judgment shadows earlier matching judgments. Duplicate
// JSON keys each contribute, exactly as the historical json_each projection.
function projection(attemptPredicate, fieldPredicate = '1') {
  return `WITH judged AS MATERIALIZED (
    SELECT a.id AS attempt, a.project, field.key AS field_name,
      (SELECT CASE WHEN j.page = a.page AND CAST(json_extract(j.payload_json, '$.value') AS TEXT) = CAST(field.value AS TEXT)
         THEN json_extract(j.payload_json, '$.state') END
       FROM verification_events j
       WHERE j.project = a.project AND j.kind = 'judgment' AND j.ref != 'final' AND json_valid(j.payload_json)
         AND j.ref = a.id AND j.field_name = field.key
       ORDER BY j.created DESC, CAST(COALESCE(json_extract(j.payload_json, '$.revision'), 0) AS INTEGER) DESC, j.id DESC LIMIT 1) AS state
    FROM proofreading_attempts a,
      json_each(CASE WHEN json_valid(a.row_json) THEN CASE WHEN json_type(a.row_json) = 'object' THEN a.row_json ELSE '{}' END ELSE '{}' END) field
    WHERE a.kind = 'proofread' AND (${attemptPredicate}) AND (${fieldPredicate})
  ) SELECT attempt, project, field_name, COUNT(*),
    SUM(CASE WHEN state = 'correct' THEN 1 ELSE 0 END),
    SUM(CASE WHEN state = 'incorrect' THEN 1 ELSE 0 END),
    SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END),
    SUM(CASE WHEN state = 'withdrawn' THEN 1 ELSE 0 END),
    SUM(CASE WHEN state IN ('correct', 'incorrect', 'pending', 'withdrawn') THEN 0 ELSE 1 END)
    FROM judged GROUP BY attempt, project, field_name`
}
function insertProjection(attemptPredicate, fieldPredicate) {
  // SQLite permits a WITH clause inside INSERT's SELECT in a trigger, but not
  // as the leading statement in a trigger body.
  return `INSERT INTO _field_audit_contributions (attempt, project, field_name, ${columns}) ${projection(attemptPredicate, fieldPredicate)};`
}
const validEvent = prefix => `${prefix}.kind = 'judgment' AND ${prefix}.ref != 'final' AND json_valid(${prefix}.payload_json)`
const eventRefresh = prefix => `
  DELETE FROM _field_audit_contributions WHERE attempt = ${prefix}.ref AND field_name = ${prefix}.field_name;
  ${insertProjection(`a.id = ${prefix}.ref`, `field.key = ${prefix}.field_name`)}`
const relevantEventChange = ['id', 'project', 'page', 'kind', 'ref', 'field_name', 'created', 'payload_json'].map(name => `OLD.${name} IS NOT NEW.${name}`).join(' OR ')
const relevantAttemptChange = ['id', 'project', 'page', 'kind', 'row_json'].map(name => `OLD.${name} IS NOT NEW.${name}`).join(' OR ')
const triggerNames = ['contribution_insert', 'contribution_delete', 'attempt_insert', 'attempt_update', 'attempt_delete', 'event_insert', 'event_update', 'event_delete'].map(name => `_field_audit_${name}`)

migrate((app) => {
  const execute = sql => app.db().newQuery(sql).execute()
  execute(`CREATE TABLE _field_audit_contributions (
    attempt TEXT NOT NULL, project TEXT NOT NULL, field_name TEXT NOT NULL,
    ${definitions}, ${balanced}, PRIMARY KEY (attempt, field_name)
  ) WITHOUT ROWID`)
  execute(`CREATE TABLE _field_audit_totals (
    project TEXT NOT NULL, field_name TEXT NOT NULL,
    ${definitions}, ${balanced}, PRIMARY KEY (project, field_name)
  ) WITHOUT ROWID`)
  execute('CREATE TABLE _field_audit_projection_meta (version INTEGER PRIMARY KEY CHECK (version = 1), enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)))')
  execute(insertProjection('1'))
  execute(`INSERT INTO _field_audit_totals (project, field_name, ${columns})
    SELECT project, field_name, ${counters.map(name => `SUM(${name})`).join(', ')}
    FROM _field_audit_contributions GROUP BY project, field_name`)
  execute(`CREATE TRIGGER _field_audit_contribution_insert AFTER INSERT ON _field_audit_contributions BEGIN
    INSERT INTO _field_audit_totals (project, field_name, ${columns}) VALUES (NEW.project, NEW.field_name, ${counters.map(name => `NEW.${name}`).join(', ')})
    ON CONFLICT(project, field_name) DO UPDATE SET ${counters.map(name => `${name} = ${name} + excluded.${name}`).join(', ')};
  END`)
  execute(`CREATE TRIGGER _field_audit_contribution_delete AFTER DELETE ON _field_audit_contributions BEGIN
    UPDATE _field_audit_totals SET ${counters.map(name => `${name} = ${name} - OLD.${name}`).join(', ')} WHERE project = OLD.project AND field_name = OLD.field_name;
    DELETE FROM _field_audit_totals WHERE project = OLD.project AND field_name = OLD.field_name AND submitted_fields = 0;
  END`)
  execute(`CREATE TRIGGER _field_audit_attempt_insert AFTER INSERT ON proofreading_attempts BEGIN
    DELETE FROM _field_audit_contributions WHERE attempt = NEW.id;
    ${insertProjection('a.id = NEW.id')}
  END`)
  execute(`CREATE TRIGGER _field_audit_attempt_update AFTER UPDATE ON proofreading_attempts WHEN ${relevantAttemptChange} BEGIN
    DELETE FROM _field_audit_contributions WHERE attempt IN (OLD.id, NEW.id);
    ${insertProjection('a.id = NEW.id')}
  END`)
  execute(`CREATE TRIGGER _field_audit_attempt_delete AFTER DELETE ON proofreading_attempts BEGIN
    DELETE FROM _field_audit_contributions WHERE attempt = OLD.id;
  END`)
  execute(`CREATE TRIGGER _field_audit_event_insert AFTER INSERT ON verification_events WHEN ${validEvent('NEW')} BEGIN ${eventRefresh('NEW')} END`)
  execute(`CREATE TRIGGER _field_audit_event_delete AFTER DELETE ON verification_events WHEN ${validEvent('OLD')} BEGIN ${eventRefresh('OLD')} END`)
  execute(`CREATE TRIGGER _field_audit_event_update AFTER UPDATE ON verification_events
    WHEN (${validEvent('OLD')} OR ${validEvent('NEW')}) AND (${relevantEventChange}) BEGIN
    DELETE FROM _field_audit_contributions WHERE (attempt = OLD.ref AND field_name = OLD.field_name) OR (attempt = NEW.ref AND field_name = NEW.field_name);
    ${insertProjection('a.id IN (OLD.ref, NEW.ref)', '(a.id = OLD.ref AND field.key = OLD.field_name) OR (a.id = NEW.ref AND field.key = NEW.field_name)')}
  END`)
  execute('INSERT INTO _field_audit_projection_meta(version, enabled) VALUES (1, 1)')
}, (app) => {
  for (const name of triggerNames) app.db().newQuery(`DROP TRIGGER IF EXISTS ${name}`).execute()
  for (const name of ['_field_audit_projection_meta', '_field_audit_totals', '_field_audit_contributions']) app.db().newQuery(`DROP TABLE IF EXISTS ${name}`).execute()
})
