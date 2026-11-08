"""Explicit acceptance gates. Missing evidence is incomplete, never a pass."""
import json
import math
from pathlib import Path

HTTP_P95 = {'claim': 800, 'submit': 800, 'arbitrate': 800, 'field_summary': 1000,
            'pdf_descriptor': 500, 'task': 500, 'admin_pages': 500, 'verification': 500}


def lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line] if path.exists() else []


def percentile(values, fraction):
    values = sorted(values)
    return values[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


def operation(rows, name, p95_limit=None, p99_limit=None):
    values = [r['duration_ms'] for r in rows if r['operation'] == name and r.get('ok', True) and 200 <= r.get('status', 200) < 300]
    p95, p99 = percentile(values, .95), percentile(values, .99)
    status = 'incomplete' if not values else 'fail' if ((p95_limit is not None and p95 > p95_limit) or
                 (p99_limit is not None and p99 > p99_limit)) else 'pass'
    return {'operation': name, 'samples': len(values), 'p50_ms': percentile(values, .5),
            'p95_ms': p95, 'p99_ms': p99, 'p95_limit_ms': p95_limit, 'p99_limit_ms': p99_limit, 'status': status}


def summarize(output, config, reconciliation, returncodes):
    output = Path(output)
    http = lines(output / 'requests.jsonl') + lines(output / 'browser-http.jsonl')
    browser = lines(output / 'browser.jsonl')
    if config['profile'] == 'full':
        http = [r for r in http if r['phase'] == 'steady']
        browser = [r for r in browser if r['phase'] == 'steady']
    gates = []
    operations = [operation(http, name, limit, 2000 if name in ('claim', 'submit', 'arbitrate') else None)
                  for name, limit in HTTP_P95.items()]
    gates.extend({'gate': item['operation'], 'status': item['status']} for item in operations)
    failures = sum(r.get('status', 0) == 0 or r.get('status', 0) >= 500 for r in http)
    rate = failures / len(http) if http else None
    gates.append({'gate': 'unexpected_http_responses', 'status': 'fail' if any(not r.get('ok',False) for r in http) else 'pass'})
    gates.append({'gate': 'unexpected_5xx_timeout_rate', 'status': 'incomplete' if rate is None else 'pass' if rate <= .001 else 'fail', 'actual': rate, 'limit': .001})
    source = []
    for cache, limit in [('cold_browser', 3000), ('hot_browser', 1000), ('unknown', None)]:
        group = [r for r in browser if r.get('cache_state') == cache]
        value = operation(group, 'source_visible', limit)
        value['cache_state'] = cache
        source.append(value)
        if cache != 'unknown' and config['profile'] == 'full':
            gates.append({'gate': 'source_visible_' + cache, 'status': value['status']})
    # Smoke must still render an actual page for both browser actors; it does not
    # promote unknown caching into a hot-cache latency certificate.
    actors = lines(output / 'browser-actors.jsonl')
    gates.append({'gate': 'two_ui_actors_submit', 'status': 'pass' if len(actors) == 2 and all(r['successful_ui_submissions'] > 0 for r in actors) else 'fail'})
    gates.append({'gate': 'two_ui_actors_read_source', 'status': 'pass' if len({r['vu'] for r in browser if r['operation'] == 'source_visible'}) == 2 else 'fail'})
    ack = operation(browser, 'submit_ack', 800)
    gates.append({'gate': 'submit_ack', 'status': ack['status']})
    latest = {}
    for value in lines(output / 'vitals.jsonl'):
        latest[(value['vu'], value['id'], value['name'])] = value['value']
    vitals = []
    for name, limit in [('LCP', 2500), ('INP', 200), ('CLS', .1)]:
        values = [v for (_, _, metric), v in latest.items() if metric == name]
        p95 = percentile(values, .95)
        result = {'name': name, 'samples': len(values), 'p95': p95, 'limit': limit,
                  'status': 'incomplete' if p95 is None else 'pass' if p95 <= limit else 'fail'}
        vitals.append(result)
        gates.append({'gate': name, 'status': result['status']})
    background = json.loads((output / 'background.json').read_text()) if (output / 'background.json').exists() else {}
    for name in ('csv', 'slow_export'):
        gates.append({'gate': name, 'status': background.get(name, {}).get('status', 'incomplete')})
    gates.append({'gate': 'reconciliation', 'status': 'pass' if reconciliation.get('pass') else 'fail'})
    generators = []
    for filename in ('summary.json', 'browser-generator.json'):
        data = json.loads((output / filename).read_text()) if (output / filename).exists() else {}
        generators.append({'kind': filename, 'event_loop_p95_ms': data.get('generator_event_loop_p95_ms'),
                           'cpu_percent_one_core': data.get('generator_cpu_percent_one_core'), 'errors': data.get('errors', [])})
    saturated = any(g['event_loop_p95_ms'] is not None and g['event_loop_p95_ms'] > 20 for g in generators)
    missing = any(g['event_loop_p95_ms'] is None for g in generators)
    gates.append({'gate': 'generators_exited', 'status': 'pass' if all(code == 0 for code in returncodes) else 'fail'})
    gates.append({'gate': 'browser_errors', 'status': 'fail' if any(g['errors'] for g in generators) else 'pass'})
    status = 'invalid_generator' if saturated or missing else 'fail' if any(g['status'] == 'fail' for g in gates) else 'incomplete' if any(g['status'] != 'pass' for g in gates) else 'pass'
    return {'status': status, 'profile': config['profile'], 'threshold_scope': 'steady phase only' if config['profile'] == 'full' else 'accelerated smoke phases',
            'gates': gates, 'http': operations, 'expected_conflicts': {name: sum(r['operation']==name and r.get('status')==409 and r.get('ok') for r in http) for name in {r['operation'] for r in http}}, 'http_samples': len(http), 'source_visible': source,
            'editor_ready_report_only': operation(browser, 'editor_ready'), 'submit_ack': ack,
            'web_vitals': vitals, 'generators': generators, 'background': background,
            'cache_note': 'Cold/hot identify evidenced browser resource-cache state only. Unknown requests are reported and cannot satisfy the hot/cold full gates.'}
