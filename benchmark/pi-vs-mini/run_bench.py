#!/usr/bin/env python3
"""mini-tui web UI vs pi harness: run each task through both, measure wall time, verify.

Restored byte-compatible with the round-1 runner: same per-task JSON files, same
summary.json schema (session/wall/status/verify/verify_out/traj/mini_info/task/
harness/work for mini; pid/turns/model_ms/usage/wall/status/verify/verify_out for
pi), same event streams. summarize.py reads only that schema.

Usage:
    python3 run_bench.py                 # all tasks, both harnesses, sequential
    python3 run_bench.py t8_js_bug       # one task
    python3 run_bench.py --mini-only     # skip pi (use when the zai quota is capped)
"""
import json, os, shutil, subprocess, sys, time, types, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
TASKS_DIR = os.environ.get("BENCH_TASKS_DIR") or os.path.join(BASE, "tasks")

def ensure_fixtures():
    """The three seeded logs are generated, not committed; restore any missing one."""
    gen = os.path.join(BASE, "tasks", "gen_fixtures.py")
    missing = [rel for task, rel in (("t1_wordfreq", "logs/app.log"),
                                     ("t6_readme_summary", "logs/access.log"),
                                     ("t10_crash_report", "logs/service.log"))
               if not os.path.exists(os.path.join(TASKS_DIR, task, rel))]
    if missing:
        subprocess.run([sys.executable, gen], check=True)
    if os.environ.get("BENCH_TASKS_DIR"):
        for gen_name, marker in (("gen_fixtures.py", os.path.join("tp1_single", "logs", "auth.log")),
                                 ("gen_heavy.py", os.path.join("ph1_single", "logs", "miss.log"))):
            gen2 = os.path.join(TASKS_DIR, gen_name)
            if os.path.exists(gen2) and not os.path.exists(os.path.join(TASKS_DIR, marker)):
                subprocess.run([sys.executable, gen2], check=True)

ensure_fixtures()

PORT = os.environ.get("MINITUI_WEB_PORT", "4317")
URL = f"http://127.0.0.1:{PORT}/api/sessions"
MODEL = os.environ.get("BENCH_MODEL", "minimax/MiniMax-M3")
# pi's side of the same model: both harnesses talk to minimax natively (OpenAI-compatible
# chat completions, same credentials), so the comparison is harness-vs-harness.
PI_PROVIDER = os.environ.get("BENCH_PI_PROVIDER", "minimax")
PI_MODEL = os.environ.get("BENCH_PI_MODEL", "MiniMax-M3")
NODE = os.environ.get("BENCH_NODE_BIN") or shutil.which("node") or os.path.expanduser(
    "~/.nvm/versions/node/v24.18.0/bin/node")
PI = os.environ.get("BENCH_PI_BIN") or os.path.expanduser(
    "~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")
TIMEOUT = 1800


