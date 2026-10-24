#!/usr/bin/env python3
"""Validate and summarize one run_queue_bench.py A/B campaign.

The speed gate is evaluated only alongside the pass-rate gate. Invalid infrastructure rows are
never converted into task failures or silently dropped: by default an incomplete/invalid matrix
aborts the report. Ordinary completed runs that fail verify.sh remain scored failures.
"""
from __future__ import annotations

import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any

# Editorial task-shape labels for the local ten-task corpus, not a calibrated difficulty scale.
LEVELS = {
    "t1_wordfreq": "easy · data scripting",
    "t2_grep_logs": "easy · boundary bug",
    "t3_pytest_fix": "medium · test-guided debugging",
    "t4_refactor": "hard · refactor + parser behavior",
    "t5_script_csv": "easy · CSV aggregation",
    "t6_readme_summary": "medium · log analysis",
    "t7_regex_cli": "medium · CLI implementation",
    "t8_js_bug": "hard · async race",
    "t9_pkg_resize": "easy · multi-file behavior",
    "t10_crash_report": "medium · exact report",
    "tp1_single": "easy · unitary control",
    "nx4b_wave": "hard · four foreign projects",
    "big8_wave": "hard · eight independent items",
}


def valid(row: dict[str, Any]) -> bool:
    if row.get("harness") == "pi":
        return row.get("returncode", 0) == 0 and row.get("turns", 1) > 0 and row.get("wall", 0) > 0
    return row.get("status") == "done" and row.get("wall", 0) > 0


def med(rows: list[dict[str, Any]], field: str = "wall") -> float:
    return float(statistics.median(float(r.get(field, 0)) for r in rows))


