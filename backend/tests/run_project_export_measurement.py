"""Compare historical browser full-list export and the shipped download helper.

Uses only 12,000 synthesized rows in a disposable, fully migrated real server.
Requires Playwright and an installed browser; writes only numeric evidence.
"""
import json
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import subprocess
import urllib.request

import harness


def api(base, path, body=None, token=''):
    request = urllib.request.Request(base + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def main():
    output = Path(os.environ.get('PROJECT_EXPORT_MEASURE_OUT', 'output/issue184/browser-memory.json')).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with harness.temporary_root() as root:
        binary = harness.build_binary(root / 'pocketbase')
        with harness.server(binary, root) as env:
            base = env['PB_URL']
            admin = api(base, '/api/collections/users/auth-with-password',
                        {'identity': env['APP_ADMIN_EMAIL'], 'password': env['APP_ADMIN_PASSWORD']})
            project = api(base, '/api/fangji/projects', {'name': 'Synthetic export measurement'}, admin['token'])
            content = json.dumps({'词条': '𢶀𠮷a̤̍合成样例', '释义': 'synthetic' * 256}, ensure_ascii=False, separators=(',', ':'))
            with closing(sqlite3.connect(root / 'data/data.db')) as db:
                db.executemany('''INSERT INTO pages (id,project,page_number,pdf_page,status,quality_state,
                    ocr_row_json,proofread_row_json,row_headers_json,source_system,source_id,source_version,proofread_round)
                    VALUES (?,?,?,?,'approved','candidate',?,?,'["词条","释义"]','synthetic','fixture','v1',1)''',
                    ((f'{n:015d}', project['id'], n, n, content, content) for n in range(1, 12001)))
                count = db.execute('SELECT count(*) FROM pages WHERE project=?', (project['id'],)).fetchone()[0]
                db.commit()
            fixture = {'base': base, 'token': admin['token'], 'projectId': project['id'], 'rows': count}
            subprocess.run(['node', str(harness.BACKEND / 'tests/project_export_measure.cjs')],
                input=json.dumps(fixture), text=True, check=True,
                env={**env, 'PROJECT_EXPORT_MEASURE_OUT': str(output)})


if __name__ == '__main__':
    main()
