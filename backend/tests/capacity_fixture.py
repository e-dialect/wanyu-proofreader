"""Deterministic, synthetic-only capacity fixture helpers (no production input)."""
import hashlib
import json
import math
import os
import platform
import plistlib
import tempfile
import subprocess
import time
import urllib.request
from pathlib import Path
import field_audit_capacity as audit


def synthetic_pdf(path, pages=200, mib=20):
    # Each page contains actual uncompressed grayscale pixels, not trailing padding.
    width = 512
    height = math.ceil(mib * 1024 * 1024 / pages / width)
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               ('<< /Type /Pages /Kids [' + ' '.join(f'{4 + i * 3} 0 R' for i in range(pages)) + f'] /Count {pages} >>').encode(),
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    for i in range(pages):
        content = (f'BT /F1 20 Tf 40 780 Td (SYNTHETIC CAPACITY PAGE {i + 1:03d}) Tj '
                   '0 -30 Td (Fictional test material - no real source) Tj ET\n'
                   'q 500 0 0 180 40 500 cm /Picture Do Q\n').encode()
        pixels = hashlib.shake_256(f'wanyu-capacity-seed-1701-page-{i}'.encode()).digest(width * height)
        objects.extend([
            (f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> /XObject << /Picture {6 + i * 3} 0 R >> >> /Contents {5 + i * 3} 0 R >>').encode(),
            f'<< /Length {len(content)} >>\nstream\n'.encode() + content + b'endstream',
            f'<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length {len(pixels)} >>\nstream\n'.encode() + pixels + b'\nendstream'
        ])
    result = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f'{number} 0 obj\n'.encode() + body + b'\nendobj\n')
    xref = len(result)
    result.extend(f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode())
    result.extend(''.join(f'{offset:010d} 00000 n \n' for offset in offsets[1:]).encode())
    result.extend(f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    path.write_bytes(result)
    return {'pages': pages, 'bytes': len(result), 'sha256': hashlib.sha256(result).hexdigest(),
            'synthetic': True, 'payload': '200 separately embedded grayscale page images and visible fictional labels'}


def upload_pdf(base, project, token, path):
    boundary = 'wanyu-capacity-synthetic-pdf'
    payload = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic-capacity.pdf"\r\nContent-Type: application/pdf\r\n\r\n'.encode()
               + path.read_bytes() + f'\r\n--{boundary}--\r\n'.encode())
    req = urllib.request.Request(base + f'/api/fangji/projects/{project}/files/pdf', data=payload,
                                 headers={'Authorization': token, 'Content-Type': f'multipart/form-data; boundary={boundary}'})
    with urllib.request.urlopen(req, timeout=120) as response:
        record = json.loads(response.read())
    for _ in range(600):
        record = audit.request(base, f'/api/collections/project_files/records/{record["id"]}', token)
        if record['status'] == 'ready':
            assert record['page_count'] == 200
            return record
        if record['status'] == 'failed':
            raise RuntimeError('synthetic_pdf_validation_failed')
        time.sleep(.1)
    raise RuntimeError('synthetic_pdf_validation_timeout')


def hardware():
    cores = os.cpu_count() or 0
    memory = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') if hasattr(os, 'sysconf') else 0
    cgroup = Path('/sys/fs/cgroup')
    if (cgroup / 'cpu.max').exists():
        quota, period = (cgroup / 'cpu.max').read_text().split()
        if quota != 'max': cores = min(cores, int(quota) / int(period))
    if (cgroup / 'memory.max').exists():
        limit = (cgroup / 'memory.max').read_text().strip()
        if limit != 'max': memory = min(memory, int(limit))
    storage = {'verified': False, 'method': 'unavailable'}
    try:
        if platform.system() == 'Darwin':
            info = plistlib.loads(subprocess.check_output(['diskutil', 'info', '-plist', tempfile.gettempdir()], stderr=subprocess.DEVNULL))
            storage = {'verified': info.get('SolidState') is True, 'method': 'diskutil SolidState for temporary data filesystem'}
        elif platform.system() == 'Linux':
            device = subprocess.check_output(['findmnt', '-n', '-o', 'SOURCE', '-T', tempfile.gettempdir()], text=True).strip()
            if device.startswith('/dev/'):
                devices = json.loads(subprocess.check_output(['lsblk', '-J', '-o', 'ROTA', device], text=True))['blockdevices']
                storage = {'verified': bool(devices) and all(item.get('rota') is False for item in devices), 'method': 'findmnt temporary filesystem device and lsblk ROTA=false'}
    except (OSError, subprocess.SubprocessError, ValueError, KeyError):
        pass
    return {'platform': platform.platform(), 'effective_cpu_cores': cores, 'effective_memory_bytes': memory,
            'storage_medium_verified': storage['verified'], 'storage_evidence': storage,
            'note': 'Envelope is read from this process host/cgroup; storage passes only on a positive system-device query. No CLI flag manufactures hardware evidence.'}


def source_manifest(backend):
    files = sorted(backend.glob('tests/*capacity*'))
    return {'baseline_sha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=backend, text=True).strip(),
            'dirty_diff_sha256': hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD', '--binary'], cwd=backend)).hexdigest(),
            'source_sha256': {str(p.relative_to(backend)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.is_file()}}


def phases(duration):
    return [{'name': name, 'seconds': duration * fraction} for name, fraction in
            [('warmup', 5/60), ('ramp', 5/60), ('steady', 40/60), ('cooldown', 10/60)]]
