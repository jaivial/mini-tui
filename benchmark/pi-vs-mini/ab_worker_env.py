#!/usr/bin/env python3
"""Interleaved worker-only A/B for one non-secret environment setting.

Example:
  python3 ab_worker_env.py --env MINI_AGENT_STRICT_CLOSURE=1 --reps 2 \
    t4_refactor t5_script_csv t6_readme_summary t7_regex_cli

Baseline and treatment use the same binary, model, provider and task copies. Arm order alternates
by task/repetition. This is a fast treatment filter, NOT the final pi comparison or pass-rate gate.
"""
import argparse
import hashlib
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

import run_worker_direct as worker


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", required=True, help="KEY=VALUE; treatment only (not a credential)")
    parser.add_argument("--reps", type=int, default=2)
    parser.add_argument("tasks", nargs="+")
    args = parser.parse_args()
    key, value = args.env.split("=", 1)
    upper = key.upper()
    if upper in ("API_KEY", "TOKEN", "SECRET", "PASSWORD") or upper.endswith(("_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD")):
        raise SystemExit("refusing to record a credential-looking environment setting")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    run_dir = Path(worker.rb.BASE) / "runs" / f"worker-ab-{stamp}"
    run_dir.mkdir()
    binary = Path(worker.BIN)
    repo = Path(worker.rb.BASE).parents[1]
    common = {"MINI_AGENT_THINKING": "adaptive", "MINI_AGENT_HEDGE_S": "12"}
    if os.environ.get("MINI_AGENT_VERIFIER_FAST_CLOSE"):
        common["MINI_AGENT_VERIFIER_FAST_CLOSE"] = os.environ["MINI_AGENT_VERIFIER_FAST_CLOSE"]
    methodology = {
        "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": worker.MODEL, "tasks": args.tasks, "reps": args.reps,
        "treatment_env": args.env, "common_env": common,
        "agent_binary": str(binary), "agent_binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "repo_head": subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip(),
        "note": "worker-only treatment filter; not a complete mini-vs-pi campaign",
    }
    (run_dir / "methodology.json").write_text(json.dumps(methodology, indent=2) + "\n")
    rows = []
    for rep in range(1, args.reps + 1):
        for index, task in enumerate(args.tasks):
            arms = ["baseline", "treatment"] if (rep + index) % 2 else ["treatment", "baseline"]
            for arm in arms:
                extra = dict(common)
                if arm == "treatment":
                    extra[key] = value
                print(f"[{time.strftime('%H:%M:%S')}] {task} rep {rep} {arm}", flush=True)
                try:
                    row = worker.run(task, str(run_dir), f".{arm}.r{rep}", extra)
                except Exception as exc:
                    row = {"task": task, "wall": 0, "verify": "FAIL", "status": f"invalid: {exc}"}
                row.update({"arm": arm, "rep": rep})
                rows.append(row)
                (run_dir / "summary.json").write_text(json.dumps(rows, indent=2) + "\n")
                print(f"  {row['wall']}s {row['verify']} turns={row.get('turns')}", flush=True)

    grouped = {}
    for row in rows:
        grouped.setdefault(row["task"], {}).setdefault(row["arm"], []).append(row)
    aggregates = {}
    lines = ["| task | baseline med s | treatment med s | baseline/treatment | baseline PASS | treatment PASS |",
             "|---|---:|---:|---:|---:|---:|"]
    for task in args.tasks:
        arms = grouped[task]
        result = {}
        for arm in ("baseline", "treatment"):
            xs = arms[arm]
            result[arm] = {"median_s": statistics.median(r["wall"] for r in xs),
                           "pass": sum(r["verify"] == "PASS" for r in xs), "runs": len(xs)}
        result["speedup"] = result["baseline"]["median_s"] / result["treatment"]["median_s"]
        aggregates[task] = result
        lines.append(f"| {task} | {result['baseline']['median_s']:.1f} | {result['treatment']['median_s']:.1f} | {result['speedup']:.2f}x | {result['baseline']['pass']}/{result['baseline']['runs']} | {result['treatment']['pass']}/{result['treatment']['runs']} |")
    base_sum = sum(v["baseline"]["median_s"] for v in aggregates.values())
    treatment_sum = sum(v["treatment"]["median_s"] for v in aggregates.values())
    total = {"baseline_sum_medians_s": base_sum, "treatment_sum_medians_s": treatment_sum,
             "speedup": base_sum / treatment_sum,
             "baseline_pass": sum(r["verify"] == "PASS" for r in rows if r["arm"] == "baseline"),
             "treatment_pass": sum(r["verify"] == "PASS" for r in rows if r["arm"] == "treatment"),
             "runs_per_arm": len(rows) // 2}
    report = {"aggregate": total, "tasks": aggregates}
    (run_dir / "analysis.json").write_text(json.dumps(report, indent=2) + "\n")
    lines += ["", f"Sum of medians: baseline {base_sum:.1f}s, treatment {treatment_sum:.1f}s, "
              f"baseline/treatment {total['speedup']:.2f}x; PASS "
              f"{total['baseline_pass']}/{total['runs_per_arm']} vs {total['treatment_pass']}/{total['runs_per_arm']}.", ""]
    (run_dir / "REPORT.md").write_text("\n".join(lines))
    print("\n".join(lines))
    print(f"run dir: {run_dir}")


if __name__ == "__main__":
    main()
