#!/usr/bin/env python3
"""Reproduce the local OCR runtime smoke benchmark using generated PDFs only.

Needs Docker, pdftoppm, reportlab, fonttools and brotli. No controlled corpus is
read. Uses the repository's OFL/Apache fixture fonts, not system private fonts.
Results are engineering samples, never a substitute for double-checked corpus
acceptance. Every score.py metric is preserved, including null denominators.
"""
import argparse
import csv
from contextlib import contextmanager
import hashlib
import importlib.util
import json
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from fontTools.ttLib import TTFont as Font
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics, ttfonts
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parents[1]
TOKEN = 'synthetic-ocr-token-at-least-32-chars'
PAGES = [
    ['ALPHA 123', 'BETA 456', 'GAMMA 789', 'DELTA 012'],
    ['ONE TWO THREE', 'FOUR FIVE SIX', 'SEVEN EIGHT NINE'],
    ['IPA ɑɡ', 'COMBINING a\u0301', 'RARE 𠮷'],
    [''],
]

def run(*args):
    return subprocess.check_output(args, text=True).strip()


def convert_font(source, target, family):
    font = Font(source)
    font.flavor = None
    if 'glyf' in font:
        font.save(target)
        return
    glyphs = font.getGlyphSet()
    builder = FontBuilder(font['head'].unitsPerEm, isTTF=True)
    order = font.getGlyphOrder()
    builder.setupGlyphOrder(order)
    outlines = {}
    for name in order:
        pen = TTGlyphPen(glyphs)
        glyphs[name].draw(Cu2QuPen(pen, 1.0, reverse_direction=True))
        outlines[name] = pen.glyph()
    builder.setupGlyf(outlines)
    builder.setupHorizontalMetrics(font['hmtx'].metrics)
    builder.setupHorizontalHeader(ascent=font['hhea'].ascent, descent=font['hhea'].descent)
    builder.setupCharacterMap(font.getBestCmap())
    builder.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family, 'fullName': family, 'psName': family})
    builder.setupOS2(sTypoAscender=font['hhea'].ascent, sTypoDescender=font['hhea'].descent, usWinAscent=max(0, font['hhea'].ascent), usWinDescent=max(0, -font['hhea'].descent))
    builder.setupPost()
    builder.save(target)


def install_utf16_cmap():
    # ReportLab's stock formatter uses %04X even for supplementary code points,
    # producing an invalid odd-length <20BB7> mapping. This fixture-only builder
    # emits PDF's required UTF-16BE surrogate pair, so OCR is not scored against
    # a malformed source text layer. No recognition output is patched.
    def cmap(fontname, subset):
        lines = ["/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
                 "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
                 "/CMapName /WanyuSyntheticUnicode def", "/CMapType 2 def",
                 "1 begincodespacerange", "<00> <FF>", "endcodespacerange",
                 str(len(subset)) + " beginbfchar"]
        lines.extend('<%02X> <%s>' % (index, chr(point).encode('utf-16-be').hex().upper())
                     for index, point in enumerate(subset))
        return '\n'.join([*lines, "endbfchar", "endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"])
    ttfonts.makeToUnicodeCMap = cmap


