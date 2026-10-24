#!/usr/bin/env python3
"""A scripted OpenAI-compatible chat server for stress-testing the work queue without API spend.

Role detection reads the system prompt:
  * dispatcher: the human's last message decides. Commands it understands (one per message):
      CREATE <n> [sleep=<s>] [fail] [tag=<t>]   -> task_create with n tasks (each a worker script)
      REDIRECT <tid> <text>                     -> task_redirect
      CANCEL <tid>                              -> task_cancel
      STATUS                                    -> task_status
      DUP <text>                                -> task_create one task whose title is <text>
    anything else -> a plain-text reply.
  * worker: the brief's directives drive it:
      SLEEP=<s>  -> a bash `sleep <s>` turn first
      FAIL       -> the run errors (the model returns HTTP 400 abort)
      UPDATE     -> calls task_update
      NOTIFY     -> calls task_notify
    then a bash `echo done`, then a final text answer. A [redirect ...] message in the history
    makes the final answer mention REDIRECTED.
Stats at GET /stats: requests, concurrent in-flight peak.
"""
import json, re, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
STATS = {"requests": 0, "inflight": 0, "peak": 0, "dispatcher": 0, "worker": 0}
DELAY = float(sys.argv[2]) if len(sys.argv) > 2 else 0.05


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def tool_call(name, args):
    return {"id": "call_" + uuid.uuid4().hex[:12], "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def reply(content=None, calls=None):
    msg = {"role": "assistant", "content": content}
    if calls:
        msg["tool_calls"] = calls
    return {"id": "x", "object": "chat.completion", "model": "mock", "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if calls else "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}


def clean(t):
    t = re.sub(r"^The user added a new task:\s*", "", t)
    return re.sub(r"\s*<queue_state>[\s\S]*$", "", t).strip()


def pending_humans(messages):
    """Every human message since the assistant last spoke (several can arrive in one turn)."""
    out = []
    for m in reversed(messages):
        if m.get("role") == "assistant":
            break
        if m.get("role") == "user":
            out.append(clean(text_of(m.get("content"))))
    return list(reversed(out))


def last_human(messages):
    for m in reversed(messages):
        if m.get("role") == "user":
            return clean(text_of(m.get("content")))
    return ""


def dispatcher(messages):
    if messages[-1].get("role") == "tool":
        return reply("ok")  # the harness ends the turn itself on success; this covers failures
    humans = pending_humans(messages)
    creates = [h for h in humans if h.startswith("CREATE ")]
    if creates:
        tasks = []
        for h in creates:
            m = re.match(r"CREATE (\d+)(.*)", h)
            n, opts = int(m.group(1)), m.group(2)
            sleep = re.search(r"sleep=([\d.]+)", opts)
            tag = re.search(r"tag=(\S+)", opts)
            fail = " fail" in opts
            for i in range(n):
                directive = f"SLEEP={sleep.group(1) if sleep else 0}" + (" FAIL" if fail else "") + " UPDATE"
                tasks.append({"title": f"{tag.group(1) if tag else 'job'} {i} {uuid.uuid4().hex[:6]}", "description": f"stress task {i}",
                              "prompt": f"{directive}\nunique {uuid.uuid4().hex}"})
        return reply(None, [tool_call("task_create", {"tasks": tasks} if len(tasks) > 1 else tasks[0])])
    h = last_human(messages)
    m = re.match(r"DUP (.*)", h, re.S)
    if m:
        return reply(None, [tool_call("task_create", {"title": m.group(1)[:60], "description": m.group(1)[:200], "prompt": m.group(1) + "\nSLEEP=3"})])
    m = re.match(r"REDIRECT (\S+) (.*)", h, re.S)
    if m:
        return reply(None, [tool_call("task_redirect", {"id": m.group(1), "message": m.group(2)})])
    m = re.match(r"CANCEL (\S+)", h)
    if m:
        return reply(None, [tool_call("task_cancel", {"id": m.group(1)})])
    if h.startswith("STATUS"):
        if messages[-1].get("role") == "tool":
            return reply("status read")
        return reply(None, [tool_call("task_status", {})])
    return reply(f"plain answer to: {h[:80]}")


def worker(messages):
    brief = "\n".join(text_of(m.get("content")) for m in messages if m.get("role") == "user")
    sleep = re.search(r"SLEEP=([\d.]+)", brief)
    tool_turns = sum(1 for m in messages if m.get("role") == "assistant" and m.get("tool_calls"))
    redirected = "[redirect from the dispatcher]" in brief
    if "FAIL" in brief.split("unique")[0] and tool_turns == 0:
        return None  # -> 400 abort
    plan = []
    if sleep and float(sleep.group(1)) > 0:
        plan.append(tool_call("bash", {"command": f"sleep {sleep.group(1)}"}))
    if "UPDATE" in brief:
        plan.append(tool_call("task_update", {"description": "working on it (mock)"}))
    if "NOTIFY" in brief:
        plan.append(tool_call("task_notify", {"message": "mock worker note"}))
    plan.append(tool_call("bash", {"command": "echo done"}))
    if tool_turns < len(plan):
        return reply(None, [plan[tool_turns]])
    return reply("DONE" + (" REDIRECTED" if redirected else "") + f" after {tool_turns} steps")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps(STATS).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        req = json.loads(self.rfile.read(n) or b"{}")
        with LOCK:
            STATS["requests"] += 1
            STATS["inflight"] += 1
            STATS["peak"] = max(STATS["peak"], STATS["inflight"])
        try:
            time.sleep(DELAY)
            msgs = req.get("messages", [])
            system = text_of(msgs[0].get("content")) if msgs else ""
            names = [t.get("function", {}).get("name") for t in req.get("tools", [])]
            if "task_create" in names:
                STATS["dispatcher"] += 1
                out = dispatcher(msgs)
            elif system.startswith("Write a short title") or "title" in text_of(msgs[-1].get("content", ""))[:40].lower() and not names:
                out = reply("Mock title")
            else:
                STATS["worker"] += 1
                out = worker(msgs)
            if out is None:
                body = json.dumps({"error": {"message": "mock forced failure"}}).encode()
                self.send_response(400)
            else:
                body = json.dumps(out).encode()
                self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        finally:
            with LOCK:
                STATS["inflight"] -= 1


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4499
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