def pass_count(rows: list[dict[str, Any]]) -> int:
    return sum(r.get("verify") == "PASS" for r in rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("--allow-partial", action="store_true", help="report observed cells without claiming a complete campaign")
    args = parser.parse_args()
    run_dir = args.run_dir.resolve()
    rows = json.loads((run_dir / "summary.json").read_text())
    methodology_path = run_dir / "methodology.json"
    methodology = json.loads(methodology_path.read_text()) if methodology_path.exists() else {}
    grouped: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    invalid = []
    for row in rows:
        grouped[row["task"]][row["harness"]].append(row)
        if not valid(row):
            invalid.append({"task": row["task"], "rep": row.get("rep"), "harness": row["harness"], "status": row.get("status")})
    expected = methodology.get("tasks") or sorted(grouped)
    reps = methodology.get("reps") or max((r.get("rep", 1) for r in rows), default=1)
    missing = []
    for task in expected:
        for harness in ("mini", "pi"):
            for rep in range(1, reps + 1):
                if not any(r.get("rep", 1) == rep for r in grouped[task][harness]):
                    missing.append({"task": task, "harness": harness, "rep": rep})
    complete = not missing and not invalid and all(len(grouped[t]) == 2 for t in expected)
    if not complete and not args.allow_partial:
        raise SystemExit(json.dumps({"error": "invalid or incomplete campaign", "missing": missing, "invalid": invalid}, indent=2))

    task_rows = []
    for task in expected:
        mini, pi = grouped[task]["mini"], grouped[task]["pi"]
        if not mini or not pi:
            continue
        mm, me, pm = med(mini), med(mini, "e2e"), med(pi)
        pairs = []
        for m in mini:
            p = next((p for p in pi if p.get("rep", 1) == m.get("rep", 1)), None)
            if p and m["wall"] > 0:
                pairs.append({"rep": m.get("rep", 1), "worker_speedup": p["wall"] / m["wall"],
                              "e2e_speedup": p["wall"] / m["e2e"] if m.get("e2e") else None,
                              "mini_pass": m["verify"], "pi_pass": p["verify"]})
        task_rows.append({
            "task": task, "level": LEVELS.get(task, "unclassified"),
            "reps": min(len(mini), len(pi)),
            "mini_worker_median_s": mm, "mini_e2e_median_s": me, "pi_median_s": pm,
            "worker_speedup": pm / mm, "e2e_speedup": pm / me if me else None,
            "mini_pass": pass_count(mini), "pi_pass": pass_count(pi), "runs_per_arm": len(mini),
            "mini_worker_walls_s": [r["wall"] for r in mini], "mini_e2e_walls_s": [r.get("e2e") for r in mini],
            "pi_walls_s": [r["wall"] for r in pi], "paired": pairs,
        })
    mini_all = [r for r in rows if r.get("harness") == "mini" and valid(r)]
    pi_all = [r for r in rows if r.get("harness") == "pi" and valid(r)]
    mini_pass, pi_pass = pass_count(mini_all), pass_count(pi_all)
    mini_rate = mini_pass / len(mini_all) if mini_all else 0
    pi_rate = pi_pass / len(pi_all) if pi_all else 0
    worker_sum = sum(t["mini_worker_median_s"] for t in task_rows)
    e2e_sum = sum(t["mini_e2e_median_s"] for t in task_rows)
    pi_sum = sum(t["pi_median_s"] for t in task_rows)
    worker_speedup = pi_sum / worker_sum if worker_sum else 0
    e2e_speedup = pi_sum / e2e_sum if e2e_sum else 0
    quality_gate = mini_rate >= pi_rate
    report = {
        "run_dir": str(run_dir), "complete": complete, "missing": missing, "invalid": invalid,
        "methodology": methodology,
        "aggregate": {
            "tasks": len(task_rows), "runs_per_arm": len(mini_all),
            "mini_pass": mini_pass, "pi_pass": pi_pass,
            "mini_pass_rate": mini_rate, "pi_pass_rate": pi_rate,
            "sum_of_task_medians": {"mini_worker_s": worker_sum, "mini_e2e_s": e2e_sum, "pi_s": pi_sum},
            "worker_speedup": worker_speedup, "e2e_speedup": e2e_speedup,
            "quality_gate_mini_at_least_pi": quality_gate,
            "goal_worker_2x_at_equal_or_better_pass": complete and quality_gate and worker_speedup >= 2,
            "goal_e2e_2x_at_equal_or_better_pass": complete and quality_gate and e2e_speedup >= 2,
        },
        "tasks_detail": task_rows,
    }
    by_level: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for task in task_rows:
        by_level[task["level"]].append(task)
    report["by_level"] = [{
        "level": level, "tasks": len(ts),
        "mini_pass": sum(t["mini_pass"] for t in ts), "pi_pass": sum(t["pi_pass"] for t in ts),
        "runs_per_arm": sum(t["runs_per_arm"] for t in ts),
        "worker_speedup": sum(t["pi_median_s"] for t in ts) / sum(t["mini_worker_median_s"] for t in ts),
        "e2e_speedup": sum(t["pi_median_s"] for t in ts) / sum(t["mini_e2e_median_s"] for t in ts),
    } for level, ts in sorted(by_level.items())]
    (run_dir / "analysis.json").write_text(json.dumps(report, indent=2) + "\n")

    a = report["aggregate"]
    lines = [
        "# mini queue vs pi — validated A/B", "",
        f"- Run: `{run_dir}`",
        f"- Model: `{methodology.get('model', 'unknown')}`; pi: `{methodology.get('pi_provider', '?')}/{methodology.get('pi_model', '?')}`",
        f"- Complete matrix: **{complete}**; repetitions: **{a['runs_per_arm']} per arm**",
        f"- Pass: **mini {mini_pass}/{len(mini_all)} ({mini_rate:.1%})**, **pi {pi_pass}/{len(pi_all)} ({pi_rate:.1%})**",
        f"- Sum of per-task medians: worker **{worker_sum:.1f}s**, e2e **{e2e_sum:.1f}s**, pi **{pi_sum:.1f}s**",
        f"- Speedup: **worker {worker_speedup:.2f}x**, **e2e {e2e_speedup:.2f}x**",
        f"- Goal worker ≥2x with equal/better pass: **{'PASS' if a['goal_worker_2x_at_equal_or_better_pass'] else 'FAIL'}**",
        f"- Goal e2e ≥2x with equal/better pass: **{'PASS' if a['goal_e2e_2x_at_equal_or_better_pass'] else 'FAIL'}**", "",
        "| Task | Level | mini worker med s | mini e2e med s | pi med s | pi/worker | pi/e2e | mini PASS | pi PASS |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for t in task_rows:
        lines.append(f"| {t['task']} | {t['level']} | {t['mini_worker_median_s']:.1f} | {t['mini_e2e_median_s']:.1f} | {t['pi_median_s']:.1f} | {t['worker_speedup']:.2f}x | {t['e2e_speedup']:.2f}x | {t['mini_pass']}/{t['runs_per_arm']} | {t['pi_pass']}/{t['runs_per_arm']} |")
    lines += ["", "> Levels are editorial task-shape labels for this local corpus, not calibrated human difficulty.", ""]
    (run_dir / "REPORT.md").write_text("\n".join(lines))
    print(json.dumps(a, indent=2))
    print(f"report: {run_dir / 'REPORT.md'}")


if __name__ == "__main__":
    main()