def make_fixtures(directory):
    phonetic = ROOT / 'frontend/public/fonts/phonetic'
    manifest = json.loads((phonetic / 'manifest.json').read_text())
    rare = ROOT / 'frontend/public/fonts/rare-han/rare-20a00-d0149614dc76.woff2'
    convert_font(phonetic / manifest['file'], directory / 'phonetic.ttf', 'WanyuSyntheticPhonetic')
    convert_font(rare, directory / 'rare.ttf', 'WanyuSyntheticRare')
    fonts = [('FixtureLatin', ROOT / 'frontend/public/pdfjs/standard_fonts/LiberationSans-Regular.ttf'), ('FixturePhonetic', directory / 'phonetic.ttf'), ('FixtureRare', directory / 'rare.ttf')]
    maps = []
    for name, file in fonts:
        pdfmetrics.registerFont(TTFont(name, str(file)))
        maps.append((name, set(Font(file).getBestCmap())))
    install_utf16_cmap()
    native = directory / 'native.pdf'
    pdf = canvas.Canvas(str(native), pagesize=(595, 842), invariant=1)
    for lines in PAGES:
        for number, text in enumerate(lines):
            x, y = 54, 760 - number * 52
            for char in text:
                family = next((name for name, points in maps if ord(char) in points), None)
                if not family:
                    raise ValueError('Fixture font does not cover ' + repr(char))
                pdf.setFont(family, 24)
                pdf.drawString(x, y, char)
                x += pdfmetrics.stringWidth(char, family, 24)
        pdf.showPage()
    pdf.save()
    subprocess.run(['pdftoppm', '-scale-to', '2200', '-png', str(native), str(directory / 'page')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    scanned = canvas.Canvas(str(directory / 'scanned.pdf'), pagesize=(595, 842), invariant=1)
    for image in sorted(directory.glob('page-*.png')):
        scanned.drawImage(ImageReader(str(image)), 0, 0, width=595, height=842)
        scanned.showPage()
    scanned.save()
    # A native title must never disguise a scanned body as extractable text.
    mixed = canvas.Canvas(str(directory / 'mixed-native-title-plus-scan-image.pdf'), pagesize=(595, 842), invariant=1)
    mixed.drawImage(ImageReader(str(directory / 'page-3.png')), 0, 0, width=595, height=842)
    mixed.setFont('FixtureLatin', 18)
    mixed.drawString(54, 810, 'NATIVE TITLE ABOVE SCANNED BODY')
    mixed.save()
    if subprocess.check_output(['pdftotext', str(directory / 'scanned.pdf'), '-']).strip():
        raise AssertionError('Scanned fixture unexpectedly has a text layer')
    return {'native': native, 'scanned': directory / 'scanned.pdf', 'mixed': directory / 'mixed-native-title-plus-scan-image.pdf'}, fonts


def write_csv(path, rows):
    with path.open('w', encoding='utf-8-sig', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=['原文'], lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)


@contextmanager
def worker(image, experimental):
    arguments = ['docker', 'run', '-d', '--rm', '--read-only', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--cpus', '1', '--memory', '768m', '--pids-limit', '64', '-e', 'OCR_WORKER_TOKEN=' + TOKEN, '-p', '127.0.0.1::8091']
    if experimental:
        arguments.extend(['-e', 'OCR_ALLOW_SCANNED_TEST=1'])
    container = run(*arguments, image)
    try:
        port = run('docker', 'port', container, '8091/tcp').rsplit(':', 1)[1]
        base = 'http://127.0.0.1:' + port
        for _ in range(100):
            try:
                with urllib.request.urlopen(base + '/healthz', timeout=1):
                    break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('Disposable OCR worker did not start')
        yield container, base
    finally:
        subprocess.run(['docker', 'rm', '-f', container], check=True, stdout=subprocess.DEVNULL)


def recognize(base, file, page=1):
    request = urllib.request.Request(base + f'/v1/recognize?page={page}&language=chi_sim%2Beng', file.read_bytes(), {'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/pdf'})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.status, json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default='wanyu-ocr-validation:local')
    parser.add_argument('--output', type=Path, default=ROOT / 'docs/evidence/issue-122-310')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    specification = importlib.util.spec_from_file_location('ocr_score', ROOT / 'ocr/score.py')
    scorer = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(scorer)
    with tempfile.TemporaryDirectory(prefix='wanyu-ocr-benchmark-') as temporary:
        directory = Path(temporary)
        files, fonts = make_fixtures(directory)
        for kind, file in files.items():
            (output / file.name).write_bytes(file.read_bytes())
        # Keep small, inspectable render evidence; scanned PDF is the same pixels
        # without a text layer, not a synthetic mocked recognition response.
        (output / 'synthetic-page-preview.png').write_bytes((directory / 'page-3.png').read_bytes())
        # Prove the production default separately from the explicit offline
        # experiment. An unsupported scan must fail closed, never be published.
        with worker(args.image, False) as (_, base):
            native_status, native_result = recognize(base, files['native'])
            if native_status != 200 or native_result['engine'] != 'poppler_text':
                raise AssertionError('Production native text path failed')
            try:
                recognize(base, files['scanned'])
            except urllib.error.HTTPError as error:
                if error.code != 422:
                    raise
                scan_rejection = error.read().decode()
            else:
                raise AssertionError('Production worker accepted an unqualified scan')
            try:
                recognize(base, files['mixed'])
            except urllib.error.HTTPError as error:
                if error.code != 422:
                    raise
                mixed_rejection = error.read().decode()
            else:
                raise AssertionError('Production worker silently accepted only a mixed page title')
            production_probe = {'nativeStatus': native_status, 'nativeEngine': native_result['engine'], 'scannedStatus': 422, 'scannedError': scan_rejection, 'mixedStatus': 422, 'mixedError': mixed_rejection}
        with worker(args.image, True) as (container, base):
            try:
                recognize(base, files['mixed'])
            except urllib.error.HTTPError as error:
                if error.code != 422:
                    raise
            else:
                raise AssertionError('Experimental mode accepted an ambiguous mixed page')
            production_probe['experimentalMixedStatus'] = 422
            records = []
            for kind, file in files.items():
                if kind == 'mixed':
                    continue
                gold, actual = [], []
                started_book = time.monotonic()
                for page, lines in enumerate(PAGES, 1):
                    started = time.monotonic()
                    try:
                        _, result = recognize(base, file, page)
                        elapsed = time.monotonic() - started
                        (output / f'{kind}-page-{page}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
                        rows = [{cell['field']: cell['text'] for cell in row['cells']} for row in result['rows']]
                        actual.extend(rows)
                        records.append({'kind': kind, 'page': page, 'httpStatus': 200, 'seconds': elapsed, 'engine': result['engine'], 'workerDurationMs': result['duration_ms'], 'statuses': [cell['status'] for row in result['rows'] for cell in row['cells']]})
                    except urllib.error.HTTPError as error:
                        records.append({'kind': kind, 'page': page, 'httpStatus': error.code, 'seconds': time.monotonic() - started, 'error': error.read().decode()})
                    gold.extend({'原文': line} for line in lines)
                write_csv(output / f'{kind}-gold.csv', gold)
                write_csv(output / f'{kind}-output.csv', actual)
                errors = []
                for row_index, (gold_row, actual_row) in enumerate(zip(gold, actual), 1):
                    expected, observed = gold_row['原文'], actual_row.get('原文', '')
                    for gi, ti in enumerate(scorer.align_positions(expected, observed)):
                        if scorer.is_hard_char(expected[gi]) and (ti is None or expected[gi] != observed[ti]):
                            errors.append({'row': row_index, 'expected': expected[gi], 'expectedCodePoint': f'U+{ord(expected[gi]):04X}', 'actual': None if ti is None else observed[ti], 'actualCodePoint': None if ti is None else f'U+{ord(observed[ti]):04X}', 'gold': expected, 'output': observed})
                (output / f'{kind}-hard-character-errors.json').write_text(json.dumps(errors, ensure_ascii=False, indent=2) + '\n')
                metrics = scorer.score(gold, actual, ['原文'])
                metrics['书级总耗时秒'] = time.monotonic() - started_book
                metrics['页数'] = len(PAGES)
                (output / f'{kind}-score.json').write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + '\n')
                scored = subprocess.check_output([sys.executable, str(ROOT / 'ocr/score.py'), '--gold', str(output / f'{kind}-gold.csv'), '--test', str(output / f'{kind}-output.csv')], text=True)
                (output / f'{kind}-score.txt').write_text(scored)
            peak = run('docker', 'exec', container, 'cat', '/sys/fs/cgroup/memory.peak')
            versions = run('docker', 'exec', container, 'sh', '-c', 'pdftotext -v 2>&1; tesseract --version 2>&1; apk list --installed poppler-utils tesseract-ocr tesseract-ocr-data-eng tesseract-ocr-data-chi_sim; sha256sum /usr/share/tessdata/eng.traineddata /usr/share/tessdata/chi_sim.traineddata')
            timings = [row['seconds'] for row in records]
            summary = {'image': args.image, 'imageId': run('docker', 'image', 'inspect', args.image, '--format', '{{.Id}}'), 'generatedOnly': True, 'source': 'Original synthetic phrases; rendered with repository redistributed fonts', 'physicalFields': ['原文'], 'notDictionaryColumnAcceptance': True, 'experimentalScannedFlag': 'OCR_ALLOW_SCANNED_TEST=1', 'productionDefaultProbe': production_probe, 'pages': records, 'failureRate': sum(row['httpStatus'] != 200 for row in records) / len(records), 'elapsedSeconds': sum(timings), 'throughputPagesPerSecond': len(timings) / sum(timings), 'p50Seconds': statistics.median(timings), 'p95SecondsNearestRank': sorted(timings)[max(0, int(len(timings) * .95 + .999) - 1)], 'containerPeakMemoryBytes': int(peak), 'resourceLimits': {'cpus': 1, 'memoryMiB': 768, 'tmpfsMiB': 256, 'pids': 64}, 'versionsAndModelHashes': versions, 'fixtureSha256': {kind: hashlib.sha256(file.read_bytes()).hexdigest() for kind, file in files.items()}}
            (output / 'runtime-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps({key: summary[key] for key in ['pages', 'failureRate', 'p50Seconds', 'p95SecondsNearestRank', 'containerPeakMemoryBytes']}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
