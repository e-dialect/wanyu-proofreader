"""Optional local synthetic benchmark; not a production capacity assertion.

python3 docs/evidence/repository-audit-20261107/benchmark_storage.py
"""
import importlib.util
import json
from pathlib import Path
import statistics
import subprocess
import tempfile
import time
import tracemalloc

ROOT = Path(__file__).resolve().parents[3]


def main():
    with tempfile.TemporaryDirectory(prefix='wanyu-storage-benchmark-') as temporary:
        workspace = Path(temporary)
        baseline = workspace / 'before.py'
        baseline.write_bytes(subprocess.check_output([
            'git', 'show', '5afa6fc9156183931dce1280e2e997f4df1148b5:ops/audit_storage.py'], cwd=ROOT))
        data = workspace / 'data'
        for directory in range(100):
            folder = data / 'storage' / str(directory)
            folder.mkdir(parents=True)
            for number in range(200):
                (folder / str(number)).write_bytes(b'x' * (1 + number % 32))
        result = {'fixture': '20000 synthetic files in 100 directories', 'rounds': 3, 'metrics': {}}
        for label, source in [('before', baseline), ('after', ROOT / 'ops/audit_storage.py')]:
            spec = importlib.util.spec_from_file_location(label, source)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            durations, peaks = [], []
            for _ in range(3):
                tracemalloc.start()
                started = time.perf_counter()
                _, summary = module.audit(data, time.time(), 2 ** 30)
                durations.append(time.perf_counter() - started)
                _, peak = tracemalloc.get_traced_memory()
                tracemalloc.stop()
                peaks.append(peak)
            result['metrics'][label] = {
                'median_seconds': round(statistics.median(durations), 4),
                'peak_python_bytes': max(peaks), 'total_bytes': summary['total_bytes']}
        assert result['metrics']['before']['total_bytes'] == result['metrics']['after']['total_bytes']
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
