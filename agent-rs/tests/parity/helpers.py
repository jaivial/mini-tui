"""The one-shot helpers: `scripts/gen_title.py` / `test_model.py` vs `mini-agent-rs title` / `test-model`.

Each case runs both against the same scripted server and compares stdout, exit code, and the
request bodies. Run from agent-rs/tests.
"""
import json, os, socket, subprocess, sys, tempfile, time, glob

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RUST = os.environ.get("MINI_AGENT_RS") or os.path.join(REPO, "agent-rs", "target", "release", "mini-agent-rs")

def port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

CASES = [
    ("title", ["title"], "gen_title.py", [{"sse": [{"choices": [{"delta": {"role": "assistant", "content": "  Fix   the\\tflaky reconnect\nsecond line"}, "finish_reason": "stop"}]}]}]),
    ("title-long", ["title"], "gen_title.py", [{"sse": [{"choices": [{"delta": {"role": "assistant", "content": "é" * 80}, "finish_reason": "stop"}]}]}]),
    ("title-toolcall", ["title"], "gen_title.py", [{"sse": [{"choices": [{"delta": {"role": "assistant", "content": "", "tool_calls": [{"index": 0, "id": "c", "function": {"name": "bash", "arguments": "{\"command\": \"ls\"}"}}]}, "finish_reason": "tool_calls"}]}]}]),
    ("title-error", ["title"], "gen_title.py", [{"status": 401, "json": {"error": {"message": "bad key"}}}]),
    ("test-ok", ["test-model"], "test_model.py", [{"sse": [{"choices": [{"delta": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]}]}]),
    ("test-toolcall", ["test-model"], "test_model.py", [{"sse": [{"choices": [{"delta": {"role": "assistant", "content": "", "tool_calls": [{"index": 0, "id": "c", "function": {"name": "bash", "arguments": "{\"command\": \"echo ok\"}"}}]}, "finish_reason": "tool_calls"}]}]}]),
    ("test-empty", ["test-model"], "test_model.py", [{"sse": [{"choices": [{"delta": {"role": "assistant", "content": ""}, "finish_reason": "stop"}]}]}]),
    ("test-401", ["test-model"], "test_model.py", [{"status": 401, "json": {"error": {"message": "invalid api key"}}}]),
]

fail = 0
for name, sub, script, steps in CASES:
    work = tempfile.mkdtemp(prefix="helpers-")
    rec = os.path.join(work, "req"); os.makedirs(rec)
    js = os.path.join(work, "script.json"); json.dump(steps, open(js, "w"))
    p = port()

    def serve(record_dir):
        """A fresh server per side: each starts at the first scripted reply."""
        os.makedirs(record_dir, exist_ok=True)
        proc = subprocess.Popen([sys.executable, os.path.join(HERE, "mock_server.py"), js, str(p), record_dir])
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", p), timeout=0.1).close()
                break
            except OSError:
                time.sleep(0.05)
        return proc

    out = {}
    for kind in ("py", "rs"):
        srv = serve(os.path.join(rec, kind))
        env = dict(os.environ, MSWEA_SILENT_STARTUP="1", CLIPROXY_API_BASE=f"http://127.0.0.1:{p}/v1",
                   MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT="1", PYTHONPATH=os.path.join(REPO, "agent", "src"))
        args = ["the task text"] if sub == ["title"] else []
        if kind == "py":
            cmd = ["/usr/bin/python3.10", os.path.join(REPO, "scripts", script), *args, "cliproxy/m"]
        else:
            cmd = [RUST, *sub, *args, "cliproxy/m"]
        r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=60)
        err = r.stderr.strip().splitlines()[-1] if r.stderr.strip() else ""
        out[kind] = (r.returncode, r.stdout.strip(), err)
        srv.kill()
        srv.wait()
    def bodies(d):
        return [json.load(open(f))["body"] for f in sorted(glob.glob(os.path.join(d, "*.json")))]
    same_req = bodies(os.path.join(rec, "py")) == bodies(os.path.join(rec, "rs"))
    same = out["py"] == out["rs"] and same_req
    print(f"{name:15} py={out['py'][:2]} rs={out['rs'][:2]} requests={'same' if same_req else 'DIFFER'} {'OK' if same else 'DIFFER'}")
    if out["py"][2] != out["rs"][2]:
        print(f"{'':15} py stderr: {out['py'][2][:110]}\n{'':15} rs stderr: {out['rs'][2][:110]}")
    fail |= not same
print("ALL SAME" if not fail else "SOME DIFFER")
sys.exit(fail)
