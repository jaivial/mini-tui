"""Wire parity: both agents talk to the same scripted HTTP server (mock_server.py).

Compares the trajectories (as compare.py does) *and* every request body each agent sent.

    python3 compare_wire.py <config.yaml> <script.json> --base-env CLIPROXY_API_BASE [--suffix /v1]
"""
import argparse, glob, json, os, shutil, socket, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import compare as _compare
compare = vars(_compare)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("script")
    ap.add_argument("--base-env", required=True)
    ap.add_argument("--key-env", default="")
    ap.add_argument("--suffix", default="/v1")
    ap.add_argument("--task", default="do the wire task")
    ap.add_argument("--env", action="append", default=[])
    a = ap.parse_args()
    workdir = tempfile.mkdtemp(prefix="wire-")
    record = os.path.join(workdir, "requests")
    os.makedirs(record)
    port = free_port()
    server = subprocess.Popen([sys.executable, os.path.join(HERE, "mock_server.py"), a.script, str(port), record])
    try:
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.1).close()
                break
            except OSError:
                time.sleep(0.05)
        results = {}
        for kind in ("py", "rs"):
            env = {a.base_env: f"http://127.0.0.1:{port}{a.suffix}", "MINI_AGENT_RETRY_MIN_WAIT": "0.05",
                   "MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT": "3", "OPENCODE_GO_SESSION": "mini-swe-agent-parity"}
            if a.key_env:
                env[a.key_env] = "sk-parity"
            env.update(dict(e.split("=", 1) for e in a.env))
            # Tag requests with the client so each run gets its own copy of the script.
            cfg = os.path.join(workdir, f"{kind}.yaml")
            with open(cfg, "w") as f:
                f.write(open(a.config).read())
                f.write(f"\n# tag\n")
            tag = os.path.join(workdir, f"{kind}-tag.yaml")
            json.dump({"model": {"model_kwargs": {"extra_headers": {"X-Parity-Client": kind}}}}, open(tag, "w"))
            results[kind] = compare["run"](kind, cfg, a.task, workdir, None, None, env, [tag], False)
        (pt, pj), (rt, rj) = compare["load"](results["py"], workdir + "/py"), compare["load"](results["rs"], workdir + "/rs")
        pt, pj = compare["normalize"](pt, workdir + "/py"), compare["normalize"](pj, workdir + "/py")
        problems = []
        if results["py"]["code"] != results["rs"]["code"]:
            problems.append(f"exit code {results['py']['code']} != {results['rs']['code']}")
        problems += compare["diff"](pt, rt, "traj")
        problems += compare["diff"](pj, rj, "journal")
        def requests(kind):
            out = []
            for p in sorted(glob.glob(os.path.join(record, f"{kind}-*.json"))):
                r = json.load(open(p))
                r["body"] = compare["normalize"](r["body"], workdir + "/" + kind)
                out.append(r)
            return out
        pr, rr = requests("py"), requests("rs")
        problems += compare["diff"](pr, rr, "requests")
        print(f"python: exit {results['py']['code']} | rust: exit {results['rs']['code']} | messages {len(pt.get('messages', []))} vs {len(rt.get('messages', []))} | requests {len(pr)} vs {len(rr)}")
        if problems:
            print(f"DIFFERENCES ({len(problems)}):")
            for p in problems[:30]:
                print("  " + p)
            if os.environ.get("SHOW_LOGS"):
                print("--- python log\n" + results["py"]["log"][-2500:] + "\n--- rust log\n" + results["rs"]["log"][-2500:])
            sys.exit(1)
        print("IDENTICAL")
    finally:
        server.kill()
        if os.environ.get("KEEP"):
            print("kept", workdir)
        else:
            shutil.rmtree(workdir, ignore_errors=True)


main()
