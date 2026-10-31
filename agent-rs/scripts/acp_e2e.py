#!/usr/bin/env python3
"""End-to-end check of `mini-agent-rs acp` against a scripted OpenAI-compatible mock.

    python3 agent-rs/scripts/acp_e2e.py [--bin agent-rs/target/release/mini-agent-rs]

No network and no API spend: the mock listens on 127.0.0.1 (a free port) and answers by
scenario, keyed on the task text. HOME, the session store and the MCP config all live in a
temporary directory. The run drives one ACP client session through:

  initialize -> session/new (with a stdio MCP server) -> prompt 1 (bash tool call, streamed
  answer) -> prompt 2 (history kept) -> prompt 3 + session/cancel during `sleep 30` ->
  prompt 4 (resumes after the cancel) -> a NEW server process: session/load replays the
  conversation before answering -> session/list -> set_config_option -> stdin EOF exits.

It also prints the server's idle RSS and CPU. Exit code 0 means every check passed.
"""
import argparse, json, os, queue, shutil, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TOOLS_SEEN = set()
CHECKS = []
SLOW_STARTED = threading.Event()

MCP_SERVER = r'''
import json, sys
for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    if "id" not in msg:
        continue
    method = msg.get("method")
    if method == "initialize":
        result = {"protocolVersion": msg.get("params", {}).get("protocolVersion", "2024-11-05"), "capabilities": {"tools": {}}, "serverInfo": {"name": "echo", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "ping", "description": "Answers pong.", "inputSchema": {"type": "object", "properties": {}}}]}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": "pong"}]}
    else:
        result = {}
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
    sys.stdout.flush()
'''


def check(name, ok, detail=""):
    CHECKS.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" -- {detail}" if detail and not ok else ""), flush=True)


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


SCENARIOS = ["scripted check", "earlier command", "slow job", "after the cancel"]


