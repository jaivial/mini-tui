"""Run one scripted task through the Python agent and the Rust agent; diff what mini-tui reads.

    python3 compare.py <config.yaml> [--task T] [--control-script FILE] [--resume-from-python]

Normalized before comparing: timestamps, durations (thinking_seconds), and the run's own paths.
Everything else (messages, observations, info, journal lines, exit status) must be identical.
"""
import json, os, re, subprocess, sys, tempfile, time, shutil, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RUST = os.environ.get("MINI_AGENT_RS") or os.path.join(REPO, "agent-rs", "target", "release", "mini-agent-rs")
PY = ["/usr/bin/python3.10", "-m", "minisweagent.run.tui"]

def normalize(v, root):
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if k in ("timestamp",) and isinstance(x, (int, float)):
                out[k] = "<ts>"
            elif k == "thinking_seconds":
                out[k] = "<secs>"
            elif k == "elapsed_seconds":
                out[k] = "<secs>"
            elif k == "X-Parity-Client":
                out[k] = "<client>"
            elif k == "traceback" and isinstance(x, str):
                # Python prints a stack; the Rust agent prints the final line. mini-tui shows neither.
                out[k] = "<traceback>"
            else:
                out[k] = normalize(x, root)
        return out
    if isinstance(v, list):
        return [normalize(x, root) for x in v]
    if isinstance(v, str):
        return v.replace(root, "<ROOT>")
    return v

