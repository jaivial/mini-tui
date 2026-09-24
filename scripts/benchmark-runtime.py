#!/usr/bin/env python3
"""Measure cold-start cost of the mini CLI and mini-tui's embedded agent path.

The benchmark is deterministic and network-free. It creates a throw-away model,
forces a one-step run, and reports median wall time plus each child's peak RSS.
Run from any directory with ``python3 scripts/benchmark-runtime.py``.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT_SRC = ROOT / "agent" / "src"
MINI_CONFIG = AGENT_SRC / "minisweagent" / "config" / "mini.yaml"
RSS_MARKER = "__MINISWEAGENT_RSS_KIB__="

MODEL_SOURCE = r'''
from minisweagent.models import GLOBAL_MODEL_STATS


class Config:
    def __init__(self, **kwargs):
        self.model_name = kwargs.get("model_name", "bench")

    def model_dump(self, mode="python"):
        return {"model_name": self.model_name}


class BenchModel:
    def __init__(self, **kwargs):
        self.config = Config(**kwargs)

    def query(self, messages, **kwargs):
        GLOBAL_MODEL_STATS.add(0.0)
        return {
            "role": "assistant",
            "content": "done",
            "extra": {"actions": [], "cost": 0.0, "submission": "done"},
        }

    def format_message(self, **kwargs):
        return dict(kwargs)

    def format_observation_messages(self, message, outputs, template_vars=None):
        return []

    def get_template_vars(self, **kwargs):
        return {}

    def serialize(self):
        return {"info": {"config": {"model_type": "bench_model.BenchModel"}}}
'''


def _child_code(name: str) -> str:
    if name == "cli":
        entry = "from minisweagent.run.mini import app as run"
    else:
        entry = "from minisweagent.run.tui import cli_main as run"
    return f"""
import atexit
import resource
import sys
{entry}

def report_rss():
    print({RSS_MARKER!r} + str(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss), file=sys.stderr)

atexit.register(report_rss)
run()
"""


def _sample(command: list[str], env: dict[str, str], cwd: Path) -> tuple[float, float]:
    started = time.perf_counter()
    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
    )
    elapsed_ms = (time.perf_counter() - started) * 1000
    marker = next((line for line in result.stderr.splitlines() if line.startswith(RSS_MARKER)), None)
    if result.returncode != 0 or marker is None:
        raise RuntimeError(f"benchmark child failed ({result.returncode}): {result.stderr[-2000:]}")
    return elapsed_ms, int(marker.removeprefix(RSS_MARKER)) / 1024


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=7, help="fresh processes per path (default: 7)")
    parser.add_argument("--python", default=sys.executable, help="interpreter with the bundled agent installed")
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")

    with tempfile.TemporaryDirectory(prefix="minisweagent-bench-") as temporary:
        temp = Path(temporary)
        (temp / "bench_model.py").write_text(MODEL_SOURCE, encoding="utf-8")
        env = os.environ.copy()
        env.update(
            {
                "PYTHONPATH": os.pathsep.join((str(temp), str(AGENT_SRC))),
                "MSWEA_SILENT_STARTUP": "1",
                "MSWEA_CONFIGURED": "1",
                "MSWEA_CONTROL_FILE": "",
                "MSWEA_GLOBAL_CONFIG_DIR": str(temp / "config"),
            }
        )

        paths = {
            "cli": [
                "-y",
                "--exit-immediately",
                "--model-class",
                "bench_model.BenchModel",
                "-m",
                "bench",
                "-o",
                str(temp / "cli.traj.json"),
                "-c",
                str(MINI_CONFIG),
                "-c",
                "agent.step_limit=1",
                "-t",
                "benchmark",
            ],
            "tui": [
                "-y",
                "--exit-immediately",
                "--model-class",
                "bench_model.BenchModel",
                "-m",
                "bench",
                "-o",
                str(temp / "tui.traj.json"),
                "-c",
                str(MINI_CONFIG),
                "-c",
                "agent.step_limit=1",
                "-t",
                "benchmark",
            ],
        }
        print(f"python={args.python} runs={args.runs}")
        results = {}
        for name in ("cli", "tui"):
            code = _child_code(name)
            command = [args.python, "-c", code, *paths[name]]
            wall: list[float] = []
            rss: list[float] = []
            for _ in range(args.runs):
                elapsed_ms, rss_mib = _sample(command, env, temp)
                wall.append(elapsed_ms)
                rss.append(rss_mib)
            trajectory = json.loads((temp / f"{name}.traj.json").read_text(encoding="utf-8"))
            results[name] = (statistics.median(wall), max(rss), len(trajectory["messages"]))
            print(
                f"{name:3} wall_ms={results[name][0]:7.1f} "
                f"peak_rss_mib={results[name][1]:6.1f} messages={results[name][2]}"
            )
        cli_wall, cli_rss, _ = results["cli"]
        tui_wall, tui_rss, _ = results["tui"]
        print(f"improvement wall={100 * (cli_wall - tui_wall) / cli_wall:.1f}% rss={100 * (cli_rss - tui_rss) / cli_rss:.1f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
