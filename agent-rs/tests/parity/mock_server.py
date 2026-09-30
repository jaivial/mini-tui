"""A scripted LLM server for the wire-protocol parity tests.

Speaks OpenAI chat completions (streamed as SSE, or plain JSON), the Anthropic Messages API and
the OpenAI Responses API. Replies come from a JSON script: one entry per request, in order,
per client (keyed by the `X-Parity-Client` header, so the Python and Rust runs each get their
own copy). Every request body is recorded so the two agents' requests can be compared too.

    python3 mock_server.py <script.json> <port> <record-dir>
"""
import json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

script = json.load(open(sys.argv[1]))
port = int(sys.argv[2])
record = sys.argv[3]
counters = {}
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        client = self.headers.get("X-Parity-Client") or self.headers.get("x-parity-client") or "?"
        with lock:
            n = counters.get(client, 0)
            counters[client] = n + 1
        headers = {k.lower(): v for k, v in self.headers.items()}
        with open(os.path.join(record, f"{client}-{n:02d}.json"), "w") as f:
            json.dump({"path": self.path, "body": body,
                       "auth": headers.get("authorization") or headers.get("x-api-key"),
                       "anthropic_version": headers.get("anthropic-version"),
                       "session": headers.get("x-opencode-session", "")[:15],
                       "has_request_id": "x-request-id" in headers}, f, indent=1, sort_keys=True)
        step = script[n] if n < len(script) else {"status": 500, "json": {"error": "script exhausted"}}
        if "status" in step:
            data = json.dumps(step["json"]).encode()
            self.send_response(step["status"])
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True
            return
        if "sse" in step:
            chunks = step["sse"]
            payload = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
            data = payload.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True
            return
        data = json.dumps(step["json"]).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True


ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
