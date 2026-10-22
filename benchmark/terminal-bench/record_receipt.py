#!/usr/bin/env python3
"""Append one receipt row per harbor job to `receipt/runs.csv`.

    $VENV/bin/python benchmark/terminal-bench/record_receipt.py <job-dir> \
        --arm mini --agent mini_agent_rs:MiniAgentRs --model xiaomi/mimo-v2.6-flash

Every number in the row is read from the job's own `result.json` files (Harbor's
TrialResult): the reward the task verifier returned, the agent-phase timestamps and
the token usage the agent reported. Nothing is estimated, nothing is typed in by hand.

    score           resolved rate = trials with reward >= 1.0 / trials
    rewards         per-trial rewards, in task order ("task=reward;...")
    agent_wall_s_*  agent execution phase only (started_at → finished_at)
    job_wall_s      job-level result.json started_at → finished_at (falls back to
                    min(started) → max(finished) over the trials)
    tokens_*        as reported by the agent's own trajectory (0 when it reported none)
    cost_usd        as reported; the token-plan endpoint reports no prices → 0.0/empty
    mini_commit     HEAD of THIS checkout (resolved from the script's own path, never
                    from the caller's cwd)
    phase           which phase of the plan produced the row (F0, F1, ...); the F0
                    rows were backfilled when the column was introduced
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

CSV_PATH = Path(__file__).resolve().parent / "receipt" / "runs.csv"
# benchmark/terminal-bench/record_receipt.py -> <repo>
REPO_ROOT = Path(__file__).resolve().parents[2]

FIELDS = [
    "run_id",
    "timestamp_utc",
    "arm",
    "agent",
    "model",
    "dataset",
    "task_filter",
    "n_trials",
    "n_resolved",
    "score",
    "rewards",
    "agent_wall_s_total",
    "agent_wall_s_median",
    "job_wall_s",
    "tokens_in",
    "tokens_cache",
    "tokens_out",
    "cost_usd",
    "harbor_version",
    "mini_commit",
    "errors",
    "artifacts",
    "phase",
]


def _local_tz():
    return datetime.now().astimezone().tzinfo


def _sec(a: str | None, b: str | None) -> float | None:
    if not a or not b:
        return None
    try:
        ta, tb = datetime.fromisoformat(a), datetime.fromisoformat(b)
        # Harbor mixes naive local timestamps with aware UTC ones between files.
        if ta.tzinfo is None:
            ta = ta.replace(tzinfo=_local_tz())
        if tb.tzinfo is None:
            tb = tb.replace(tzinfo=_local_tz())
        return (tb - ta).total_seconds()
    except (ValueError, TypeError):
        return None


def _aware(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=_local_tz())


def iter_trials(job_dir: Path):
    """Yield TrialResult JSONs; the job-level result.json has no `task_name` and is skipped."""
    for p in sorted(job_dir.rglob("result.json")):
        try:
            data = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            print(f"skip {p}: {exc}", file=sys.stderr)
            continue
        if isinstance(data, dict) and data.get("task_name"):
            yield data


def job_wall_seconds(job_dir: Path) -> float | None:
    """Job-level started_at → finished_at when Harbor has already closed the job."""
    for name in ("result.json", "job.json"):
        p = job_dir / name
        if p.is_file():
            try:
                d = json.loads(p.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            w = _sec(d.get("started_at"), d.get("finished_at"))
            if w is not None:
                return w
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("job_dir", type=Path)
    ap.add_argument("--arm", required=True, help="oracle | mini | ...")
    ap.add_argument("--agent", required=True, help="oracle | mini_agent_rs:MiniAgentRs | ...")
    ap.add_argument("--model", default="", help="model slug, empty for non-model arms")
    ap.add_argument("--dataset", default="", help="dataset name@version actually run")
    ap.add_argument("--task-filter", default="", help="-i patterns used for the run")
    ap.add_argument("--notes", default="", help="stored in the errors column when non-empty")
    ap.add_argument("--phase", required=True,
                    help="phase label this row belongs to (F0, F1, ...)")
    args = ap.parse_args()

    trials = list(iter_trials(args.job_dir))
    if not trials:
        print(f"no trial result.json under {args.job_dir}", file=sys.stderr)
        return 2

    rewards: list[tuple[str, float]] = []
    walls: list[float] = []
    starts: list[datetime] = []
    ends: list[datetime] = []
    tokens_in = tokens_cache = tokens_out = 0
    cost = 0.0
    errors: list[str] = []

    for t in trials:
        name = t.get("task_name", "?")
        vr = t.get("verifier_result") or {}
        r = (vr.get("rewards") or {}).get("reward")
        if r is None and vr.get("rewards"):
            vals = [v for v in vr["rewards"].values() if isinstance(v, (int, float))]
            r = statistics.mean(vals) if vals else None
        rewards.append((name, float(r) if isinstance(r, (int, float)) else 0.0))

        w = _sec((t.get("agent_execution") or {}).get("started_at"),
                 (t.get("agent_execution") or {}).get("finished_at"))
        if w is not None:
            walls.append(w)
        for key, target in (("started_at", starts), ("finished_at", ends)):
            stamp = _aware(t.get(key))
            if stamp is not None:
                target.append(stamp)

        ctx = t.get("agent_result") or {}
        tokens_in += int(ctx.get("n_input_tokens") or 0)
        tokens_cache += int(ctx.get("n_cache_tokens") or 0)
        tokens_out += int(ctx.get("n_output_tokens") or 0)
        cost += float(ctx.get("cost_usd") or 0.0)

        exc = t.get("exception_info") or {}
        if exc:
            errors.append(f"{name}:{exc.get('exception_type', 'error')}")

    n = len(rewards)
    n_resolved = sum(1 for _, r in rewards if r >= 1.0)
    derived = _sec(min(starts).isoformat() if starts else None,
                   max(ends).isoformat() if ends else None)
    job_w = job_wall_seconds(args.job_dir)
    job_wall_s = job_w if job_w is not None else derived

    # Resolve from the checkout that owns this script, never from the caller's cwd:
    # a receipt row has to be tie-able to the exact harness commit it measured.
    try:
        out = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        commit = out.stdout.strip() if out.returncode == 0 and out.stdout.strip() else "unknown"
    except Exception:
        commit = "unknown"
    try:
        import harbor  # only meaningful when run with the venv's python

        harbor_version = getattr(harbor, "__version__", "")
    except Exception:
        harbor_version = ""

    row = {
        "run_id": args.job_dir.name,
        "timestamp_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "arm": args.arm,
        "agent": args.agent,
        "model": args.model,
        "dataset": args.dataset,
        "task_filter": args.task_filter,
        "n_trials": n,
        "n_resolved": n_resolved,
        "score": f"{n_resolved / n:.3f}",
        "rewards": ";".join(f"{t}={r:g}" for t, r in rewards),
        "agent_wall_s_total": f"{sum(walls):.1f}" if walls else "",
        "agent_wall_s_median": f"{statistics.median(walls):.1f}" if walls else "",
        "job_wall_s": f"{job_wall_s:.1f}" if job_wall_s is not None else "",
        "tokens_in": tokens_in,
        "tokens_cache": tokens_cache,
        "tokens_out": tokens_out,
        "cost_usd": f"{cost:.4f}",
        "harbor_version": harbor_version,
        "mini_commit": commit,
        "errors": args.notes or ";".join(errors),
        "artifacts": str(args.job_dir),
        "phase": args.phase,
    }

    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    new = not CSV_PATH.exists()
    with CSV_PATH.open("a", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        if new:
            w.writeheader()
        w.writerow(row)

    print(f"receipt row appended -> {CSV_PATH}")
    print(f"  {row['arm']}: {row['n_resolved']}/{row['n_trials']} resolved "
          f"(score {row['score']}), agent wall {row['agent_wall_s_total']}s, "
          f"job wall {row['job_wall_s']}s, tokens in/out {tokens_in}/{tokens_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
