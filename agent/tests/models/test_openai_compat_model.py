"""Direct OpenAI-compatible client: wire format, trajectory shape, errors, and no litellm."""

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from minisweagent.exceptions import FormatError
from minisweagent.models import get_model
from minisweagent.models.cliproxy_model import CliproxyModel
from minisweagent.models.openai_compat_model import OpenaiCompatAbortError, OpenaiCompatError


class _Gateway:
    """Tiny `/v1/chat/completions` stand-in: records requests, replays queued (status, body)."""

    def __init__(self):
        self.requests: list[dict] = []
        self.replies: list[tuple[int, dict]] = []
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"  # keep-alive, like real gateways

            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                gateway.requests.append(
                    {"path": self.path, "auth": self.headers.get("Authorization"), "body": body, "peer": self.client_address}
                )
                status, reply = gateway.replies.pop(0)
                data = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}/v1"


@pytest.fixture
def gateway(monkeypatch):
    g = _Gateway()
    monkeypatch.setenv("CLIPROXY_API_BASE", g.base)
    monkeypatch.setenv("CLIPROXY_API_KEY", "k-test")
    monkeypatch.setenv("MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT", "2")
    yield g
    g.server.shutdown()
    g.server.server_close()


def _completion(message: dict, finish_reason: str = "tool_calls") -> dict:
    return {
        "id": "c1",
        "model": "claude-opus-5-5",
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


TOOL_CALL = {"id": "call_1", "type": "function", "function": {"name": "bash", "arguments": '{"command": "ls -la"}'}}


def test_tool_call_round_trip(gateway, monkeypatch):
    gateway.replies.append((200, _completion({"role": "assistant", "content": "listing", "tool_calls": [TOOL_CALL]})))
    model = get_model("cliproxy/claude-opus-5-5", {"model_kwargs": {"drop_params": True, "temperature": 0.2}})
    assert isinstance(model, CliproxyModel)
    history = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "task", "extra": {"secret": 1}},
        {"role": "assistant", "content": "", "tool_calls": [TOOL_CALL], "provider_specific_fields": {}, "extra": {}},
        {"role": "tool", "tool_call_id": "call_1", "content": "out", "extra": {"raw_output": "out"}},
    ]
    message = model.query(history)

    sent = gateway.requests[0]
    assert sent["path"] == "/v1/chat/completions"
    assert sent["auth"] == "Bearer k-test"
    body = sent["body"]
    assert body["model"] == "claude-opus-5-5"  # routing prefix stripped
    assert body["temperature"] == 0.2
    assert "drop_params" not in body  # litellm-only knobs never reach the wire
    assert body["tools"][0]["function"]["name"] == "bash"
    # only protocol keys are sent: no `extra`, no provider_specific_fields
    assert all(set(m) <= {"role", "content", "tool_calls", "tool_call_id", "name"} for m in body["messages"])

    assert message["role"] == "assistant"
    assert message["tool_calls"][0]["id"] == "call_1"
    assert message["extra"]["actions"] == [{"command": "ls -la", "tool_call_id": "call_1"}]
    assert message["extra"]["cost"] == 0.0
    assert message["extra"]["response"]["usage"]["total_tokens"] == 15
    json.dumps(message)  # trajectory-serializable


def test_plain_text_is_the_final_answer(gateway):
    gateway.replies.append((200, _completion({"role": "assistant", "content": " all done "}, "stop")))
    message = get_model("cliproxy/claude-opus-5-5").query([{"role": "user", "content": "hi"}])
    assert message["extra"]["submission"] == "all done"
    assert message["extra"]["actions"] == []


def test_bad_tool_call_is_a_format_error_with_the_response(gateway):
    bad = {**TOOL_CALL, "function": {"name": "python", "arguments": "{}"}}
    gateway.replies.append((200, _completion({"role": "assistant", "content": None, "tool_calls": [bad]})))
    with pytest.raises(FormatError) as info:
        get_model("cliproxy/claude-opus-5-5").query([{"role": "user", "content": "hi"}])
    assert info.value.messages[0]["extra"]["response"]["id"] == "c1"


def test_client_errors_abort_at_once(gateway):
    gateway.replies.append((401, {"error": {"message": "bad key"}}))
    with pytest.raises(OpenaiCompatAbortError, match="bad key"):
        get_model("cliproxy/claude-opus-5-5").query([{"role": "user", "content": "hi"}])
    assert len(gateway.requests) == 1  # not retried


def test_transient_errors_are_retried(gateway, monkeypatch):
    monkeypatch.setattr("minisweagent.models.utils.retry.wait_exponential", lambda **_: (lambda *_a, **_k: 0))
    gateway.replies += [(503, {"error": "busy"}), (200, _completion({"role": "assistant", "content": "ok"}, "stop"))]
    message = get_model("cliproxy/claude-opus-5-5").query([{"role": "user", "content": "hi"}])
    assert message["extra"]["submission"] == "ok"
    assert len(gateway.requests) == 2


def test_unreachable_gateway_is_a_retryable_error(monkeypatch):
    monkeypatch.setenv("CLIPROXY_API_BASE", "http://127.0.0.1:9/v1")
    monkeypatch.setenv("MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT", "1")
    with pytest.raises(OpenaiCompatError) as info:
        get_model("cliproxy/claude-opus-5-5").query([{"role": "user", "content": "hi"}])
    assert not isinstance(info.value, OpenaiCompatAbortError)


def test_api_key_is_not_serialized(gateway):
    info = get_model("cliproxy/claude-opus-5-5").serialize()["info"]["config"]["model"]
    assert info["api_key"] == "***"


@pytest.mark.parametrize("name", ["cliproxy/claude-opus-5-5", "rosetta/zai-glm/glm-4.6", "xiaomi/mimo-v2.6-pro"])
def test_gateways_never_import_litellm(name):
    code = (
        "import sys; from minisweagent.models import get_model; "
        f"get_model({name!r}); print('litellm' in sys.modules, 'openai' in sys.modules)"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True, env={**os.environ, "MSWEA_SILENT_STARTUP": "1"})
    assert out.stdout.strip().splitlines()[-1] == "False False"


def test_steps_reuse_one_keep_alive_connection(gateway):
    for _ in range(3):
        gateway.replies.append((200, _completion({"role": "assistant", "content": "ok"}, "stop")))
    model = get_model("cliproxy/claude-opus-5-5")
    for _ in range(3):
        model.query([{"role": "user", "content": "hi"}])
    assert len({r["peer"] for r in gateway.requests}) == 1  # same client socket every step


def test_a_dropped_idle_connection_is_retried_transparently(gateway):
    gateway.replies += [(200, _completion({"role": "assistant", "content": "a"}, "stop"))] * 2
    model = get_model("cliproxy/claude-opus-5-5")
    model.query([{"role": "user", "content": "hi"}])
    model._conn.sock.close()  # the server's idle timeout closed our pooled socket
    model._conn.sock = __import__("socket").socket()  # a dead, unconnected socket in its place
    assert model.query([{"role": "user", "content": "hi"}])["extra"]["submission"] == "a"
