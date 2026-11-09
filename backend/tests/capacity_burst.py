"""One explicit simultaneous-submit workload; never changes product SLOs."""
from collections import Counter

MAX_START_SKEW_MS = 250  # Generator definition of concentrated dispatch, not API latency.


def make_submit_burst(config, enabled=False):
    """Local and remote runners call after setting generator-local start_epoch_ms."""
    if config['profile'] != 'full' and not enabled:
        return None
    participants = [{'vu': a['vu'], 'transport': a['transport']} for a in config['actors'] if a['role'] == 'proofreader']
    if config['profile'] == 'full' and (len(participants) != 24 or
            Counter(p['transport'] for p in participants) != {'http': 22, 'browser': 2}):
        raise ValueError('full burst requires 22 HTTP and 2 browser proofreaders')
    offset = 0
    for phase in config['phases']:
        if phase['name'] == 'steady':
            steady_start = config['start_epoch_ms'] + offset * 1000
            steady_ms = phase['seconds'] * 1000
            break
        offset += phase['seconds']
    else:
        raise ValueError('submit burst requires a steady phase')
    delay = 300000 if config['profile'] == 'full' else steady_ms / 2
    if not 0 < delay < steady_ms:
        raise ValueError('burst epoch must be inside steady phase')
    return {'id': 'steady-submit-1', 'at_epoch_ms': int(steady_start + delay),
            'prepare_window_ms': int(min(240000, delay)), 'max_start_skew_ms': MAX_START_SKEW_MS,
            'participants': participants}


def burst_report(config, requests, events):
    plan = config.get('submit_burst')
    if not plan:
        return {'status': 'incomplete' if config['profile'] == 'full' else 'not_requested',
                'reason': 'missing_burst_config' if config['profile'] == 'full' else 'default_smoke_unchanged'}
    errors = []
    def error(reason, **detail):
        errors.append({'reason': reason, **detail})
    try:
        expected_plan = make_submit_burst(config, True)
        if plan != expected_plan:
            error('burst_plan_mismatch')
    except (ValueError, KeyError, TypeError):
        error('invalid_burst_plan')
    participants = plan.get('participants', [])
    expected_vus = {p['vu'] for p in participants}
    if len(expected_vus) != len(participants) or not participants:
        error('invalid_burst_participants')
    transports = {p['vu']: p['transport'] for p in participants}
    ready = Counter()
    for event in events:
        if event.get('burst_id') != plan['id'] or event.get('vu') not in expected_vus:
            error('unexpected_burst_event')
            continue
        if event.get('transport') != transports[event['vu']]:
            error('participant_transport_mismatch', vu=event['vu'])
        if event.get('status') == 'missed':
            error('participant_missed', vu=event['vu'], detail=event.get('reason'))
        if event.get('status') == 'prepared':
            ready[event['vu']] += 1
            if not plan['at_epoch_ms'] - plan['prepare_window_ms'] <= event['at_ms'] < plan['at_epoch_ms']:
                error('preparation_outside_window', vu=event['vu'])
    submissions = [r for r in requests if r.get('burst_id')]
    starts = []
    counts = Counter()
    for row in submissions:
        vu = row.get('vu')
        if row.get('burst_id') != plan['id'] or vu not in expected_vus or row.get('operation') != 'submit':
            error('unexpected_burst_request')
            continue
        counts[vu] += 1
        start = row.get('started_at_ms')
        if not isinstance(start, (int, float)) or not plan['at_epoch_ms'] <= start <= plan['at_epoch_ms'] + plan['max_start_skew_ms']:
            error('request_outside_burst_epoch', vu=vu)
        else:
            starts.append(start)
        if not row.get('ok') or not 200 <= row.get('status', 0) < 300:
            error('burst_submission_not_acknowledged', vu=vu)
    for vu in sorted(expected_vus):
        if ready[vu] != 1:
            error('preparation_count', vu=vu, count=ready[vu])
        if counts[vu] != 1:
            error('submission_count', vu=vu, count=counts[vu])
    if config.get('submit_burst_test_fault') and config['profile'] == 'full':
        error('fault_in_full_profile')
    return {'status': 'fail' if errors else 'pass', 'plan': plan,
            'participants': len(expected_vus), 'prepared': sum(ready.values()), 'requests': len(submissions),
            'dispatch_span_ms': max(starts) - min(starts) if starts else None, 'errors': errors,
            'test_fault': config.get('submit_burst_test_fault'),
            'definition': 'One actual submit per participant in [epoch, epoch+250ms]; 250ms is generator coordination, not a product latency threshold.'}
