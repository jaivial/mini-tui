#!/usr/bin/env python3
"""Score a Harbor jobs dir with FrontierHarness Eval's own pass-rate rules.

The published metric is `pass_rate = passes / valid_cells`, where a cell is valid
only when the agent's outcome is *proven*: a verifier reward >= 1 plus observed model
usage is a success; a proven failure counts as valid; anything unproven (setup error,
missing verifier output, no evidence the agent ran) is infra-invalid and is NOT
scored as a task failure. `success_rate_expected` divides by all 30 frozen task ids
instead, which is the stricter number to quote when coverage is incomplete.

Usage:
    python3 frontier_score.py jobs/<run-id> [--expect 21]

Prints one row per task plus the aggregate, and exits non-zero if coverage is
incomplete so an unfinished sweep cannot be mistaken for a score.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

BENCH = Path(__file__).resolve().parent / "benchmark.json"
RESULTS = Path(__file__).resolve().parent / "results" / "eval-data.json"


def load_expected() -> list[str]:
    return json.loads(BENCH.read_text())["task_ids"]


def iter_trials(jobs_dir: Path):
    """Yield (task_id, record) for every trial in a Harbor jobs dir.

    Harbor writes one result.json per trial at <jobs>/<run>/<task>__<hash>/result.json,
    plus a job-level summary at <jobs>/<run>/result.json which must be skipped. Task
    ids are bare (no suite prefix) and may contain underscores, so the suite prefix
    is recovered by matching against benchmark.json rather than by string surgery.

    Harbor nests one extra timestamped directory under the run id that run-baseline.sh
    passes as -o (jobs/<run-id>/<timestamp>/<task>__<hash>), so the same jobs dir may
    hold trials at either depth. Both layouts are accepted. The job-level summary
    carries no task_name, so requiring one is what excludes it: falling back to the
    directory name would otherwise score the run id itself as a task.
    """
    seen: set[Path] = set()
    trial_dirs = sorted(jobs_dir.glob("*/*__*")) + sorted(jobs_dir.glob("*__*"))
    for trial_dir in trial_dirs:
        path = trial_dir / "result.json"
        if not path.is_file() or path in seen:
            continue
        seen.add(path)
        try:
            record = json.loads(path.read_text())
        except json.JSONDecodeError:
            continue
        task_name = record.get("task_name")
        if not task_name:
            continue
        yield task_name, record


def classify(record: dict) -> tuple[str, bool | None]:
    """Map a Harbor outcome onto (validity, success) per the harness's rules.

    Harbor nests the verifier score under verifier_result.rewards.reward and the
    model usage under agent_result; both must be present for the cell to count as
    *proven*. An exception with no usage is an infrastructure failure, not a task
    failure, and must never be scored as a pass-rate loss.
    """
    reward = None
    verifier = record.get("verifier_result") or {}
    rewards = verifier.get("rewards") or {}
    if "reward" in rewards:
        reward = rewards["reward"]
    elif "reward" in record:
        reward = record["reward"]

    agent = record.get("agent_result") or {}
    input_tokens = agent.get("n_input_tokens") or record.get("input_tokens") or 0
    cache_tokens = agent.get("n_cache_tokens") or 0
    output_tokens = agent.get("n_output_tokens") or record.get("output_tokens") or 0
    has_usage = bool(input_tokens or output_tokens)

    # A trial that started the agent and then timed out is a proven failure even when
    # the provider never reported usage.
    execution = record.get("agent_execution") or {}
    timed_out = bool(execution.get("timed_out")) or bool(record.get("timed_out"))
    started = execution.get("started_at") is not None

    if reward is not None and float(reward) >= 1.0 and has_usage:
        return "valid", True
    if reward is not None and float(reward) < 1.0 and has_usage:
        return "valid", False
    if timed_out and started:
        return "valid", False
    if reward is not None and not record.get("exception_info"):
        # Scored by the verifier but the agent left no usage behind: the cell cannot
        # be priced, and the harness treats unproven outcomes as invalid.
        return "infra_invalid", None
    return "infra_invalid", None


def duration_of(record: dict) -> float | None:
    start, end = record.get("started_at"), record.get("finished_at")
    if not (start and end):
        return None
    try:
        from datetime import datetime

        fmt = "%Y-%m-%dT%H:%M:%S.%fZ"
        return (datetime.strptime(end, fmt) - datetime.strptime(start, fmt)).total_seconds()
    except ValueError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs_dir", type=Path)
    ap.add_argument("--expect", type=int, default=21, help="passes needed for the 70%% target")
    args = ap.parse_args()

    expected = load_expected()
    per_task: dict[str, list[tuple[str, bool | None, float | None]]] = defaultdict(list)
    for name, record in iter_trials(args.jobs_dir):
        state, ok = classify(record)
        per_task[name].append((state, ok, duration_of(record)))

    # Canonical selection: earliest valid attempt per task, mirroring the harness.
    passes = valid = invalid = 0
    durations: list[float] = []
    rows = []
    for task_id in expected:
        bare = task_id.split("/", 1)[1]
        outcomes = per_task.get(task_id) or per_task.get(bare) or []
        chosen = next((o for o in outcomes if o[0] == "valid"), None)
        if chosen is None:
            state, ok = "missing", None
            invalid += 1
        else:
            state, ok = "scored", chosen[1]
            valid += 1
            passes += bool(ok)
            if ok and chosen[2] is not None:
                durations.append(chosen[2])
        rows.append((task_id, state, ok, len(outcomes)))

    width = max(len(r[0]) for r in rows)
    print(f"{'task'.ljust(width)}  state       result")
    for task_id, state, ok, _ in rows:
        mark = "PASS" if ok else ("FAIL" if ok is False else "-")
        print(f"{task_id.ljust(width)}  {state.ljust(11)}  {mark}")

    total = len(expected)
    print()
    print(f"passed            {passes}/{total}")
    print(f"valid cells       {valid}/{total}")
    print(f"pass_rate         {passes / valid * 100:.1f}%" if valid else "pass_rate         n/a")
    print(f"success/expected  {passes / total * 100:.1f}%  (the strict number)")
    if durations:
        durations.sort()
        mid = len(durations) // 2
        median = (
            durations[mid]
            if len(durations) % 2
            else (durations[mid - 1] + durations[mid]) / 2
        )
        print(f"median time       {median / 60:.1f} min over {len(durations)} passes")
    if RESULTS.is_file():
        published = json.loads(RESULTS.read_text())
        best = max(published["harnesses"], key=lambda h: h["pass_rate"])
        print(f"published best    {best['name']} {best['pass_rate'] * 100:.1f}%")
    need = args.expect - passes
    if need > 0:
        print(f"to reach 70%      {need} more task(s) needed")

    if invalid:
        print(
            f"\nWARNING: {invalid} task(s) unscored. An incomplete matrix is not a "
            f"pass rate; re-run those trials before quoting this number."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())