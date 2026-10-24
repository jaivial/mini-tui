#!/usr/bin/env python3
"""mini work queue vs pi: each corpus task goes through the queue exactly as a human would send it.

Flow per task (mini): POST /api/queue/prompt with the task text and its working directory ->
the dispatcher queues it -> a background worker runs it. Measured:
  * worker wall  = the queue task's startedAt -> finishedAt (the "assigned task" execution time)
  * e2e wall     = prompt sent -> task finished (adds the dispatcher's turn)
pi runs the same TASK.md headless in its own copy. Both verified by the task's verify.sh.
Tasks are interleaved (mini, pi, mini, pi...) so provider drift hits both arms alike.

Usage:
    python3 run_queue_bench.py [--reps N] [--mini-only|--pi-only] [task ...]
"""
import hashlib, json, os, shutil, statistics, subprocess, sys, time, urllib.request

sys.argv, _argv = sys.argv[:1], sys.argv
import run_bench as rb  # noqa: E402  (fixtures, verify, run_pi, task list)
sys.argv = _argv

PORT = os.environ.get("MINITUI_WEB_PORT", "4401")
BASE = f"http://127.0.0.1:{PORT}/api"
MODEL = os.environ.get("BENCH_MODEL", "xiaomi/mimo-v2.6-flash")
rb.PI_PROVIDER = os.environ.get("BENCH_PI_PROVIDER", "xiaomi-anthropic")
rb.PI_MODEL = os.environ.get("BENCH_PI_MODEL", "mimo-v2.6-flash")
TIMEOUT = int(os.environ.get("BENCH_TIMEOUT", "900"))


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def traj_of_session(session_id):
    """The worker's trajectory, from the server's sessions DB (agent_runs maps session -> run)."""
    import sqlite3
    db = os.environ.get("MINITUI_DB_PATH", os.path.expanduser("~/.config/mini-tui/sessions.db"))
    try:
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        row = c.execute("select traj_path from agent_runs where session_id=? order by started_at desc limit 1", (session_id,)).fetchone()
        return row[0] if row else None
    except Exception:
        return None


def run_mini_queue(task, rundir, log, tag):
    work = os.path.join(rundir, "mini", f"{task}{tag}")
    shutil.rmtree(work, ignore_errors=True)
    shutil.copytree(os.path.join(rb.TASKS_DIR, task), work)
    text = open(os.path.join(rb.TASKS_DIR, task, "TASK.md")).read().strip()
    before = {t["id"] for t in call("GET", "/queue")["tasks"]}
    call("POST", "/queue/new")
    t0 = time.time()
    call("POST", "/queue/prompt", {"prompt": f"Working directory: {work}\n\n{text}", "model": MODEL})
    qt, status = None, "timeout"
    while time.time() - t0 < TIMEOUT:
        time.sleep(1)
        view = call("GET", "/queue")
        new = [t for t in view["tasks"] if t["id"] not in before]
        if not new and time.time() - t0 > 30:
            main = call("GET", f"/sessions/{view['main']}") if view.get("main") else {}
            if main.get("status") in ("done", "error"):
                status = "no-task"  # the dispatcher answered without queueing anything
                break
        if new and all(t["status"] in ("done", "error", "cancelled") for t in new):
            qt, status = new[0], "done" if all(t["status"] == "done" for t in new) else "error"
            break
    e2e = round(time.time() - t0, 1)
    new = [t for t in call("GET", "/queue")["tasks"] if t["id"] not in before]
    qt = new[0] if new else {}
    for t in new:
        if t["status"] in ("queued", "running"):
            call("POST", f"/queue/tasks/{t['id']}/cancel")
    v, vout = rb.verify(work, task)
    # One card keeps the historical assigned-work time. A fanned-out request is measured from
    # its first worker start to its last worker finish: looking only at card #1 would hide most
    # of the wave and make delegation look artificially fast.
    starts = [t.get("startedAt") or 0 for t in new if t.get("startedAt")]
    finishes = [t.get("finishedAt") or 0 for t in new if t.get("finishedAt")]
    if len(new) > 1 and starts and finishes:
        worker = round((max(finishes) - min(starts)) / 1000, 1)
    else:
        worker = round(qt.get("workSeconds") or 0, 1)
    started = min(starts) / 1000 if starts else 0
    dispatch = round(started - t0, 1) if started else None
    workers = []
    for t in new:
        traj = traj_of_session(t.get("sessionId", ""))
        workers.append({**{k: t.get(k) for k in ("id", "title", "sessionId", "attempts", "cwd", "status", "workSeconds")},
                        "traj": traj, "mini_info": rb.mini_info({}, traj)})
    traj = workers[0]["traj"] if workers else None
    n_tasks = len(new)
    log(f"  mini worker={worker}s e2e={e2e}s dispatch={dispatch}s tasks={n_tasks} status={status} verify={v}")
    return {"task": task, "harness": "mini", "wall": worker, "e2e": e2e, "dispatch": dispatch, "queue_tasks": n_tasks,
            "status": status, "verify": v, "verify_out": vout, "verifier_tampered": getattr(rb.verify, "tampered", False),
            "work": work, "queue_task": {k: qt.get(k) for k in ("id", "title", "sessionId", "attempts", "cwd")},
            "workers": workers, "traj": traj, "mini_info": rb.mini_info({}, traj)}


