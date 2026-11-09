"""Reconcile synthetic submit acknowledgements with append-only DB records after stop.

This gate proves row characters/order and submission linkage, not all consensus semantics.
Only identifiers, counts and error codes leave this module; row content stays in memory.
"""
from collections import Counter, defaultdict
from contextlib import closing
import hashlib
import json
import re
import sqlite3


def row_sha256(row):
    """JSON.stringify(JSON.parse(rowJson)) for the API's flat string-field contract.

    JS enumerates integer-index keys first; remaining keys keep insertion order. No
    Unicode normalization, trimming or field sorting is allowed. JSON.stringify
    escapes lone UTF-16 surrogates, but preserves Unicode scalar characters.
    """
    if not isinstance(row, dict) or not row or any(not isinstance(v, str) for v in row.values()):
        raise ValueError('invalid_submission_row')
    index_keys = sorted((k for k in row if len(k) <= 10 and k.isascii() and k.isdecimal()
                         and str(int(k)) == k and int(k) < 4294967295), key=int)
    ordered = {key: row[key] for key in index_keys}
    ordered.update((key, value) for key, value in row.items() if key not in ordered)
    serialized = json.dumps(ordered, ensure_ascii=False, separators=(',', ':'))
    serialized = re.sub(r'[\ud800-\udfff]', lambda match: '\\u%04x' % ord(match[0]), serialized)
    return hashlib.sha256(serialized.encode('utf-8')).hexdigest()


def actor_records(sql, actor_ids):
    # Intentionally no project predicate: cross-project writes must be visible.
    marks = ','.join('?' for _ in actor_ids)
    attempts = [dict(row) for row in sql.execute(
        f"SELECT * FROM proofreading_attempts WHERE kind='proofread' AND proofreader IN ({marks})", actor_ids)]
    events = [dict(row) for row in sql.execute(
        f"""SELECT e.* FROM verification_events e LEFT JOIN proofreading_attempts a ON a.id=e.ref
        WHERE e.kind='submission' AND (e.actor IN ({marks}) OR
        (a.kind='proofread' AND a.proofreader IN ({marks})))""", (*actor_ids, *actor_ids))]
    return attempts, events


def snapshot_actor_records(db, actor_ids):
    with closing(sqlite3.connect(db)) as sql:
        sql.row_factory = sqlite3.Row
        attempts, events = actor_records(sql, actor_ids)
    return {'attempt_ids': {row['id'] for row in attempts}, 'event_ids': {row['id'] for row in events}}


def reconcile_submissions(db, project_id, actor_ids, baseline, requests):
    actor_ids = tuple(actor_ids)
    acknowledgements = [row for row in requests if row.get('operation') == 'submit'
                        and row.get('ok') and 200 <= row.get('status', 0) < 300]
    errors = []
    def error(code, **ids):
        errors.append({'code': code, **ids})
    expected = Counter()
    for request in acknowledgements:
        evidence = request.get('submission')
        if (not isinstance(evidence, dict) or set(evidence) != {'actor_id', 'page_id', 'row_sha256'}
                or evidence.get('actor_id') not in actor_ids
                or not isinstance(evidence.get('page_id'), str) or not evidence['page_id']
                or not isinstance(evidence.get('row_sha256'), str)
                or not re.fullmatch('[a-f0-9]{64}', evidence['row_sha256'])):
            error('missing_or_invalid_request_evidence')
            continue
        expected[(evidence['actor_id'], evidence['page_id'], evidence['row_sha256'])] += 1
    with closing(sqlite3.connect(db)) as sql:
        sql.row_factory = sqlite3.Row
        all_attempts, all_events = actor_records(sql, actor_ids)
        attempts = [row for row in all_attempts if row['id'] not in baseline['attempt_ids']]
        events = [row for row in all_events if row['id'] not in baseline['event_ids']]
        page_projects = dict(sql.execute('SELECT id,project FROM pages'))
    events_by_ref = defaultdict(list)
    for event in events:
        events_by_ref[event['ref']].append(event)
    attempt_ids = {row['id'] for row in attempts}
    matched = 0
    for attempt in attempts:
        aid = attempt['id']
        if attempt['project'] != project_id or page_projects.get(attempt['page']) != project_id:
            error('unexpected_attempt_project', attempt_id=aid)
        try:
            digest = row_sha256(json.loads(attempt['row_json']))
        except (TypeError, ValueError):
            digest = None
            error('invalid_attempt_row', attempt_id=aid)
        key = (attempt['proofreader'], attempt['page'], digest)
        if expected[key]:
            expected[key] -= 1
            matched += 1
        else:
            error('attempt_without_matching_request_digest', attempt_id=aid)
        linked = events_by_ref[aid]
        if len(linked) != 1:
            error('submission_event_count', attempt_id=aid, count=len(linked))
        for event in linked:
            eid = event['id']
            if (event['actor'] != attempt['proofreader'] or event['page'] != attempt['page']
                    or event['project'] != attempt['project'] or event['project'] != project_id):
                error('submission_event_identity', attempt_id=aid, event_id=eid)
            try:
                event_digest = row_sha256(json.loads(event['payload_json'])['row'])
            except (TypeError, ValueError, KeyError):
                event_digest = None
            if event_digest is None or event_digest != digest:
                error('submission_event_row_digest', attempt_id=aid, event_id=eid)
    for event in events:
        if event['ref'] not in attempt_ids:
            error('submission_event_without_new_attempt', event_id=event['id'])
    unmatched = sum(expected.values())
    if unmatched:
        error('acknowledgement_without_matching_attempt', count=unmatched)
    if len(attempts) != len(acknowledgements):
        error('attempt_acknowledgement_count')
    return {'pass': not errors, 'acknowledged_submissions': len(acknowledgements),
            'new_actor_attempts_all_projects': len(attempts), 'new_submission_events': len(events),
            'matched_request_digests': matched, 'errors': errors,
            'scope': 'load actors across all projects; exact row digest and submission linkage only'}
