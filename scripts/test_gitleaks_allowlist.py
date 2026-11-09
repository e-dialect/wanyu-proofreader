"""Check the real scanner keeps detecting secrets alongside frozen digests."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / 'docs/evidence/assist-publication-main-20261109'
SCANNER = os.environ.get('GITLEAKS_BIN')


class GitleaksAllowlistTest(unittest.TestCase):
    def test_default_rules_remain_enabled(self):
        config = tomllib.loads((ROOT / '.gitleaks.toml').read_text())
        self.assertEqual(config['extend'], {'useDefault': True})
        self.assertNotIn('rules', config)
        self.assertEqual(len(config['allowlists']), 4)
        for item in config['allowlists']:
            self.assertEqual(item['condition'], 'AND')
            self.assertEqual(item['targetRules'], ['generic-api-key'])
            self.assertEqual(item['regexTarget'], 'line')

    @unittest.skipUnless(SCANNER, 'CI runs with the pinned Gitleaks binary')
    def test_frozen_reports_and_secret_canaries(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for source in REPORTS.glob('*.json'):
                target = root / source.relative_to(ROOT)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())

            def scan():
                report = root / 'scan-result.json'
                result = subprocess.run([
                    str(Path(SCANNER).resolve()), 'dir', '.', '--no-banner', '--redact',
                    '--config', str(ROOT / '.gitleaks.toml'),
                    '--gitleaks-ignore-path', str(root / 'absent-ignore'),
                    '--report-format', 'json', '--report-path', str(report),
                ], cwd=root, capture_output=True, text=True, timeout=60)
                self.assertIn(result.returncode, (0, 1), result.stderr)
                return result.returncode, json.loads(report.read_text())

            code, findings = scan()
            self.assertEqual((code, findings), (0, []), 'frozen report scan must be clean')

            source = REPORTS / 'final-engineering-probe.json'
            data = json.loads(source.read_text())
            field = 'backend/pdf_access.go'
            known = data['source_hashes'][field]
            known_line = next(line for line in source.read_text().splitlines() if f'"{field}":' in line)
            unknown = hashlib.sha256(b'synthetic non-allowlisted canary').hexdigest()
            target = root / source.relative_to(ROOT)
            # Same exact path and field, different value: still a finding.
            target.write_text(target.read_text().replace(known, unknown))
            # Same path/value, unrelated field: still a finding.
            with target.open('a') as output:
                output.write('\n' + json.dumps({'api_key': known}) + '\n')
                # A different provider rule in this report must also stay active.
                output.write(json.dumps({'token': 'ghp_' + unknown[:36]}) + '\n')
            # Same reviewed line/value in an unrelated path must not be exempt.
            (root / 'unrelated.json').write_text(known_line + '\n')
            code, findings = scan()
            self.assertEqual(code, 1)
            self.assertEqual(len(findings), 4, [
                (row['File'], row['RuleID'], row['StartLine']) for row in findings
            ])
            self.assertEqual(sum(row['RuleID'] == 'generic-api-key' for row in findings), 3)
            self.assertEqual(sum(row['RuleID'] == 'github-pat' for row in findings), 1)
            self.assertEqual(sum(row['File'] == 'unrelated.json' for row in findings), 1)


if __name__ == '__main__':
    unittest.main()
