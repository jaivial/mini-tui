#!/usr/bin/env python3
"""Compare a local sweep against the published FrontierHarness data.

Answers the questions the raw pass rate cannot: which failures are ours, which are the
field's, which contested tasks we win, and what a pass actually costs in time, tokens
and turns.

Only *valid* cells are ever compared. A trial with no verifier result, no usage or a
crashed agent is infra-invalid and is reported as such instead of being folded into the
pass rate -- the same rule frontier_score.py enforces.

Usage:
    python3 analyze-sweep.py jobs/<run-id> [...] [--label mini] [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from frontier_score import classify, iter_trials  # noqa: E402

ROOT = Path(__file__).resolve().parent
PUBLISHED = ROOT / "results" / "eval-data.json"
BENCH = ROOT / "benchmark.json"
_FMT = "%Y-%m-%dT%H:%M:%S.%fZ"


def load_published() -> dict[str, dict]:
    """Return {task_id: {harness: success}} over the published evaluations."""
    data = json.loads(PUBLISHED.read_text())
    table: dict[str, dict[str, bool]] = defaultdict(dict)
    for harness in data["harnesses"]:
        for task in harness.get("task_details", []):
            table[task["id"]][harness["name"]] = bool(task.get("success"))
    return dict(table)


def trial_stats(record: dict) -> dict:
    agent = record.get("agent_result") or {}
    out = {
        "input_tokens": agent.get("n_input_tokens") or record.get("input_tokens") or 0,
        "output_tokens": agent.get("n_output_tokens") or record.get("output_tokens") or 0,
        "cache_tokens": agent.get("n_cache_tokens") or 0,
        "cost_usd": agent.get("cost_usd") or 0.0,
        "turns": agent.get("num_turns") or agent.get("turns") or 0,
        "seconds": None,
    }
    start, end = record.get("started_at"), record.get("finished_at")
    if start and end:
        try:
            out["seconds"] = (
                datetime.strptime(end, _FMT) - datetime.strptime(start, _FMT)
            ).total_seconds()
        except ValueError:
            pass
    return out


def collect(jobs_dir: Path) -> dict[str, dict]:
    """Canonical selection: earliest valid attempt per task, mirroring the harness."""
    chosen: dict[str, dict] = {}
    for name, record in iter_trials(jobs_dir):
        state, ok = classify(record)
        entry = {"state": state, "success": ok, "stats": trial_stats(record), "raw": record}
        # Canonical selection: keep the earliest valid attempt, else the first seen.
        previous = chosen.get(name)
        if previous is not None and previous["state"] == "valid":
            continue
        if previous is not None and state != "valid":
            continue
        chosen[name] = entry
    return chosen


def task_class(task_id: str, published: dict) -> tuple[str, str]:
    """Classify a task as universal (everyone passes) or contested, with the field rate."""
    outcomes = published.get(task_id, {})
    if not outcomes:
        return "unknown", "-"
    n_pass = sum(outcomes.values())
    rate = n_pass / len(outcomes)
    if rate >= 0.999:
        return "universal", f"{n_pass}/{len(outcomes)}"
    if rate <= 0.001:
        return "solved-by-nobody", f"{n_pass}/{len(outcomes)}"
    return "contested", f"{n_pass}/{len(outcomes)}"


def failure_reason(trial_dir: Path) -> str:
    """Summarize *why* a trial failed, from the verifier's own test output.

    Distinguishes a capability failure (assertions failed) from a broken environment,
    which decides whether a lost task is worth chasing at all.
    """
    out = trial_dir / "verifier" / "test-stdout.txt"
    if not out.is_file():
        return ""
    try:
        text = out.read_text(errors="replace")
    except OSError:
        return ""
    counts = re.findall(r"(\d+) failed, (\d+) passed", text)
    failed = [m for m in re.findall(r"^FAILED \S+?::(\w+)", text, re.M)]
    if counts:
        n_failed, n_passed = counts[-1]
        detail = f"{n_failed} failed / {n_passed} passed"
        if failed:
            detail += f"; first={failed[0]}"
        return detail
    if re.search(r"^ERROR ", text, re.M):
        return "verifier error (environment or collection failure)"
    return ""


def trial_dir_for(jobs_dir: Path, task_name: str) -> Path | None:
    # Trial dirs are named <task>__<hash>; task ids themselves never contain '__'.
    pattern = f"{task_name}__*"
    for candidate in sorted(jobs_dir.glob(f"*/*/{pattern}")) + sorted(jobs_dir.glob(f"*/{pattern}")):
        if (candidate / "result.json").is_file():
            return candidate
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs_dirs", nargs="+", type=Path)
    ap.add_argument("--label", default="arm")
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()

    published = load_published()
    expected = json.loads(BENCH.read_text())["task_ids"]

    per_arm = {d: collect(d) for d in args.jobs_dirs}
    label = args.label

    print(f"# FrontierHarness sweep: {label}")
    print()
    print(
        f"{'task':52} {'field':>9}  {'class':16} {'result':7} {'min':>6} "
        f"{'turns':>5} {'in_tok':>9} {'out_tok':>8} {'usd':>7}"
    )
    print("-" * 122)

    rows = []
    for task_id in expected:
        bucket, field = task_class(task_id, published)
        entry = per_arm[args.jobs_dirs[0]].get(task_id.split("/", 1)[1]) or per_arm[
            args.jobs_dirs[0]
        ].get(task_id)
        if entry is None:
            rows.append({"task": task_id, "class": bucket, "field": field, "state": "missing"})
            print(f"{task_id:52} {field:>9}  {bucket:16} {'MISSING':7}")
            continue
        s = entry["stats"]
        mark = (
            "PASS" if entry["success"] else ("FAIL" if entry["success"] is False else entry["state"].upper())
        )
        print(
            f"{task_id:52} {field:>9}  {bucket:16} {mark:7} "
            f"{(s['seconds'] or 0) / 60:6.1f} {s['turns'] or '-':>5} "
            f"{s['input_tokens']:>9,} {s['output_tokens']:>8,} {s['cost_usd']:7.4f}"
        )
        rows.append(
            {
                "task": task_id,
                "class": bucket,
                "field": field,
                "state": entry["state"],
                "success": entry["success"],
                **s,
            }
        )

    scored = [r for r in rows if r["state"] == "valid"]
    passes = [r for r in scored if r["success"]]
    invalid = [r for r in rows if r["state"] not in ("valid", "missing")]

    print()
    print(f"valid cells       {len(scored)}/{len(expected)}")
    print(f"passed            {len(passes)}/{len(expected)}")
    if scored:
        print(f"pass_rate         {len(passes) / len(scored) * 100:.1f}%  (over valid cells)")
        print(f"success/expected  {len(passes) / len(expected) * 100:.1f}%  (strict)")
    if invalid:
        print(f"infra-invalid     {len(invalid)}: {', '.join(r['task'].split('/')[-1] for r in invalid)}")

    # Where the remaining headroom is.
    print()
    print("## headroom")
    for bucket in ("contested", "universal", "solved-by-nobody"):
        group = [r for r in rows if r["class"] == bucket and r["state"] == "valid"]
        if not group:
            continue
        got = sum(1 for r in group if r["success"])
        label_txt = f"{bucket} ({len(group)} scored)"
        print(f"  {label_txt:34} {got}/{len(group)}")

    lost_contested = [
        r for r in rows if r["class"] == "contested" and r["state"] == "valid" and not r["success"]
    ]
    if lost_contested:
        print("  contested tasks we lose:")
        for r in lost_contested:
            print(f"    - {r['task']} (field {r['field']})")

    print()
    print("## failure reasons (valid cells that failed)")
    jobs_root = args.jobs_dirs[0]
    for r in rows:
        if r["state"] == "valid" and r["success"] is False:
            bare = r["task"].split("/")[-1]
            td = trial_dir_for(jobs_root, bare)
            reason = failure_reason(td) if td else ""
            print(f"  {bare:36} {reason or 'no verifier output'}")

    # Efficiency per proven pass, never over a partial matrix.
    print()
    print("## cost per proven pass")
    if passes:
        cost = sum(r["cost_usd"] for r in passes)
        secs = [r["seconds"] for r in passes if r["seconds"]]
        turns = [r["turns"] for r in passes if r["turns"]]
        print(f"  passes                {len(passes)}")
        print(f"  cost per pass         ${cost / len(passes):.4f}  (total ${cost:.4f})")
        print(f"  output tokens / pass  {sum(r['output_tokens'] for r in passes) / len(passes):,.0f}")
        if secs:
            print(f"  median min / pass     {sorted(secs)[len(secs) // 2] / 60:.1f}")
        if turns:
            print(f"  mean turns / pass     {sum(turns) / len(turns):.1f}")

    if args.json:
        args.json.write_text(
            json.dumps({"label": label, "rows": rows, "scored": len(scored), "passes": len(passes)}, indent=2)
        )
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())