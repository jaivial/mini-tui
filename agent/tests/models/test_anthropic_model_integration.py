"""Test that cache control is actually applied when using anthropic models through get_model()."""

from unittest.mock import patch

import pytest

from minisweagent.models import get_model


def _messages_reply():
    """A Messages API response with a bash tool call (the agent loop needs one)."""
    return {
        "content": [
            {"type": "text", "text": "I can help!"},
            {"type": "tool_use", "id": "call_1", "name": "bash", "input": {"command": "echo test"}},
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 10, "output_tokens": 5},
    }


def _capture_query(model, messages, reply=None):
    """Run one query against a stubbed transport; return (wire path, wire body, message)."""
    captured = {}

    def fake_post(self, path, body, headers=None):
        captured["path"] = path
        captured["body"] = body
        return _messages_reply() if reply is None else reply

    with patch.object(type(model), "_post", fake_post):
        message = model.query(messages)
    return captured, message


def test_sonnet_4_cache_control_integration():
    """get_model('sonnet-4') must apply cache control to the wire messages."""
    messages = [
        {"role": "user", "content": "Hello, how are you?"},
        {"role": "assistant", "content": "I'm doing well!"},
        {"role": "user", "content": "Can you help me with coding?"},
    ]
    model = get_model("sonnet-4")
    captured, _ = _capture_query(model, messages)
    assert captured["path"] == "/messages"
    sent = captured["body"]["messages"]
    assert len(sent) == 3
    assert sent[0]["content"][0]["text"] == "Hello, how are you?"
    # rolling breakpoints: end of the head (= end of the previous step here) and the last message
    assert sent[0]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in sent[1]["content"][0]
    last = sent[2]["content"][0]
    assert last["type"] == "text"
    assert last["text"] == "Can you help me with coding?"
    assert last["cache_control"] == {"type": "ephemeral"}


@pytest.mark.parametrize(
    "model_name",
    [
        "sonnet-4",
        "claude-sonnet",
        "anthropic/claude",
        "opus-latest",
    ],
)
def test_get_model_anthropic_applies_cache_control(model_name):
    """Using get_model with anthropic names routes to the Messages API with markers."""
    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"},
        {"role": "assistant", "content": "Hi there!"},
        {"role": "user", "content": "Help me code."},
    ]
    model = get_model(model_name)
    captured, _ = _capture_query(model, messages)
    body = captured["body"]
    assert body["system"][0]["text"] == "You are a helpful assistant."
    sent = body["messages"]
    assert [m["role"] for m in sent] == ["user", "assistant", "user"]
    assert sent[-1]["content"][0].get("cache_control") == {"type": "ephemeral"}


def test_wire_model_name_is_bare():
    model = get_model("anthropic/claude-sonnet-4-5")
    captured, _ = _capture_query(model, [{"role": "user", "content": "hi"}])
    assert captured["body"]["model"] == "claude-sonnet-4-5"


def test_plain_text_response_becomes_a_submission():
    model = get_model("sonnet-4")
    _, message = _capture_query(
        model,
        [{"role": "user", "content": "hi"}],
        reply={"content": [{"type": "text", "text": "Final answer."}], "stop_reason": "end_turn", "usage": {}},
    )
    assert message["extra"]["submission"] == "Final answer."
    assert message["extra"]["actions"] == []
