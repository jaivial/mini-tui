"""Direct Messages API client: wire translation, response normalization, auth."""

from unittest.mock import patch

import pytest

from minisweagent.models.anthropic_compat_model import AnthropicCompatModel, to_anthropic_messages


def test_tool_calls_and_results_become_blocks():
    system, wire = to_anthropic_messages(
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "do it"},
            {
                "role": "assistant",
                "content": "ok",
                "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "bash", "arguments": '{"command": "ls"}'}}],
            },
            {"role": "tool", "tool_call_id": "c1", "content": "file.txt"},
        ]
    )
    assert system == [{"type": "text", "text": "sys"}]
    assert [m["role"] for m in wire] == ["user", "assistant", "user"]
    tool_use = wire[1]["content"][1]
    assert tool_use == {"type": "tool_use", "id": "c1", "name": "bash", "input": {"command": "ls"}}
    assert wire[2]["content"] == [{"type": "tool_result", "tool_use_id": "c1", "content": "file.txt"}]


def test_consecutive_tool_results_merge_into_one_user_turn():
    _, wire = to_anthropic_messages(
        [
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "c1", "function": {"name": "bash", "arguments": '{"command": "a"}'}},
                {"id": "c2", "function": {"name": "bash", "arguments": '{"command": "b"}'}},
            ]},
            {"role": "tool", "tool_call_id": "c1", "content": "A"},
            {"role": "tool", "tool_call_id": "c2", "content": "B"},
            {"role": "user", "content": "next"},
        ]
    )
    results = wire[1]["content"]
    assert [b["type"] for b in results] == ["tool_result", "tool_result", "text"]
    assert wire[-1]["content"][-1]["text"] == "next"


def test_consecutive_same_role_entries_merge():
    _, wire = to_anthropic_messages(
        [
            {"role": "user", "content": "one"},
            {"role": "user", "content": "two"},
        ]
    )
    assert len(wire) == 1
    assert [b["text"] for b in wire[0]["content"]] == ["one", "two"]


def test_thinking_blocks_replay_verbatim():
    _, wire = to_anthropic_messages(
        [
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "hmm", "signature": "sig"},
                    {"type": "text", "text": "answer"},
                ],
            }
        ]
    )
    assert wire[0]["content"][0] == {"type": "thinking", "thinking": "hmm", "signature": "sig"}


def test_cache_markers_ride_onto_the_blocks():
    _, wire = to_anthropic_messages([{"role": "user", "content": "hi", "cache_control": {"type": "ephemeral"}}])
    assert wire[0]["content"][0]["cache_control"] == {"type": "ephemeral"}


def _model(**kwargs):
    return AnthropicCompatModel(model_name="claude-test", api_base="http://anthropic.local/v1", api_key="sk-a", **kwargs)


def test_auth_headers_and_path():
    model = _model()
    assert model._auth_headers() == {"x-api-key": "sk-a", "anthropic-version": "2023-06-01"}
    captured = {}

    def fake_post(self, path, body, headers=None):
        captured.update(path=path, body=body, headers=headers)
        return {
            "content": [{"type": "tool_use", "id": "t1", "name": "bash", "input": {"command": "ls"}}],
            "stop_reason": "tool_use",
            "usage": {},
        }

    with patch.object(AnthropicCompatModel, "_post", fake_post):
        model.query([{"role": "user", "content": "hi"}])
    assert captured["path"] == "/messages"
    assert captured["body"]["max_tokens"]  # required by the Messages API


def test_normalize_maps_tool_use_and_stop_reason():
    model = _model()
    data = model._normalize(
        {
            "content": [
                {"type": "text", "text": "running"},
                {"type": "tool_use", "id": "t1", "name": "bash", "input": {"command": "ls"}},
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }
    )
    message = data["choices"][0]["message"]
    assert data["choices"][0]["finish_reason"] == "tool_use"
    assert message["content"] == "running"
    assert message["tool_calls"] == [
        {"id": "t1", "type": "function", "function": {"name": "bash", "arguments": '{"command": "ls"}'}}
    ]


def test_thinking_response_answers_without_tool_calls():
    model = _model()
    _, message = None, None
    captured = {}

    def fake_post(self, path, body, headers=None):
        return {
            "content": [
                {"type": "thinking", "thinking": "hmm", "signature": "s"},
                {"type": "text", "text": "the answer"},
            ],
            "stop_reason": "end_turn",
            "usage": {},
        }

    with patch.object(AnthropicCompatModel, "_post", fake_post):
        message = model.query([{"role": "user", "content": "hi"}])
    assert message["extra"]["submission"] == "the answer"
    assert message["extra"]["actions"] == []
    # thinking blocks stay on the message for replay
    assert message["content"][0]["type"] == "thinking"


def test_cost_comes_from_the_price_table():
    model = _model()
    with patch.object(AnthropicCompatModel, "_post", lambda self, path, body, headers=None: {
        "content": [{"type": "text", "text": "done"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 1_000_000, "output_tokens": 0},
    }):
        message = model.query([{"role": "user", "content": "hi"}])
    # claude-test has no price row -> 0.0
    assert message["extra"]["cost"] == 0.0


@pytest.mark.parametrize(("stop", "finish"), [("tool_use", "tool_use"), ("max_tokens", "length"), ("end_turn", "stop")])
def test_stop_reason_mapping(stop, finish):
    model = _model()
    data = model._normalize({"content": [], "stop_reason": stop, "usage": {}})
    assert data["choices"][0]["finish_reason"] == finish