def api(method, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(URL, data=data, method=method,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def tasks():
    root = os.environ.get("BENCH_TASKS_DIR") or os.path.join(BASE, "tasks")
    return sorted(d for d in os.listdir(root) if d[:1] in ("t", "p", "h") and os.path.isdir(os.path.join(root, d)))


def verify(work):
    # The verifier is harness-owned, not workspace-owned. mini's goal-oracle "cleanup" step
    # deletes verify.sh as if it were a scratch file the agent created (observed 2026-10-20:
    # "verify.sh deleted" after an oracle turn told the worker to remove it), which would score
    # correct work as FAIL. Restore the pristine copy before scoring and record the tampering.
    task = os.path.basename(work)
    src = os.path.join(TASKS_DIR, task, "verify.sh")
    dst = os.path.join(work, "verify.sh")
    tampered = False
    if os.path.exists(src):
        ref = open(src, "rb").read()
        cur = open(dst, "rb").read() if os.path.exists(dst) else None
        if cur != ref:
            tampered = True
            with open(dst, "wb") as f:
                f.write(ref)
        os.chmod(dst, 0o755)
    p = subprocess.run(["./verify.sh"], cwd=work, capture_output=True, text=True, timeout=600)
    out = (p.stdout + p.stderr).strip()
    ok = "PASS" in out and p.returncode == 0
    verify.tampered = tampered
    return ("PASS" if ok else "FAIL"), out[-400:]


def traj_for(work):
    """The trajectory of a finished run, found by the work directory it ran in.

    The web API does not return `trajPath` (round 4 recorded `null` for every task, which is why
    `mini_info.timings` came back empty and the per-phase analysis had to be reconstructed from
    `~/.config/mini-tui/runs`). The session directory is named `<ts>-<slug>-<id>`, so the newest
    directory whose `task.txt` carries this work directory is the run's own.
    """
    runs = os.path.expanduser("~/.config/mini-tui/runs")
    best = None
    for name in os.listdir(runs):
        traj = os.path.join(runs, name, "traj.json")
        if not os.path.exists(traj):
            continue
        try:
            with open(traj, errors="ignore") as f:
                if work not in f.read():
                    continue
        except OSError:
            continue
        mtime = os.path.getmtime(traj)
        if best is None or mtime > best[0]:
            best = (mtime, traj)
    return best[1] if best else None


def mini_info(sess, traj=None):
    """The run info round 1 recorded: call count plus the item-6 per-phase timings."""
    info = dict(sess.get("info") or {})
    if traj and os.path.exists(traj):
        try:
            t = json.load(open(traj))
        except Exception:
            t = {}
        steps = 0
        model_ms = harness_ms = 0.0
        longest = 0
        chars = 0
        for m in t.get("messages", []):
            extra = m.get("extra") or {}
            tm = extra.get("timings")
            if not tm:
                continue
            steps += 1
            model_ms += tm.get("model_ms") or 0.0
            harness_ms += tm.get("overhead_ms") or 0.0
            longest = max(longest, tm.get("model_ms") or 0.0)
            c = m.get("content") or ""
            if isinstance(c, list):
                c = "".join(p.get("text", "") for p in c if isinstance(p, dict))
            chars += len(c)
        if steps:
            info["timings"] = {"steps": steps, "harness_ms": harness_ms, "model_ms": model_ms,
                               "overhead_ms": harness_ms, "longest_turn_ms": longest,
                               "generated_chars": chars}
            info["sum_harness_ms"] = round(harness_ms, 1)
            info["sum_model_ms"] = round(model_ms, 1)
            info["timed_steps"] = steps
        jev = ((t.get("info") or {}).get("jev_verifier"))
        if jev:
            info["jev_verifier"] = jev
    return info


def run_mini(task, rundir, log):
    work = os.path.join(rundir, "mini", task)
    shutil.rmtree(work, ignore_errors=True)
    shutil.copytree(os.path.join(TASKS_DIR, task), work)
    prompt = open(os.path.join(TASKS_DIR, task, "TASK.md")).read().strip()
    t0 = time.time()
    sess = api("POST", {"prompt": prompt, "cwd": work, "model": MODEL})
    log(f"  mini session {sess['id']} started")
    status, last = "running", None
    while True:
        s = api("GET")
        cur = next((x for x in s if x["id"] == sess["id"]), None)
        status = (cur or {}).get("status", "gone")
        if status != last:
            log(f"  mini status: {status}")
            last = status
        if status in ("done", "error", "interrupted", "gone"):
            break
        if time.time() - t0 > TIMEOUT:
            status = "timeout"
            break
        time.sleep(2)
    wall = round(time.time() - t0, 1)
    cur = next((x for x in api("GET") if x["id"] == sess["id"]), {}) or {}
    traj = traj_for(work)
    v, vout = verify(work)
    log(f"  mini done wall={wall}s verify={v} traj={'yes' if traj else 'MISSING'}")
    return {"session": sess["id"], "wall": wall, "status": status, "verify": v, "verify_out": vout,
            "verifier_tampered": getattr(verify, "tampered", False),
            "traj": traj, "mini_info": mini_info(cur, traj),
            "task": task, "harness": "mini", "work": work}


def run_pi(task, rundir, log):
    work = os.path.join(rundir, "pi", task)
    shutil.rmtree(work, ignore_errors=True)
    shutil.copytree(os.path.join(TASKS_DIR, task), work)
    prompt = open(os.path.join(TASKS_DIR, task, "TASK.md")).read().strip()
    t0 = time.time()
    # Popen (not run) because the row records the pid: a completed subprocess has none, and
    # this is what made every pi run raise before its result was written.
    with subprocess.Popen([NODE, PI, "--provider", PI_PROVIDER, "--model", PI_MODEL,
                           "-p", "--mode", "json", prompt],
                          cwd=work, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True) as proc:
        pid = proc.pid
        try:
            stdout, stderr = proc.communicate(timeout=TIMEOUT)
            rc = proc.returncode
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            rc = "timeout"
    wall = round(time.time() - t0, 1)
    p = types.SimpleNamespace(stdout=stdout, stderr=stderr, returncode=rc)
    events = os.path.join(rundir, f"{task}.pi.events.jsonl")
    with open(events, "w") as f:
        f.write(p.stdout)
    turns = model_ms = 0
    for line in p.stdout.splitlines():
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("type") == "message_end" and (r.get("message") or {}).get("role") == "assistant":
            turns += 1
            model_ms += r["message"].get("durationMs") or 0
    usage = {}
    for line in reversed(p.stdout.splitlines()):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("type") == "message_end" and (r.get("message") or {}).get("role") == "assistant":
            usage = (r["message"].get("usage") or {})
            break
    v, vout = verify(work)
    log(f"  pi done wall={wall}s verify={v}")
    return {"pid": pid, "turns": turns, "model_ms": model_ms, "usage": usage, "wall": wall,
            "status": "done", "verify": v, "verify_out": vout,
            "verifier_tampered": getattr(verify, "tampered", False),
            "task": task, "harness": "pi", "work": work}


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    mini_only = "--mini-only" in sys.argv
    pi_only = "--pi-only" in sys.argv
    harnesses = ["mini"] if mini_only else (["pi"] if pi_only else ["mini", "pi"])
    todo = argv or tasks()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    rundir = os.path.join(BASE, "runs", stamp)
    os.makedirs(rundir)
    logf = open(os.path.join(BASE, f"bench-{stamp[-6:]}.log"), "w")

    def log(m):
        line = f"[{time.strftime('%H:%M:%S')}] load={os.getloadavg()[0]:.1f} {m}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    # Round 5: the load average is stamped on every line. Rounds 3 and 4 both had to caveat their
    # absolute numbers because the machine was busy and nobody recorded it; a ratio is only fair if
    # both halves shared the conditions, and this is the evidence for that.
    log(f"== run {stamp} model={MODEL} pi={PI_PROVIDER}/{PI_MODEL} "
        f"jev={os.environ.get('MINI_AGENT_JEV', 'off')} "
        f"max_tokens={os.environ.get('MSWEA_MAX_TOKENS', 'default')}")

    rows = []
    for task in todo:
        for harness in harnesses:
            log(f"== {task} / {harness}")
            try:
                r = run_mini(task, rundir, log) if harness == "mini" else run_pi(task, rundir, log)
            except Exception as e:
                log(f"  {harness} FAILED: {e}")
                r = {"task": task, "harness": harness, "wall": 0, "status": f"error: {e}",
                     "verify": "FAIL", "verify_out": str(e)}
            rows.append(r)
            json.dump(r, open(os.path.join(rundir, f"{task}.{harness}.json"), "w"), indent=1)
            json.dump(rows, open(os.path.join(rundir, "summary.json"), "w"), indent=1)
    log(f"run dir: {rundir}")
    print(f"\nRun complete: {rundir}")
    print(f"Summarize with: python3 summarize.py {rundir}")


if __name__ == "__main__":
    main()