def main():
    args = sys.argv[1:]
    reps = 1
    if "--reps" in args:
        i = args.index("--reps")
        reps = int(args[i + 1])
        del args[i:i + 2]
    harnesses = ["mini", "pi"]
    if "--mini-only" in args:
        harnesses = ["mini"]
    if "--pi-only" in args:
        harnesses = ["pi"]
    todo = [a for a in args if not a.startswith("--")] or rb.tasks()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    rundir = os.path.join(rb.BASE, "runs", f"queue-{stamp}")
    os.makedirs(rundir)
    repo = os.path.abspath(os.path.join(rb.BASE, "..", ".."))
    binary = os.environ.get("MINITUI_AGENT_BIN", os.path.join(repo, "agent-rs", "target", "release", "mini-agent-rs"))
    provenance = {
        "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": MODEL, "pi_provider": rb.PI_PROVIDER, "pi_model": rb.PI_MODEL,
        "tasks_dir": rb.TASKS_DIR, "tasks": todo, "reps": reps, "timeout_seconds": TIMEOUT,
        "repo_head": subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip(),
        "repo_dirty": bool(subprocess.run(["git", "-C", repo, "status", "--porcelain"], capture_output=True, text=True).stdout.strip()),
        "agent_binary": binary,
        "agent_binary_sha256": hashlib.sha256(open(binary, "rb").read()).hexdigest() if os.path.isfile(binary) else None,
    }
    json.dump(provenance, open(os.path.join(rundir, "methodology.json"), "w"), indent=1)
    logf = open(os.path.join(rundir, "bench.log"), "w")

    def log(m):
        line = f"[{time.strftime('%H:%M:%S')}] load={os.getloadavg()[0]:.1f} {m}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    log(f"== queue run {stamp} model={MODEL} pi={rb.PI_PROVIDER}/{rb.PI_MODEL} reps={reps}")
    rows = []
    for rep in range(reps):
        for task in todo:
            for h in (harnesses if rep % 2 == 0 else harnesses[::-1]):
                log(f"== {task} / {h} / rep {rep + 1}")
                try:
                    r = run_mini_queue(task, rundir, log, f".r{rep + 1}") if h == "mini" else rb.run_pi(task, rundir, log, f".r{rep + 1}")
                except Exception as e:  # a failed run is a FAIL row, never a lost one
                    log(f"  {h} FAILED: {e}")
                    r = {"task": task, "harness": h, "wall": 0, "status": f"error: {e}", "verify": "FAIL"}
                r["rep"] = rep + 1
                rows.append(r)
                json.dump(rows, open(os.path.join(rundir, "summary.json"), "w"), indent=1)
                if h == "pi" and (r.get("returncode") not in (0, None) or r.get("turns") == 0):
                    raise RuntimeError(f"invalid pi runtime on {task} rep {rep + 1}: {r.get('status')}; {r.get('stderr', '')[-500:]}")
    summarize(rows, log)
    log(f"run dir: {rundir}")


def summarize(rows, log):
    by = {}
    for r in rows:
        by.setdefault(r["task"], {}).setdefault(r["harness"], []).append(r)
    log("| task | mini worker med (s) | mini e2e med (s) | pi med (s) | pi/mini | mini pass | pi pass |")
    tm = tp = te = 0.0
    for t in sorted(by):
        m, p = by[t].get("mini", []), by[t].get("pi", [])
        mm = statistics.median([x["wall"] for x in m]) if m else 0
        me = statistics.median([x.get("e2e", 0) for x in m]) if m else 0
        pm = statistics.median([x["wall"] for x in p]) if p else 0
        tm, te, tp = tm + mm, te + me, tp + pm
        ok = lambda xs: f"{sum(x['verify'] == 'PASS' for x in xs)}/{len(xs)}"
        log(f"| {t} | {mm:.1f} | {me:.1f} | {pm:.1f} | {pm / mm if mm else 0:.2f}x | {ok(m)} | {ok(p)} |")
    if tm and tp:
        log(f"sum of medians: mini worker {tm:.1f}s, mini e2e {te:.1f}s, pi {tp:.1f}s -> pi/mini worker {tp / tm:.2f}x, pi/mini e2e {tp / te:.2f}x")


if __name__ == "__main__":
    main()
