#!/usr/bin/env python3
"""Exercise real migrations/routes with a controlled local worker, never material APIs."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import harness

SECRET = 'synthetic-ocr-token-at-least-32-chars'

class Worker(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        from urllib.parse import parse_qs, urlparse
        if self.headers.get('Authorization') != 'Bearer ' + SECRET:
            self.send_error(401)
            return
        # Drain chunked Go upload as well as a known Content-Length.
        if self.headers.get('Transfer-Encoding') == 'chunked':
            while True:
                size = int(self.rfile.readline().strip(), 16)
                if not size:
                    self.rfile.readline()
                    break
                self.rfile.read(size)
                self.rfile.read(2)
        else:
            self.rfile.read(int(self.headers.get('Content-Length', 0)))
        page = int(parse_qs(urlparse(self.path).query)['page'][0])
        # Page 2 stays busy long enough for an unrelated CSV to finish.
        time.sleep(2 if page == 2 else .1)
        if page == 3:
            self.send_error(502, 'synthetic worker crash')
            return
        texts = ['  𠀀 \ue123 ⿰木木 ɕ˥', 'decode �'] if page == 1 else ['second page']
        rows = [{'cells': [{'field': '原文', 'text': text, 'status': 'abstained' if '�' in text else 'needs_review', 'confidence': None, 'bbox': [1, 2, 30, 12], 'source': 'tesseract' if page == 4 else 'pdf_text'}]} for text in texts]
        result = {'page': page, 'engine': 'controlled_contract_fixture', 'rows': rows, 'raw_text': '\n'.join(texts), 'raw_layout': '<controlled-layout />', 'duration_ms': 1}
        data = json.dumps(result, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    worker = ThreadingHTTPServer(('127.0.0.1', 0), Worker)
    threading.Thread(target=worker.serve_forever, daemon=True).start()
    try:
        with harness.temporary_root() as root:
            binary = harness.build_binary(Path(root) / 'pocketbase')
            extra = {'OCR_ENGINE_ENABLED': 'true', 'OCR_WORKER_TOKEN': SECRET, 'OCR_WORKER_URL': f'http://127.0.0.1:{worker.server_port}', 'OCR_RECOVERY_STATE': str(Path(root) / 'checkpoint.json')}
            with harness.server(binary, root, extra_env=extra) as env:
                harness.run_suite('ocr_runtime_integration.mjs', env)
            with harness.server(binary, root, extra_env={**extra, 'OCR_RECOVERY_PHASE': 'assert'}) as env:
                harness.run_suite('ocr_runtime_integration.mjs', env)
    finally:
        worker.shutdown()
        worker.server_close()

if __name__ == '__main__':
    main()
