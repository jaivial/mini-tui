#!/usr/bin/env python3
"""Fast iteration on the queue WORKER: run corpus tasks straight through mini-agent-rs with the
exact environment the work queue gives a worker (no web server, no dispatcher), N at a time.

    python3 run_worker_direct.py [--par N] [--reps R] [--env K=V ...] [task ...]

Prints per-task wall, turns, model seconds and verify, and a total. Used to A/B worker changes
before the full queue benchmark (run_queue_bench.py) measures the real flow.
"""
import json, os, shutil, statistics, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

sys.argv, _argv = sys.argv[:1], sys.argv
import run_bench as rb  # noqa: E402
sys.argv = _argv

BIN = os.environ.get("MINITUI_AGENT_BIN", "/home/jaime/mini-tui/agent-rs/target/release/mini-agent-rs")
CFG = "/home/jaime/mini-tui/agent/src/minisweagent/config"
MODEL = os.environ.get("BENCH_MODEL", "xiaomi/mimo-v2.6-flash")


def provider_env(model):
    prefix = model.split("/")[0]
    for c in json.load(open(os.path.expanduser("~/.config/mini-tui/providers.json"))):
        if c["prefix"] == prefix:
            return {c["keyEnv"]: c["key"], **c.get("extraEnv", {})}
    return {}


def run(task, rundir, tag, extra):
    work = os.path.join(rundir, f"{task}{tag}")
    shutil.rmtree(work, ignore_errors=True)
    shutil.copytree(os.path.join(rb.TASKS_DIR, task), work)
    text = open(os.path.join(rb.TASKS_DIR, task, "TASK.md")).read().strip()
    traj = os.path.join(rundir, f"{task}{tag}.traj.json")
    env = {**os.environ, **provider_env(MODEL), "MINITUI_AGENT_TOOLS": "1", "MINI_AGENT_TASK_FILE": "1",
           "MINI_AGENT_CONFIG_DIR": CFG, "MSWEA_SILENT_STARTUP": "1", "MSWEA_CONTROL_FILE": "",
           "MINI_AGENT_TOOLSET": "worker", "MINI_AGENT_GOAL_ORACLE": "off", "MINI_AGENT_CACHE_WARMER": "off",
           "MINI_AGENT_ORCHESTRATOR": "0", **extra}
    t0 = time.time()
    specs = sum((["-c", c] for c in os.environ.get("WORKER_SPECS", "").split(",") if c), [])
    p = subprocess.run([BIN, "-y", "--exit-immediately", "-o", traj, "-m", MODEL, *specs, "-t", f"Working directory: {work}\n\n{text}"],
                       cwd=work, env=env, capture_output=True, text=True, timeout=900)
    wall = round(time.time() - t0, 1)
    v, _ = rb.verify(work, task)
    turns = model = think = 0
    try:
        for m in json.load(open(traj))["messages"]:
            if m["role"] != "assistant":
                continue
            turns += 1
            model += ((m.get("extra") or {}).get("timings") or {}).get("model_ms", 0) / 1000
            c = m.get("content")
            think += sum(len(b.get("thinking", "")) for b in c if isinstance(b, dict)) if isinstance(c, list) else 0
    except Exception:
        pass
    return {"task": task, "wall": wall, "turns": turns, "model": round(model, 1), "think": think, "verify": v, "rc": p.returncode}


def main():
    args = sys.argv[1:]
    par, reps, extra = 5, 1, {}
    while args and args[0].startswith("--"):
        a = args.pop(0)
        if a == "--par":
            par = int(args.pop(0))
        elif a == "--reps":
            reps = int(args.pop(0))
        elif a == "--env":
            k, v = args.pop(0).split("=", 1)
            extra[k] = v
    todo = args or rb.tasks()
    rundir = os.path.join(rb.BASE, "runs", "direct-" + time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(rundir)
    jobs = [(t, f".r{r + 1}") for r in range(reps) for t in todo]
    with ThreadPoolExecutor(par) as ex:
        rows = list(ex.map(lambda j: run(j[0], rundir, j[1], extra), jobs))
    json.dump(rows, open(os.path.join(rundir, "summary.json"), "w"), indent=1)
    by = {}
    for r in rows:
        by.setdefault(r["task"], []).append(r)
    tot = 0
    for t in sorted(by):
        rs = by[t]
        med = statistics.median(r["wall"] for r in rs)
        tot += med
        print(f"{t:20} med {med:6.1f}s  " + "  ".join(f"{r['wall']}s/{r['turns']}t/think{r['think']}/{r['verify']}" for r in rs))
    print(f"extra={extra} sum of medians {tot:.1f}s pass {sum(r['verify'] == 'PASS' for r in rows)}/{len(rows)}  dir {rundir}")


if __name__ == "__main__":
    main()