def run(kind, cfg, task, workdir, control_script, resume, extra_env, extra_configs=(), compact_only=False):
    out_dir = os.path.join(workdir, kind)
    os.makedirs(out_dir, exist_ok=True)
    traj = os.path.join(out_dir, "traj.json")
    cmd = (PY if kind == "py" else [RUST]) + ["-y", "--exit-immediately", "-o", traj, "-c", cfg]
    for extra in extra_configs:
        cmd += ["-c", extra]
    if resume:
        cmd += ["--resume", resume]
    if compact_only:
        cmd += ["--compact-only"]
    else:
        cmd += ["-t", task]
    env = dict(os.environ, MSWEA_SILENT_STARTUP="1", MSWEA_COST_TRACKING="ignore_errors", **extra_env)
    control = os.path.join(out_dir, "control")
    if control_script:
        open(control, "w").close()
        env["MSWEA_CONTROL_FILE"] = control
    else:
        env["MSWEA_CONTROL_FILE"] = ""
    cwd = os.path.join(workdir, "cwd")
    os.makedirs(cwd, exist_ok=True)
    started = time.time()
    proc = subprocess.Popen(cmd, cwd=cwd if kind == "py" else cwd, env=env | ({"PYTHONPATH": os.path.join(REPO, "agent", "src")} if kind == "py" else {}),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if control_script:
        for line in open(control_script):
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            if line.startswith("WAIT_JOURNAL "):
                want = int(line.split()[1])
                j = traj[:-5] + ".jsonl"
                t0 = time.time()
                while time.time() - t0 < 20:
                    n = sum(1 for l in open(j) if l.startswith('{"t":"msg"')) if os.path.exists(j) else 0
                    if n >= want:
                        break
                    time.sleep(0.05)
                continue
            if line.startswith("SLEEP "):
                time.sleep(float(line.split()[1]))
                continue
            if line == "KILL":
                proc.terminate()
                continue
            if line == "INT":
                proc.send_signal(2)
                continue
            with open(control, "a") as f:
                f.write(line + "\n")
    try:
        out, _ = proc.communicate(timeout=60)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, _ = proc.communicate()
    return {"code": proc.returncode, "log": out.decode("utf-8", "replace"), "traj": traj, "secs": time.time() - started}

def drop_script(info):
    """The scripted model's `outputs` list: Python's agent mutates those dicts in place (it
    returns them by reference, then adds context_chars/thinking_seconds), so they differ from
    the script. mini-tui never reads them; the replies themselves are compared as messages."""
    model = (info or {}).get("config", {}).get("model", {})
    if isinstance(model, dict) and "outputs" in model:
        model["outputs"] = "<script>"

def load(r, root):
    data = json.load(open(r["traj"])) if os.path.exists(r["traj"]) else {}
    journal = []
    jp = r["traj"][:-5] + ".jsonl"
    if os.path.exists(jp):
        journal = [json.loads(l) for l in open(jp) if l.strip()]
    drop_script(data.get("info"))
    for line in journal:
        if line.get("t") == "info":
            drop_script(line.get("i"))
    return normalize(data, root), normalize(journal, root)

def diff(a, b, path="$"):
    if type(a) != type(b):
        if isinstance(a, (int, float)) and isinstance(b, (int, float)) and a == b:
            return []
        return [f"{path}: {json.dumps(a)[:200]} != {json.dumps(b)[:200]}"]
    if isinstance(a, dict):
        out = []
        for k in list(a) + [k for k in b if k not in a]:
            if k not in a or k not in b:
                out.append(f"{path}.{k}: only in {'python' if k in a else 'rust'}: {json.dumps(a.get(k, b.get(k)))[:200]}")
            else:
                out += diff(a[k], b[k], f"{path}.{k}")
        if list(a) != list(b) and not out:
            out.append(f"{path}: key order {list(a)} != {list(b)}")
        return out
    if isinstance(a, list):
        out = [f"{path}: length {len(a)} != {len(b)}"] if len(a) != len(b) else []
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff(x, y, f"{path}[{i}]")
        return out
    return [] if a == b else [f"{path}: {json.dumps(a)[:300]} != {json.dumps(b)[:300]}"]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--task", default="what is the answer")
    ap.add_argument("--control-script")
    ap.add_argument("--resume")
    ap.add_argument("--env", action="append", default=[])
    ap.add_argument("--journal-only-msgs", action="store_true", help="compare only msg lines of the journal")
    ap.add_argument("--extra-config", action="append", default=[])
    ap.add_argument("--compact-only", action="store_true")
    a = ap.parse_args()
    extra_env = dict(e.split("=", 1) for e in a.env)
    workdir = tempfile.mkdtemp(prefix="parity-")
    try:
        results = {}
        for kind in ("py", "rs"):
            # Each side gets the same relative cwd so {{cwd}}-like values match after normalizing.
            results[kind] = run(kind, os.path.abspath(a.config), a.task, workdir, a.control_script, a.resume, extra_env,
                                [os.path.abspath(c) for c in a.extra_config], a.compact_only)
        (pt, pj), (rt, rj) = (load(results["py"], workdir + "/py"), load(results["rs"], workdir + "/rs"))
        # Paths differ only by the py/rs directory.
        pt, pj = normalize(pt, workdir + "/py"), normalize(pj, workdir + "/py")
        problems = []
        if results["py"]["code"] != results["rs"]["code"]:
            problems.append(f"exit code {results['py']['code']} != {results['rs']['code']}")
        problems += diff(pt, rt, "traj")
        if a.journal_only_msgs:
            pj = [l for l in pj if l.get("t") == "msg"]
            rj = [l for l in rj if l.get("t") == "msg"]
        problems += diff(pj, rj, "journal")
        print(f"python: exit {results['py']['code']} in {results['py']['secs']:.2f}s | rust: exit {results['rs']['code']} in {results['rs']['secs']:.2f}s | messages {len(pt.get('messages', []))} vs {len(rt.get('messages', []))} | journal lines {len(pj)} vs {len(rj)}")
        if problems:
            print(f"DIFFERENCES ({len(problems)}):")
            for p in problems[:40]:
                print("  " + p)
            if os.environ.get("SHOW_LOGS"):
                print("--- python log\n" + results["py"]["log"][-3000:] + "\n--- rust log\n" + results["rs"]["log"][-3000:])
            sys.exit(1)
        print("IDENTICAL")
    finally:
        if not os.environ.get("KEEP"):
            shutil.rmtree(workdir, ignore_errors=True)
        else:
            print("kept", workdir)

if __name__ == "__main__":
    main()
