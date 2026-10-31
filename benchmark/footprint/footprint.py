#!/usr/bin/env python3
"""Per-session footprint of the Rust agent: peak RSS/PSS, threads, child processes, CPU time and
context switches for one scripted run, with no network and no API spend.

    python3 benchmark/footprint/footprint.py [--bin PATH] [--runs 5] [--steps 12] [--sleep 2]

A local OpenAI-compatible mock answers every request: `--steps` distinct bash calls that each
print `--lines` lines (so the conversation grows like a real run), one `sleep --sleep` call (CPU spent
while a command waits), then a final text answer. `--delay` is the mock's latency per request
(CPU spent while a model call waits). The run gets the environment mini-tui gives a web session
(`MINI_AGENT_CU_MCP=1` included), so the built-in `cu` MCP child is part of the measurement.

`--cu-call status` makes the second action an `mcp__cu__status` call (the model using the browser).
`--capture DIR` saves every request body the agent sends, byte for byte, as DIR/run<i>/req<n>.json;
runs then use fixed directories and session ids so two binaries' captures can be diffed directly
(tool-call ids are deterministic in every mode).

Context switches and agent CPU are read from /proc of the agent itself (all its threads, the
dead ones included for CPU); `rusage_*` comes from wait4 and also counts the commands it reaped.
"""
import argparse, json, os, shutil, statistics, subprocess, tempfile, threading, time, uuid

CAPTURE = {"dir": None, "run": 0, "n": 0}
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PAGE = os.sysconf("SC_PAGE_SIZE")
TICKS = os.sysconf("SC_CLK_TCK")


