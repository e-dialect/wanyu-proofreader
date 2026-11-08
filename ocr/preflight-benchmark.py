#!/usr/bin/env python3
"""Compare native output and unsupported-page latency on checked-in synthetic PDFs.

Uses local Go and Poppler only. The baseline is a Go overlay in a temporary
directory; neither checkout nor dependencies are changed. This is an efficiency
and output-regression check, not an OCR accuracy evaluation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DRIVER = r'''
package main
import (
    "context"
    "crypto/sha256"
    "encoding/json"
    "errors"
    "fmt"
    "os"
    "sort"
    "strconv"
    "time"
    "fangji/backend/ocrengine"
)
func main() {
    samples, err := strconv.Atoi(os.Args[2])
    if err != nil || samples < 1 { panic("invalid samples") }
    times := make([]float64, 0, samples)
    var first ocrengine.Result
    var firstError string
    for i := 0; i < samples; i++ {
        started := time.Now()
        result, err := ocrengine.Recognize(context.Background(), os.Args[1], 1, "eng")
        times = append(times, float64(time.Since(started).Microseconds()) / 1000)
        if err != nil && !errors.Is(err, ocrengine.ErrScannedUnsupported) { panic(err) }
        if i == 0 { first = result; if err != nil { firstError = err.Error() } }
    }
    first.DurationMS = 0
    encoded, _ := json.Marshal(first)
    sort.Float64s(times)
    median := (times[(samples-1)/2] + times[samples/2]) / 2
    report := map[string]any{
        "samples": samples, "median_ms": median, "min_ms": times[0], "max_ms": times[samples-1],
        "error": firstError, "result_sha256": fmt.Sprintf("%x", sha256.Sum256(encoded)),
        "rows": len(first.Rows), "has_images": first.HasImages,
    }
    out, _ := json.Marshal(report)
    fmt.Println(string(out))
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='83ab4f7')
    parser.add_argument('--samples', type=int, default=20)
    parser.add_argument('--output', type=Path, default=ROOT / 'output/ocr-preflight-benchmark.json')
    args = parser.parse_args()
    if args.samples < 1:
        parser.error('--samples must be positive')
    env = dict(os.environ)
    env.pop('OCR_ALLOW_SCANNED_TEST', None)
    report = {'synthetic_only': True, 'baseline': args.base, 'platform': platform.platform(), 'fixtures': {}}
    fixtures = ROOT / 'docs/evidence/issue-122-310'
    go = env.get('GO_BINARY', 'go')
    with tempfile.TemporaryDirectory(prefix='wanyu-ocr-preflight-') as temporary:
        directory = Path(temporary)
        driver = directory / 'main.go'
        driver.write_text(DRIVER)
        old = directory / 'engine-before.go'
        old.write_bytes(subprocess.check_output(['git', 'show', f'{args.base}:backend/ocrengine/engine.go'], cwd=ROOT))
        overlay = directory / 'overlay.json'
        overlay.write_text(json.dumps({'Replace': {str(ROOT / 'backend/ocrengine/engine.go'): str(old)}}))
        for version in ['before', 'after']:
            command = [go, 'build']
            if version == 'before':
                command.append('-overlay=' + str(overlay))
            subprocess.run(command + ['-o', str(directory / version), str(driver)], cwd=ROOT / 'backend', env=env, check=True)
        for kind, name in [('native', 'native.pdf'), ('scanned', 'scanned.pdf'), ('mixed', 'mixed-native-title-plus-scan-image.pdf')]:
            pdf = fixtures / name
            item = {'sha256': hashlib.sha256(pdf.read_bytes()).hexdigest()}
            for version in ['before', 'after']:
                item[version] = json.loads(subprocess.check_output([str(directory / version), str(pdf), str(args.samples)], env=env))
            report['fixtures'][kind] = item
        native = report['fixtures']['native']
        assert native['before']['result_sha256'] == native['after']['result_sha256'], 'native evidence changed'
        for kind in ['scanned', 'mixed']:
            for version in ['before', 'after']:
                item = report['fixtures'][kind][version]
                assert item['error'].startswith('OCR_SCANNED_UNSUPPORTED') and item['rows'] == 0, 'unsupported material accepted'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
