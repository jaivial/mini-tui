#!/usr/bin/env python3
"""Render a validated queue A/B analysis as dark horizontal bar charts (Pillow)."""
import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "composio-harness"))
from plot_results import draw_chart  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args()
    run_dir = args.run_dir.resolve()
    import json
    report = json.loads((run_dir / "analysis.json").read_text())
    aggregate = report["aggregate"]
    methodology = report.get("methodology", {})
    footer = f"Local coding corpus only — NOT Composio. {methodology.get('model', 'model unknown')} · {run_dir.name}"
    rows = [{
        "name": t["task"], "worker_speedup": t["worker_speedup"],
        "color": "#2DD4BF" if t["worker_speedup"] >= 2 else "#9298A5",
    } for t in report["tasks_detail"]]
    draw_chart(rows, "worker_speedup", "pi / mini assigned-worker time (higher is better)",
               run_dir / "speedup.png", lambda v, r: f"{v:.2f}x", True,
               suffix="x", footer=footer + " · teal = ≥2x")

    mini_pass = aggregate["mini_pass"]
    pi_pass = aggregate["pi_pass"]
    n = aggregate["runs_per_arm"]
    pass_rows = [
        {"name": "mini-tui worker", "pass_rate": 100 * aggregate["mini_pass_rate"], "passed": mini_pass, "color": "#2DD4BF"},
        {"name": "pi", "pass_rate": 100 * aggregate["pi_pass_rate"], "passed": pi_pass, "color": "#D84F91"},
    ]
    draw_chart(pass_rows, "pass_rate", "Objective verifier pass rate", run_dir / "pass-rate.png",
               lambda v, r: f"{r['passed']}/{n} · {v:.0f}%", True, suffix="%", fixed_max=100, footer=footer)

    print(f"wrote {run_dir / 'speedup.png'} and {run_dir / 'pass-rate.png'}")


if __name__ == "__main__":
    main()
