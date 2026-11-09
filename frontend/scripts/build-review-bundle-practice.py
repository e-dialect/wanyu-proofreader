#!/usr/bin/env python3
"""Build a tiny deterministic fictional ReviewBundle using the existing v0 contract.

No real identity, credential or source text. PDF and instructions are deliberately
unlisted attachments: import only reads entries.jsonl; users upload the PDF first.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1] / 'public/examples'
MATERIAL = ROOT / 'review-bundle-practice-v1'


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def source_pdf(rows):
    # As in the Bundle integration fixture, use a small ordinary PDF. The source
    # uses readable ASCII fields to avoid relying on external or unembedded fonts.
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               f'<< /Type /Pages /Kids [{" ".join(f"{5 + i * 2} 0 R" for i in range(len(rows)))}] /Count {len(rows)} >>'.encode(),
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>']
    def text(value, x, y, size=12, bold=False):
        escaped = value.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
        return f'BT /F{2 if bold else 1} {size} Tf {x} {y} Td ({escaped}) Tj ET\n'
    for index, row in enumerate(rows):
        content = '0.12 0.23 0.26 rg\n'
        content += text('WANYU / FICTIONAL PRACTICE', 48, 784, 12, True)
        content += text(f'Review Bundle - source page {index + 1}', 48, 740, 24, True)
        content += text('Synthetic material for workflow training only.', 48, 710, 13)
        content += text('No real dialect facts, people or source records.', 48, 688, 13)
        content += '0.85 0.89 0.88 RG 48 660 m 547 660 l S\n'
        content += text('Entry: ' + row['entry_id'], 48, 630, 13, True)
        for number, key in enumerate(('headword', 'reading', 'note')):
            content += text(key, 48, 572 - number * 94, 12, True)
            content += text(row['fields'][key], 48, 544 - number * 94, 16)
        content += text('Review each field independently against this page.', 48, 220, 12)
        content += text('This page is source text, not a rights or approval record.', 48, 198, 12)
        content += '0.85 0.89 0.88 RG 48 100 m 547 100 l S\n'
        content += text('PRACTICE ONLY / NOT EXTERNAL ACCEPTANCE', 48, 78, 10, True)
        content += text(f'{index + 1} / {len(rows)}', 510, 78, 10)
        stream = content.encode('ascii')
        objects.extend([
            f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {6 + index * 2} 0 R >>'.encode(),
            f'<< /Length {len(stream)} >>\nstream\n'.encode() + stream + b'endstream'])
    result = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n')
    xref = len(result)
    result.extend(f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode())
    result.extend(''.join(f'{offset:010d} 00000 n \n' for offset in offsets[1:]).encode())
    result.extend(f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    return bytes(result)


def main():
    rows = [{'entry_id': f'practice-{index:03}', 'fields': {
        'page': str(index), 'headword': 'Practice ' + letter, 'reading': f'pa{index}',
        'note': f'Fictional training item {letter}.'}} for index, letter in enumerate('ABC', 1)]
    entries = ''.join(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n' for row in rows).encode('utf-8')
    manifest = {'bundle': {'bundle_id': 'rb-wanyu-fictional-practice-v1', 'schema_version': 'ReviewBundle/v0',
                           'created_at': '2026-11-09T00:00:00Z'},
                'source_system': 'wanyu-practice', 'source_id': 'fictional-training-only', 'source_version': 'practice-v1',
                'requested_fields': ['page', 'headword', 'reading', 'note'],
                'rights_ref': 'practice-wanyu-reviewbundle-v1', 'operator': 'synthetic-practice-generator',
                'files': [{'path': 'entries.jsonl', 'sha256': hashlib.sha256(entries).hexdigest(), 'lines': 3, 'bytes': len(entries)}]}
    files = {'manifest.json': encoded(manifest), 'entries.jsonl': entries,
             'source.pdf': source_pdf(rows), 'README.txt': (MATERIAL / 'README.txt').read_bytes()}
    destination = ROOT / 'review-bundle-practice-v1.zip'
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, data in files.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 9, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    archive_bytes = buffer.getvalue()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='verify generated files without changing them')
    if parser.parse_args().check:
        for name, data in files.items():
            assert (MATERIAL / name).read_bytes() == data, f'stale practice file: {name}'
        assert destination.read_bytes() == archive_bytes, 'stale practice ZIP; regenerate it'
    else:
        for name, data in files.items():
            (MATERIAL / name).write_bytes(data)
        destination.write_bytes(archive_bytes)
    print(f'{destination.name}: {len(archive_bytes)} bytes; sha256 {hashlib.sha256(archive_bytes).hexdigest()}')


if __name__ == '__main__':
    main()
