#!/usr/bin/env python3
"""Strict frozen LB30 reporting. Reads official results; never runs a verifier."""
import argparse
import datetime as dt
import json
from pathlib import Path


def seconds(record, phase=None):
    obj = record.get(phase) or {} if phase else record
    try:
        start = dt.datetime.fromisoformat(obj['started_at'].replace('Z', '+00:00'))
        end = dt.datetime.fromisoformat(obj['finished_at'].replace('Z', '+00:00'))
        value = (end - start).total_seconds()
        return value if value >= 0 else None
    except (KeyError, AttributeError, TypeError, ValueError):
        return None


def summarize(manifest, jobs):
    expected = json.loads(manifest.read_text())['task_ids']
    if len(expected) != 30 or len(set(expected)) != 30:
        raise ValueError('Manifest must contain exactly 30 unique frozen tasks')
    by_name = {}
    for path in sorted(jobs.rglob('result.json')):
        record = json.loads(path.read_text())
        if record.get('task_name'):
            by_name.setdefault(record['task_name'], []).append((path, record))
    rows = []
    for task in expected:
        attempts = by_name.get(task) or by_name.get(task.split('/', 1)[1]) or []
        if len(attempts) != 1:
            rows.append(dict(task=task, status='missing' if not attempts else 'duplicate', attempts=len(attempts)))
            continue
        path, record = attempts[0]
        reward = (record.get('verifier_result') or {}).get('rewards', {}).get('reward')
        usage = record.get('agent_result') or {}
        observed = bool(usage.get('n_input_tokens') or usage.get('n_output_tokens'))
        exception = record.get('exception_info') or {}
        proven_agent_failure = exception.get('exception_type') in ('AgentTimeoutError', 'NonZeroAgentExitCodeError') and (record.get('agent_execution') or {}).get('started_at') is not None
        status = 'fail' if proven_agent_failure else 'error' if exception else 'pass' if reward is not None and float(reward) >= 1 and observed else 'fail' if reward is not None and observed else 'unproven'
        rows.append(dict(task=task, status=status, reward=reward, observed_usage=observed,
                         wall_seconds=seconds(record), agent_seconds=seconds(record, 'agent_execution'),
                         error_type=exception.get('exception_type'), result=str(path)))
    passes = sum(row['status'] == 'pass' for row in rows)
    complete = all(row['status'] in ('pass', 'fail', 'error', 'unproven') and row['wall_seconds'] is not None for row in rows)
    return dict(expected=30, passes=passes, strict_pass_rate=passes/30,
                complete=complete, fully_scored=all(row['status'] in ('pass', 'fail') for row in rows),
                target_quality=complete and all(row['status'] in ('pass', 'fail') for row in rows) and passes >= 21,
                all_task_wall_seconds=sum(row['wall_seconds'] for row in rows) if complete else None,
                all_task_agent_seconds=sum(row['agent_seconds'] for row in rows) if complete and all(row['agent_seconds'] is not None for row in rows) else None,
                rows=rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('manifest', type=Path)
    parser.add_argument('jobs', type=Path)
    parser.add_argument('--compare', type=Path)
    args = parser.parse_args()
    report = summarize(args.manifest, args.jobs)
    if args.compare:
        control = summarize(args.manifest, args.compare)
        comparable = report['complete'] and control['complete'] and report['fully_scored'] and control['fully_scored'] and report['all_task_agent_seconds'] is not None and control['all_task_agent_seconds'] is not None
        report['control'] = control
        report['faster_than_control'] = comparable and report['all_task_agent_seconds'] < control['all_task_agent_seconds']
        report['speedup_agent'] = control['all_task_agent_seconds']/report['all_task_agent_seconds'] if comparable and report['all_task_agent_seconds'] else None
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    main()