def mock_server(steps, lines, sleep_s, delay, cu_call=None):
    def text_of(c):
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return "".join(p.get("text", "") for p in c if isinstance(p, dict))
        return ""

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            n = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(n)
            if CAPTURE["dir"]:
                d = os.path.join(CAPTURE["dir"], f"run{CAPTURE['run']}")
                os.makedirs(d, exist_ok=True)
                CAPTURE["n"] += 1
                with open(os.path.join(d, f"req{CAPTURE['n']:03d}.json"), "wb") as f:
                    f.write(raw)
            req = json.loads(raw or b"{}")
            time.sleep(delay)
            msgs = req.get("messages", [])
            done = sum(1 for m in msgs if m.get("role") == "assistant" and m.get("tool_calls"))
            # Distinct commands: the agent ends a run that repeats one command (RepeatedActionLoop).
            plan = [("bash", {"command": f"seq {i + 1} {i + lines}"}) for i in range(steps)] + ([("bash", {"command": f"sleep {sleep_s}"})] if sleep_s > 0 else [])
            if cu_call:
                plan.insert(1, (f"mcp__cu__{cu_call}", {}))
            msg = {"role": "assistant", "content": None}
            if not req.get("tools"):
                msg["content"] = "Mock title"
            elif done < len(plan):
                name, arguments = plan[done]
                msg["tool_calls"] = [{"id": f"call_{done:012d}", "type": "function",
                                      "function": {"name": name, "arguments": json.dumps(arguments)}}]
            else:
                msg["content"] = f"DONE after {done} steps"
            out = {"id": "x", "object": "chat.completion", "model": "mock",
                   "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if msg.get("tool_calls") else "stop"}],
                   "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
            body = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def children_map():
    kids = {}
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            with open(f"/proc/{d}/stat") as f:
                s = f.read()
            ppid = int(s[s.rindex(")") + 2:].split()[1])
            kids.setdefault(ppid, []).append(int(d))
        except (OSError, ValueError):
            pass
    return kids


def tree(pid):
    kids, out, todo = children_map(), [], [pid]
    while todo:
        p = todo.pop()
        out.append(p)
        todo.extend(kids.get(p, []))
    return out


def proc_status(pid):
    try:
        with open(f"/proc/{pid}/status") as f:
            st = dict(l.split(":", 1) for l in f if ":" in l)
        with open(f"/proc/{pid}/comm") as f:
            comm = f.read().strip()
        return comm, int(st["VmRSS"].split()[0]), int(st["Threads"].strip())
    except (OSError, KeyError, ValueError):
        return None


def pss_kb(pid):
    try:
        with open(f"/proc/{pid}/smaps_rollup") as f:
            for l in f:
                if l.startswith("Pss:"):
                    return int(l.split()[1])
    except OSError:
        pass
    return 0


def agent_counters(pid, seen):
    """CPU ticks of the whole agent (/proc/<pid>/stat counts dead threads too) and the context
    switches of each live thread, remembered by tid so a thread that ended still counts."""
    ticks = None
    try:
        with open(f"/proc/{pid}/stat") as f:
            s = f.read()
        fields = s[s.rindex(")") + 2:].split()
        ticks = int(fields[11]) + int(fields[12])
        for tid in os.listdir(f"/proc/{pid}/task"):
            try:
                with open(f"/proc/{pid}/task/{tid}/status") as f:
                    st = dict(l.split(":", 1) for l in f if ":" in l)
                seen[tid] = (int(st["voluntary_ctxt_switches"]), int(st["nonvoluntary_ctxt_switches"]))
            except (OSError, KeyError, ValueError):
                pass
    except (OSError, ValueError):
        pass
    return ticks


def turn_ended(traj):
    try:
        with open(traj) as f:
            return bool(json.load(f).get("info", {}).get("exit_status"))
    except (OSError, ValueError):
        return False


def one_run(args, port, index=0):
    if args.capture:
        tmp = os.path.join("/tmp", "mini-footprint-cap", f"run{index}")
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        CAPTURE["run"], CAPTURE["n"] = index, 0
    else:
        tmp = tempfile.mkdtemp(prefix="mini-footprint-")
    traj = os.path.join(tmp, "traj.json")
    control = os.path.join(tmp, "control")
    open(control, "w").close()
    task = os.path.join(tmp, "task.txt")
    with open(task, "w") as f:
        f.write("Run the scripted steps.")
    env = dict(os.environ)
    env.update({
        "MSWEA_OPENAI_API_BASE": f"http://127.0.0.1:{port}/v1", "MSWEA_OPENAI_API_KEY": "mock",
        "MINI_AGENT_CONFIG_DIR": os.path.join(ROOT, "agent", "src", "minisweagent", "config"),
        "MINITUI_AGENT_TOOLS": "1", "MINI_AGENT_TASK_FILE": "1", "MSWEA_CONTROL_FILE": control,
        "MSWEA_SILENT_STARTUP": "1", "MINI_AGENT_CU_MCP": "1" if args.cu else "0",
        "MINITUI_SESSION_ID": f"footprint-cap{index}" if args.capture else "footprint-" + uuid.uuid4().hex[:8], "MINI_AGENT_ORCHESTRATOR": "1",
        "MINI_AGENT_MAX_DEPTH": "10", "MINI_AGENT_CONTEXT_DIR": os.path.join(tmp, "ctx"),
        "MINI_AGENT_GOAL_ORACLE": "off", "MINI_AGENT_CACHE_WARMER": "off",
    })
    if not args.user_config:
        # The developer's ~/.config/mini-swe-agent/.env can name remote MCP servers: their
        # handshakes would put the network in every measurement.
        os.makedirs(os.path.join(tmp, "cfg"), exist_ok=True)
        env["MSWEA_GLOBAL_CONFIG_DIR"] = os.path.join(tmp, "cfg")
    for kv in args.env:
        k, _, v = kv.partition("=")
        env[k] = v
    # `--idle S`: the session stays up after its turn (as a web session waiting for a follow-up);
    # the agent's RSS is read S seconds after the turn ended, then it is stopped with SIGTERM.
    cmd = [args.bin, "-y", *([] if args.idle else ["--exit-immediately"]), "-o", traj, "-m", "openai/gpt-mock", "-t", f"@{task}"]
    t0 = time.monotonic()
    log = open(os.path.join(tmp, "mini.log"), "w")
    p = subprocess.Popen(cmd, cwd=tmp, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    peak_rss = peak_tree_rss = peak_threads = peak_procs = peak_pss = 0
    peak_children = {}
    switches, ticks = {}, 0
    idle_since = idle_rss = None
    next_check = 0.0
    while True:
        done_pid, status, usage = os.wait4(p.pid, os.WNOHANG)
        if done_pid:
            p.returncode = os.waitstatus_to_exitcode(status)
            break
        t = agent_counters(p.pid, switches)
        if t is not None:
            ticks = t
        pids = tree(p.pid)
        tot = 0
        nprocs = 0
        for q in pids:
            s = proc_status(q)
            if not s:
                continue
            comm, rss, th = s
            tot += rss
            nprocs += 1
            if q == p.pid:
                peak_rss = max(peak_rss, rss)
                peak_threads = max(peak_threads, th)
                if args.pss:
                    peak_pss = max(peak_pss, pss_kb(q))
            elif comm not in ("sh", "bash", "seq", "sleep"):
                peak_children[comm] = max(peak_children.get(comm, 0), rss)
        peak_tree_rss = max(peak_tree_rss, tot)
        peak_procs = max(peak_procs, nprocs)
        if args.idle and idle_rss is None and time.monotonic() >= next_check:
            next_check = time.monotonic() + 0.2
            if idle_since is None and turn_ended(traj):
                idle_since = time.monotonic()
            elif idle_since is not None and time.monotonic() - idle_since >= args.idle:
                s = proc_status(p.pid)
                idle_rss = s[1] if s else 0
                p.send_signal(15)
        time.sleep(args.sample)
    wall = time.monotonic() - t0
    log.close()
    try:
        with open(traj) as f:
            t = json.load(f)
        exit_status, n_msgs = t.get("info", {}).get("exit_status"), len(t.get("messages", []))
    except (OSError, ValueError):
        exit_status, n_msgs = None, 0
    if not args.keep:
        shutil.rmtree(tmp, ignore_errors=True)
    return {"wall": wall, "code": p.returncode, "peak_rss_kb": peak_rss, "peak_pss_kb": peak_pss,
            "agent_cpu_s": ticks / TICKS, "vcsw": sum(v for v, _ in switches.values()), "ivcsw": sum(i for _, i in switches.values()),
            "exit_status": exit_status, "messages": n_msgs, "idle_rss_kb": idle_rss,
            "rusage_nvcsw": usage.ru_nvcsw, "rusage_nivcsw": usage.ru_nivcsw, "agent_threads_seen": len(switches),
            "peak_tree_rss_kb": peak_tree_rss, "peak_threads": peak_threads, "peak_procs": peak_procs,
            "children": peak_children, "tmp": tmp}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(ROOT, "agent-rs", "target", "release", "mini-agent-rs"))
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--steps", type=int, default=12)
    ap.add_argument("--lines", type=int, default=2000)
    ap.add_argument("--sleep", type=float, default=2.0)
    ap.add_argument("--delay", type=float, default=0.3)
    ap.add_argument("--sample", type=float, default=0.01)
    ap.add_argument("--no-cu", dest="cu", action="store_false")
    ap.add_argument("--pss", action="store_true", help="also sample PSS of the agent (slower sampling)")
    ap.add_argument("--env", action="append", default=[], help="extra KEY=VALUE for the run")
    ap.add_argument("--keep", action="store_true", help="keep each run's directory (trajectory, mini.log)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--cu-call", default=None, help="make the second action mcp__cu__<NAME> (e.g. status)")
    ap.add_argument("--capture", default=None, help="save every request body under DIR/run<i>/")
    ap.add_argument("--out", default=None, help="also write the summary JSON to this file")
    ap.add_argument("--idle", type=float, default=0.0, help="keep the session up S seconds after its turn and report its RSS then")
    ap.add_argument("--user-config", action="store_true", help="load the developer's ~/.config/mini-swe-agent/.env (remote MCP servers included)")
    args = ap.parse_args()
    if args.capture:
        CAPTURE["dir"] = os.path.abspath(args.capture)
        os.makedirs(CAPTURE["dir"], exist_ok=True)
    srv = mock_server(args.steps, args.lines, args.sleep, args.delay, args.cu_call)
    port = srv.server_address[1]
    rows = []
    for i in range(args.runs):
        before = os.times()
        r = one_run(args, port, i)
        after = os.times()
        r["cpu_s"] = (after.children_user - before.children_user) + (after.children_system - before.children_system)
        rows.append(r)
        if not args.json:
            print(f"run {i + 1}: exit={r['code']} wall={r['wall']:.2f}s cpu={r['cpu_s']:.3f}s agent_rss={r['peak_rss_kb'] / 1024:.1f}MB "
                  f"tree_rss={r['peak_tree_rss_kb'] / 1024:.1f}MB threads={r['peak_threads']} procs={r['peak_procs']} agent_cpu={r['agent_cpu_s']:.2f}s "
                  f"vcsw={r['vcsw']} ivcsw={r['ivcsw']} children={r['children']}", flush=True)
    med = lambda k: statistics.median(r[k] for r in rows)
    summary = {"runs": args.runs, "bin": args.bin, "env": args.env, "cu": args.cu,
               "wall_s": round(med("wall"), 3), "cpu_s": round(med("cpu_s"), 3),
               "agent_peak_rss_mb": round(med("peak_rss_kb") / 1024, 2), "tree_peak_rss_mb": round(med("peak_tree_rss_kb") / 1024, 2),
               "agent_peak_pss_mb": round(med("peak_pss_kb") / 1024, 2) if args.pss else None,
               "peak_threads": med("peak_threads"), "peak_procs": med("peak_procs"),
               "agent_cpu_s": round(med("agent_cpu_s"), 3), "agent_vcsw": med("vcsw"), "agent_ivcsw": med("ivcsw"),
               "rusage_nvcsw": med("rusage_nvcsw"), "rusage_nivcsw": med("rusage_nivcsw"),
               "exit_codes": sorted({r["code"] for r in rows}), "exit_statuses": sorted({str(r["exit_status"]) for r in rows}),
               "messages": med("messages")}
    if args.idle:
        summary["agent_idle_rss_mb"] = round(statistics.median((r["idle_rss_kb"] or 0) for r in rows) / 1024, 2)
    print(json.dumps(summary, indent=None if args.json else 2))
    if args.out:
        with open(args.out, "w") as f:
            json.dump({"summary": summary, "runs": rows}, f, indent=1)
    srv.shutdown()


if __name__ == "__main__":
    main()
