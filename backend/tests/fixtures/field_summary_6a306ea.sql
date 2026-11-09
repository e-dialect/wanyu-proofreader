
WITH field_totals AS (
  SELECT field.key AS field_name, COUNT(*) AS submitted_fields
  FROM proofreading_attempts a,
       json_each(CASE WHEN json_valid(a.row_json) THEN CASE WHEN json_type(a.row_json) = 'object' THEN a.row_json ELSE '{}' END ELSE '{}' END) field
  WHERE a.project = :project AND a.kind = 'proofread'
  GROUP BY field.key
), ordered_judgments AS (
  SELECT ref AS attempt, page, field_name,
         json_extract(payload_json, '$.state') AS state,
         CAST(json_extract(payload_json, '$.value') AS TEXT) AS judged_value,
         ROW_NUMBER() OVER (
           PARTITION BY ref, field_name
           ORDER BY created DESC, CAST(COALESCE(json_extract(payload_json, '$.revision'), 0) AS INTEGER) DESC, id DESC
         ) AS position
  FROM verification_events
  WHERE project = :project AND kind = 'judgment' AND ref != 'final' AND json_valid(payload_json)
), known_fields AS (
  SELECT j.field_name,
         SUM(CASE WHEN j.state = 'correct' THEN 1 ELSE 0 END) AS correct_count,
         SUM(CASE WHEN j.state = 'incorrect' THEN 1 ELSE 0 END) AS incorrect_count,
         SUM(CASE WHEN j.state = 'pending' THEN 1 ELSE 0 END) AS pending_count,
         SUM(CASE WHEN j.state = 'withdrawn' THEN 1 ELSE 0 END) AS withdrawn_count
  FROM ordered_judgments j
  JOIN proofreading_attempts a ON a.id = j.attempt AND a.page = j.page
       AND a.project = :project AND a.kind = 'proofread'
  JOIN json_each(CASE WHEN json_valid(a.row_json) THEN CASE WHEN json_type(a.row_json) = 'object' THEN a.row_json ELSE '{}' END ELSE '{}' END) field
       ON field.key = j.field_name AND CAST(field.value AS TEXT) = j.judged_value
  WHERE j.position = 1 AND j.state IN ('correct','incorrect','pending','withdrawn')
  GROUP BY j.field_name
), summary AS (
  SELECT t.field_name, t.submitted_fields,
         COALESCE(k.correct_count, 0) AS correct_count,
         COALESCE(k.incorrect_count, 0) AS incorrect_count,
         COALESCE(k.pending_count, 0) AS pending_count,
         COALESCE(k.withdrawn_count, 0) AS withdrawn_count,
         t.submitted_fields - COALESCE(k.correct_count, 0) - COALESCE(k.incorrect_count, 0)
           - COALESCE(k.pending_count, 0) - COALESCE(k.withdrawn_count, 0) AS unrecorded_count
  FROM field_totals t LEFT JOIN known_fields k ON k.field_name = t.field_name
), ranked AS (
  SELECT summary.*, COUNT(*) OVER () AS total_items,
         ROW_NUMBER() OVER (ORDER BY field_name COLLATE BINARY) AS row_position
  FROM summary
)
SELECT * FROM ranked
WHERE row_position > MIN(:offset, CAST((total_items - 1) / :limit AS INTEGER) * :limit)
ORDER BY row_position LIMIT :limit