def mock_server():
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def send_json(self, msg):
            out = {"id": "mock", "object": "chat.completion", "model": "mock",
                   "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if msg.get("tool_calls") else "stop"}],
                   "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}}
            body = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def send_stream(self, pieces):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("connection", "close")
            self.end_headers()
            self.close_connection = True
            def frame(obj):
                self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode())
                self.wfile.flush()
            for i, piece in enumerate(pieces):
                delta = {"content": piece}
                if i == 0:
                    delta["role"] = "assistant"
                frame({"id": "mock", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]})
                time.sleep(0.35)
            frame({"id": "mock", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
            frame({"id": "mock", "object": "chat.completion.chunk", "choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

        def do_POST(self):
            n = int(self.headers.get("content-length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            msgs = req.get("messages", [])
            for t in req.get("tools") or []:
                TOOLS_SEEN.add((t.get("function") or t).get("name"))
            everything = "\n".join(text_of(m.get("content")) for m in msgs)
            if "Write a short title" in everything:
                return self.send_json({"role": "assistant", "content": "Mock title"})
            # The turn being answered: the last user message that names a scenario.
            idx, scenario = -1, None
            for i, m in enumerate(msgs):
                if m.get("role") == "user":
                    for s in SCENARIOS:
                        if s in text_of(m.get("content")):
                            idx, scenario = i, s
            done = sum(1 for m in msgs[idx + 1:] if m.get("role") == "assistant" and m.get("tool_calls"))
            before = "\n".join(text_of(m.get("content")) + json.dumps(m.get("tool_calls") or "") for m in msgs[:idx])
            call = lambda cmd: {"role": "assistant", "content": None, "tool_calls": [
                {"id": f"call_{abs(hash(cmd)) % 10**8}_{done}", "type": "function", "function": {"name": "bash", "arguments": json.dumps({"command": cmd})}}]}
            tools = bool(req.get("tools"))
            if scenario == "scripted check":
                if done == 0 and tools:
                    return self.send_json(call("echo hello-from-tool"))
                if req.get("stream"):
                    return self.send_stream(["Check finished: ", "hello-from-tool ", "seen."])
                return self.send_json({"role": "assistant", "content": "Check finished: hello-from-tool seen."})
            if scenario == "earlier command":
                kept = "hello-from-tool" in before
                return self.send_json({"role": "assistant", "content": "History kept: hello-from-tool" if kept else "History missing"})
            if scenario == "slow job":
                if done == 0 and tools:
                    SLOW_STARTED.set()
                    return self.send_json(call("sleep 30"))
                return self.send_json({"role": "assistant", "content": "slow job finished"})
            if scenario == "after the cancel":
                return self.send_json({"role": "assistant", "content": f"After cancel: slow job in history={'sleep 30' in before}"})
            return self.send_json({"role": "assistant", "content": "unexpected request"})

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class Client:
    def __init__(self, cmd, env, cwd):
        self.p = subprocess.Popen(cmd, env=env, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(cwd, "acp-stderr.log"), "ab"), text=True, bufsize=1)
        self.q = queue.Queue()
        self.raw = []
        self.next_id = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            self.raw.append(line)
            try:
                self.q.put(json.loads(line))
            except ValueError:
                self.q.put({"__invalid__": line})
        self.q.put(None)

    def send(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()

    def request(self, method, params):
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        return self.next_id

    def notify(self, method, params):
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def wait(self, rid, timeout=60, on_update=None):
        """Collect notifications until the response to `rid`; returns (response, updates)."""
        updates, deadline = [], time.time() + timeout
        while time.time() < deadline:
            try:
                msg = self.q.get(timeout=max(0.05, deadline - time.time()))
            except queue.Empty:
                break
            if msg is None:
                raise RuntimeError("server closed stdout")
            if msg.get("method") == "session/update":
                u = msg["params"]["update"]
                updates.append(u)
                if on_update:
                    on_update(u)
            elif msg.get("id") == rid:
                return msg, updates
        raise TimeoutError(f"no response to request {rid}")

    def drain(self, seconds):
        out, deadline = [], time.time() + seconds
        while time.time() < deadline:
            try:
                msg = self.q.get(timeout=0.05)
            except queue.Empty:
                continue
            if msg and msg.get("method") == "session/update":
                out.append(msg["params"]["update"])
        return out


def chunks(updates, kind):
    return "".join(u["content"].get("text", "") for u in updates if u.get("sessionUpdate") == kind)


def proc_stats(pid):
    with open(f"/proc/{pid}/status") as f:
        st = dict(l.split(":", 1) for l in f if ":" in l)
    with open(f"/proc/{pid}/stat") as f:
        s = f.read()
    fields = s[s.rindex(")") + 2:].split()
    return int(st["VmRSS"].split()[0]), int(st["Threads"].strip()), int(fields[11]) + int(fields[12])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(ROOT, "agent-rs", "target", "release", "mini-agent-rs"))
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    srv = mock_server()
    tmp = tempfile.mkdtemp(prefix="acp-e2e-")
    home, work, cfg = (os.path.join(tmp, d) for d in ("home", "work", "cfg"))
    for d in (home, work, cfg):
        os.makedirs(d)
    mcp_script = os.path.join(tmp, "mcp_echo.py")
    with open(mcp_script, "w") as f:
        f.write(MCP_SERVER)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("MINI_AGENT_", "MINITUI_", "MSWEA_", "OPENAI_"))}
    env.update({
        "HOME": home, "MINI_AGENT_ACP_HOME": os.path.join(tmp, "sessions"),
        "MINITUI_MODEL": "openai/gpt-mock",
        "MSWEA_OPENAI_API_BASE": f"http://127.0.0.1:{srv.server_address[1]}/v1", "MSWEA_OPENAI_API_KEY": "mock",
        "MSWEA_GLOBAL_CONFIG_DIR": cfg, "MINI_AGENT_CU_MCP": "0",
        "MINI_AGENT_GOAL_ORACLE": "off", "MINI_AGENT_CACHE_WARMER": "off",
    })
    cmd = [args.bin, "acp"]
    c = Client(cmd, env, tmp)
    try:
        rid = c.request("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
        r, _ = c.wait(rid, 10)
        check("initialize: protocol 1, loadSession", r["result"]["protocolVersion"] == 1 and r["result"]["agentCapabilities"]["loadSession"] is True)

        rid = c.request("session/new", {"cwd": work, "mcpServers": [{"name": "echo", "command": sys.executable, "args": [mcp_script], "env": []}]})
        r, _ = c.wait(rid, 10)
        sid = r["result"]["sessionId"]
        opt = r["result"]["configOptions"][0]
        check("session/new: model option defaults to MINITUI_MODEL", opt["id"] == "model" and opt["category"] == "model" and opt["currentValue"] == "openai/gpt-mock", json.dumps(opt)[:300])

        time.sleep(2.0)
        rss, threads, ticks0 = proc_stats(c.p.pid)
        time.sleep(3.0)
        _, _, ticks1 = proc_stats(c.p.pid)
        idle = {"rss_kb": rss, "threads": threads, "cpu_ticks_3s": ticks1 - ticks0}
        print(f"idle server: {json.dumps(idle)}", flush=True)
        check("idle: one thread, no CPU", threads == 1 and ticks1 - ticks0 == 0, json.dumps(idle))

        rid = c.request("session/list", {})
        r, _ = c.wait(rid, 10)
        check("session/list: an unprompted session is not stored", all(s["sessionId"] != sid for s in r["result"]["sessions"]))

        # Turn 1: a bash tool call, then a streamed answer.
        rid = c.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "Run the scripted check in this directory"}]})
        r, ups = c.wait(rid, 60)
        calls = [u for u in ups if u["sessionUpdate"] == "tool_call"]
        results = [u for u in ups if u["sessionUpdate"] == "tool_call_update"]
        check("turn 1: stopReason end_turn", r.get("result", {}).get("stopReason") == "end_turn", json.dumps(r)[:400])
        check("turn 1: bash tool_call", len(calls) == 1 and calls[0]["kind"] == "execute" and calls[0]["title"] == "echo hello-from-tool" and calls[0]["rawInput"] == {"command": "echo hello-from-tool"}, json.dumps(calls)[:400])
        check("turn 1: tool_call_update completed with output", len(results) == 1 and results[0]["status"] == "completed" and "hello-from-tool" in results[0]["rawOutput"]["output"] and results[0]["toolCallId"] == calls[0]["toolCallId"], json.dumps(results)[:400])
        text = chunks(ups, "agent_message_chunk")
        n_chunks = sum(1 for u in ups if u["sessionUpdate"] == "agent_message_chunk")
        check("turn 1: answer text exactly once", text == "Check finished: hello-from-tool seen.", repr(text))
        print(f"turn 1: answer arrived in {n_chunks} chunk(s)", flush=True)
        check("turn 1: client MCP server reached the model", "mcp__echo__ping" in TOOLS_SEEN, sorted(t for t in TOOLS_SEEN if t)[:20])
        order = [u["sessionUpdate"] for u in ups if u["sessionUpdate"] in ("tool_call", "tool_call_update", "agent_message_chunk")]
        check("turn 1: tool call precedes the answer", order and order[0] == "tool_call" and order[-1] == "agent_message_chunk", order)

        # Turn 2: the conversation continues.
        rid = c.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "Quote the token printed by the earlier command"}]})
        r, ups2 = c.wait(rid, 60)
        check("turn 2: history kept", chunks(ups2, "agent_message_chunk") == "History kept: hello-from-tool" and r["result"]["stopReason"] == "end_turn", repr(chunks(ups2, "agent_message_chunk")))
        titles = [u["title"] for u in ups + ups2 if u["sessionUpdate"] == "session_info_update"]
        check("title: fallback then generated", titles[:1] == ["Run the scripted check in this directory"] and "Mock title" in titles, titles)

        # Turn 3: the `sleep 30` tool call is announced while the command runs (the agent's `act`
        # journal note), and that notification is the cue to cancel.
        t0 = time.time()
        rid = c.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "Start the slow job now"}]})
        shown = {}

        def cancel_on_announce(u):
            if u.get("sessionUpdate") == "tool_call" and u.get("title") == "sleep 30" and "at" not in shown:
                shown["at"] = time.time() - t0
                shown["status"] = u.get("status")
                c.notify("session/cancel", {"sessionId": sid})

        r, ups3 = c.wait(rid, 40, cancel_on_announce)
        took = time.time() - t0
        check("turn 3: the running command is shown before it returns", "at" in shown and shown["at"] < 15 and shown["status"] == "in_progress", shown)
        check("turn 3: cancelled during sleep", r.get("result", {}).get("stopReason") == "cancelled" and took < 15, f"{json.dumps(r)[:200]} after {took:.1f}s")
        announced = [u for u in ups3 if u.get("sessionUpdate") == "tool_call" and u.get("title") == "sleep 30"]
        check("turn 3: the tool call is announced once", len(announced) == 1, len(announced))

        time.sleep(0.5)
        sleeping = subprocess.run(["pgrep", "-x", "sleep", "-a"], capture_output=True, text=True).stdout
        check("turn 3: no `sleep 30` left behind", "sleep 30" not in sleeping, sleeping)

        # Turn 4: resumes after the cancelled turn.
        rid = c.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "Report state after the cancel"}]})
        r, ups4 = c.wait(rid, 60)
        check("turn 4: resumes with the cancelled turn in history", chunks(ups4, "agent_message_chunk") == "After cancel: slow job in history=True" and r["result"]["stopReason"] == "end_turn", repr(chunks(ups4, "agent_message_chunk")))

        c.p.stdin.close()
        code = c.p.wait(timeout=10)
        check("stdin EOF: server exits 0", code == 0, code)
        bad = [l for l in c.raw if not l.strip().startswith("{")]
        check("stdout carried only JSON-RPC", not bad, bad[:3])

        # A new server process: load replays from disk before answering.
        c = Client(cmd, env, tmp)
        rid = c.request("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
        c.wait(rid, 10)
        rid = c.request("session/load", {"sessionId": sid, "cwd": work, "mcpServers": []})
        r, replay = c.wait(rid, 20)
        users = [u["content"]["text"] for u in replay if u["sessionUpdate"] == "user_message_chunk"]
        check("load: replays the four prompts in order", users == ["Run the scripted check in this directory", "Quote the token printed by the earlier command", "Start the slow job now", "Report state after the cancel"], users)
        rtext = chunks(replay, "agent_message_chunk")
        check("load: replays answers and tool calls", "History kept: hello-from-tool" in rtext and "Check finished: hello-from-tool seen." in rtext
              and any(u["sessionUpdate"] == "tool_call" and u["title"] == "echo hello-from-tool" for u in replay), rtext[:300])
        check("load: replays the title", any(u["sessionUpdate"] == "session_info_update" and u["title"] == "Mock title" for u in replay))
        check("load: answers with config options", r["result"]["configOptions"][0]["currentValue"] == "openai/gpt-mock")
        rid = c.request("session/list", {"cwd": work})
        r, _ = c.wait(rid, 10)
        listed = [s for s in r["result"]["sessions"] if s["sessionId"] == sid]
        check("session/list: the session, with its title", len(listed) == 1 and listed[0].get("title") == "Mock title", r["result"])
        rid = c.request("session/set_config_option", {"sessionId": sid, "configId": "model", "value": "openai/gpt-other"})
        r, _ = c.wait(rid, 10)
        check("set_config_option: model switched", r["result"]["configOptions"][0]["currentValue"] == "openai/gpt-other")
        rid = c.request("session/prompt_nope", {})
        r, _ = c.wait(rid, 10)
        check("unknown method: -32601", r.get("error", {}).get("code") == -32601)
        rid = c.request("session/close", {"sessionId": sid})
        r, _ = c.wait(rid, 10)
        check("session/close", r.get("result") == {})
        c.p.stdin.close()
        check("second server exits 0", c.p.wait(timeout=10) == 0)

        # A client closes the server with SIGTERM: the running agent and its command go too.
        c = Client(cmd, env, tmp)
        rid = c.request("session/load", {"sessionId": sid, "cwd": work, "mcpServers": []})
        c.wait(rid, 20)
        SLOW_STARTED.clear()
        c.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "Start the slow job again"}]})
        SLOW_STARTED.wait(30)
        time.sleep(1.0)
        c.p.terminate()
        try:
            code = c.p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            code = None
        time.sleep(1.0)
        sleeping = subprocess.run(["pgrep", "-x", "sleep", "-a"], capture_output=True, text=True).stdout
        check("SIGTERM: server exits and takes the agent's command with it", code is not None and "sleep 30" not in sleeping, f"code={code} {sleeping}")
    finally:
        if c.p.poll() is None:
            c.p.kill()
        srv.shutdown()
        if args.keep:
            print(f"kept {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    failed = [n for n, ok in CHECKS if not ok]
    print(f"{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
