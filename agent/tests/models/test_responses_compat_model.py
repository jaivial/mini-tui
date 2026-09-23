"""Direct Responses API client: replay flattening, trajectory shape, observations."""

from unittest.mock import patch

import pytest

from minisweagent.exceptions import FormatError
from minisweagent.models.responses_compat_model import ResponsesCompatModel


def _model(**kwargs):
    return ResponsesCompatModel(model_name="gpt-test", api_base="http://openai.local/v1", api_key="sk-o", **kwargs)


def _reply(*, calls=True):
    output = [
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "running"}]},
    ]
    if calls:
        output.append({"type": "function_call", "call_id": "c1", "name": "bash", "arguments": '{"command": "ls"}'})
    return {"object": "response", "output": output, "status": "completed", "usage": {"input_tokens": 1, "output_tokens": 1}}


def test_stored_responses_flatten_back_into_output_items():
    model = _model()
    stored = _reply()
    stored["extra"] = {"actions": []}
    prepared = model._prepare_messages_for_api(
        [
            {"role": "system", "content": "sys"},
            stored,
            {"type": "function_call_output", "call_id": "c1", "output": "file.txt", "extra": {"returncode": 0}},
        ]
    )
    assert prepared[0] == {"role": "system", "content": "sys"}
    # the response object becomes its raw output items, extras stripped
    assert prepared[1]["type"] == "message"
    assert prepared[2]["type"] == "function_call"
    assert prepared[3] == {"type": "function_call_output", "call_id": "c1", "output": "file.txt"}


def test_query_posts_to_responses_and_keeps_the_trajectory_shape():
    model = _model()
    captured = {}

    def fake_post(self, path, body, headers=None):
        captured.update(path=path, body=body)
        return _reply()

    with patch.object(ResponsesCompatModel, "_post", fake_post):
        message = model.query([{"role": "user", "content": "hi"}])
    assert captured["path"] == "/responses"
    assert captured["body"]["tools"][0]["name"] == "bash"
    # the stored message IS the response (object/output), plus extra.actions
    assert message["object"] == "response"
    assert message["extra"]["actions"] == [{"command": "ls", "tool_call_id": "c1"}]
    assert message["extra"]["cost"] >= 0.0
    assert "submission" not in message["extra"]


def test_missing_tool_calls_raise_format_error_with_response_persisted():
    model = _model()
    with patch.object(ResponsesCompatModel, "_post", lambda self, path, body, headers=None: _reply(calls=False)):
        with pytest.raises(FormatError) as exc:
            model.query([{"role": "user", "content": "hi"}])
    extra = exc.value.messages[0]["extra"]
    assert extra["interrupt_type"] == "FormatError"
    assert extra["response"]["object"] == "response"
    assert extra["cost"] >= 0.0


def test_observations_are_function_call_outputs():
    model = _model()
    [msg] = model.format_observation_messages(
        {"extra": {"actions": [{"command": "ls", "tool_call_id": "c1"}]}},
        [{"output": "file.txt", "returncode": 0, "exception_info": ""}],
    )
    assert msg["type"] == "function_call_output"
    assert msg["call_id"] == "c1"
    assert "file.txt" in msg["output"]
    assert msg["extra"]["returncode"] == 0
