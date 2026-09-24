import json

import pytest

from minisweagent.agents.default import DefaultAgent
from minisweagent.agents.utils import compaction as cmp
from minisweagent.models.errors import ProviderAbortError
from minisweagent.models.utils.cache_control import rolling_breakpoints, set_cache_control


class FakeEnv:
    def execute(self, action, cwd=""):
        return {"output": "x" * 4000, "returncode": 0, "exception_info": ""}

    def get_template_vars(self, **kw):
        return {}

    def serialize(self):
        return {}


class ScriptedModel:
    """Tool calls until `steps`, then submit. Reports prompt_tokens = chars/4 and fails like
    cli-proxy above `limit` tokens. Summary requests get a summary back."""

    def __init__(self, steps=40, limit=1_000_000, window=0):
        self.config = type("C", (), {"model_name": "cliproxy/test-model", "context_window": window})()
        self.steps, self.limit, self.calls, self.prompts = steps, limit, 0, []

    def _tokens(self, messages):
        return cmp.messages_chars(messages) // 4

    def query(self, messages, **kw):
        tokens = self._tokens(messages)
        self.prompts.append((tokens, messages))
        if tokens > self.limit:
            raise ProviderAbortError(f"HTTP 400 from x: prompt is too long: {tokens} tokens > {self.limit} maximum", 400)
        usage = {"prompt_tokens": tokens}
        if messages[-1]["content"] == cmp.SUMMARY_PROMPT:
            return {"role": "assistant", "content": "SUMMARY " + "s" * 400, "extra": {"response": {"usage": usage}}}
        self.calls += 1
        if self.calls > self.steps:
            return {"role": "assistant", "content": "done", "extra": {"submission": "done", "response": {"usage": usage}}}
        call_id = f"c{self.calls}"
        return {
            "role": "assistant",
            "content": f"step {self.calls}",
            "tool_calls": [{"id": call_id, "type": "function", "function": {"name": "bash", "arguments": "{}"}}],
            "extra": {"actions": [{"command": "ls", "tool_call_id": call_id}], "response": {"usage": usage}},
        }

    def format_message(self, **kw):
        return kw

    def format_observation_messages(self, message, outputs, template_vars=None):
        return [
            {"role": "tool", "tool_call_id": a["tool_call_id"], "content": o["output"]}
            for a, o in zip(message["extra"]["actions"], outputs)
        ]

    def get_template_vars(self, **kw):
        return {}

    def serialize(self):
        return {}


def make_agent(model, **compaction):
    return DefaultAgent(
        model,
        FakeEnv(),
        system_template="SYSTEM PROMPT",
        instance_template="Task: {{task}}",
        cost_limit=0,
        compaction={"enabled": True, **compaction},
    )


@pytest.fixture(autouse=True)
def learned_file(tmp_path, monkeypatch):
    monkeypatch.setattr(cmp, "LEARNED_WINDOWS_FILE", tmp_path / "windows.json")


def assert_valid_view(view):
    assert view[0]["role"] == "system" and view[1]["content"] == "Task: fix it"
    for i, m in enumerate(view):
        if m["role"] == "tool":
            prev_assistant = next(v for v in reversed(view[:i]) if v["role"] != "tool")
            assert prev_assistant["role"] == "assistant"
            assert m["tool_call_id"] in {c["id"] for c in prev_assistant.get("tool_calls", [])}


def test_auto_compaction_keeps_context_under_trigger():
    model = ScriptedModel(steps=60, window=40_000)
    agent = make_agent(model, reserve_tokens=2000)
    assert agent.run("fix it")["submission"] == "done"
    compactions = [m for m in agent.messages if "compaction" in m.get("extra", {})]
    assert len(compactions) >= 2
    trigger = agent._compaction_trigger()
    for tokens, messages in model.prompts:
        assert tokens <= trigger + 2000
        if messages[-1]["content"] != cmp.SUMMARY_PROMPT:
            assert_valid_view(messages)
    # the trajectory itself is never rewritten
    assert sum(1 for m in agent.messages if m["role"] == "tool") == 60


def test_views_are_append_only_between_compactions():
    """Prompt caching needs every request to extend the previous one."""
    model = ScriptedModel(steps=60, window=40_000)
    make_agent(model, reserve_tokens=2000).run("fix it")
    requests = [m for _, m in model.prompts if m[-1]["content"] != cmp.SUMMARY_PROMPT]
    breaks = 0
    for prev, cur in zip(requests, requests[1:]):
        if cur[: len(prev)] != prev:
            breaks += 1
            assert cur[:2] == prev[:2]  # the head always survives
            assert "compaction" in cur[2]["extra"]
    assert breaks >= 2


def test_summary_request_reuses_previous_prefix():
    model = ScriptedModel(steps=30, window=40_000)
    make_agent(model, reserve_tokens=2000).run("fix it")
    for i, (_, messages) in enumerate(model.prompts):
        if messages[-1]["content"] == cmp.SUMMARY_PROMPT:
            previous = model.prompts[i - 1][1]
            assert messages[: len(previous)] == previous


def test_overflow_error_compacts_and_learns_window(tmp_path):
    # Metadata says 10M, the provider really takes 20k: the first overflow must recover.
    model = ScriptedModel(steps=40, window=10_000_000, limit=20_000)
    agent = make_agent(model)
    assert agent.run("fix it")["submission"] == "done"
    assert json.loads(cmp.LEARNED_WINDOWS_FILE.read_text()) == {"cliproxy/test-model": 20_000}
    assert cmp.context_window_for(model) == 20_000
    reasons = [m["extra"]["compaction"]["reason"] for m in agent.messages if "compaction" in m.get("extra", {})]
    assert reasons[0] == "overflow" and "auto" in reasons[1:]


def test_user_followups_survive_compaction():
    model = ScriptedModel(steps=50, window=30_000)
    agent = make_agent(model, reserve_tokens=2000)
    original = agent.execute_actions

    def with_followup(message):
        if model.calls == 3:
            agent.add_messages(agent._user_task_message("ALSO deploy to staging"))
        return original(message)

    agent.execute_actions = with_followup
    agent.run("fix it")
    last = [m for m in agent.messages if "compaction" in m.get("extra", {})][-1]
    assert "ALSO deploy to staging" in last["content"]


def test_resume_keeps_compacted_view():
    model = ScriptedModel(steps=30, window=30_000)
    agent = make_agent(model, reserve_tokens=2000)
    agent.run("fix it")
    before = agent.context_messages()
    resumed = make_agent(ScriptedModel(steps=0, window=30_000), reserve_tokens=2000)
    resumed.run("next", resume_messages=agent.messages)
    after = resumed.context_messages()
    assert after[: len(before)] == before
    assert after[len(before)]["content"] == "The user added a new task: next"


def test_disabled_compaction_sends_everything():
    model = ScriptedModel(steps=10, window=5_000)
    agent = make_agent(model, enabled=False)
    agent.run("fix it")
    assert not any("compaction" in m.get("extra", {}) for m in agent.messages)
    assert model.prompts[-1][1] == agent.messages[:-2]  # everything but the final reply + exit


def test_failed_summary_falls_back():
    model = ScriptedModel(steps=30, window=30_000)
    real = model.query

    def query(messages, **kw):
        if messages[-1]["content"] == cmp.SUMMARY_PROMPT:
            raise RuntimeError("boom")
        return real(messages, **kw)

    model.query = query
    agent = make_agent(model, reserve_tokens=2000)
    assert agent.run("fix it")["submission"] == "done"
    assert any("Automatic summary unavailable" in m["content"] for m in agent.messages if "compaction" in m.get("extra", {}))


def test_known_windows():
    fake = lambda name: type("M", (), {"config": type("C", (), {"model_name": name})()})()
    assert cmp.context_window_for(fake("cliproxy/claude-opus-5-5")) == 1_000_000
    assert cmp.context_window_for(fake("cliproxy/claude-3-7-sonnet-20250219")) == 200_000
    assert cmp.is_context_overflow(ProviderAbortError("prompt is too long: 1000243 tokens > 1000000 maximum"))
    assert not cmp.is_context_overflow(ProviderAbortError("HTTP 401 invalid key"))


def test_rolling_breakpoints():
    msgs = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "task"},
        {"role": "assistant", "content": "a1"},
        {"role": "tool", "content": "t1"},
        {"role": "user", "content": "[Context compacted: ...]"},
        {"role": "assistant", "content": [{"type": "thinking", "thinking": "x"}, {"type": "text", "text": "a2"}]},
        {"role": "tool", "content": "t2"},
        {"role": "tool", "content": "t3"},
    ]
    assert rolling_breakpoints(msgs) == [1, 4, 7] or rolling_breakpoints(msgs) == [1, 4, 4, 7]
    out = set_cache_control(msgs, mode="rolling", ttl="1h")
    marked = [i for i, m in enumerate(out) if "cache_control" in json.dumps(m)]
    assert marked == rolling_breakpoints(msgs)
    assert out[1]["content"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    assert out[7]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    assert "cache_control" not in json.dumps(msgs)  # input untouched
    assert len(rolling_breakpoints(msgs)) <= 4


def test_single_huge_output_is_elided_after_overflow():
    model = ScriptedModel(steps=4, window=10_000_000, limit=20_000)
    agent = make_agent(model)
    huge = {"n": 0}
    original = agent.env.execute

    def execute(action, cwd=""):
        huge["n"] += 1
        out = original(action)
        return {**out, "output": "y" * 200_000} if huge["n"] == 2 else out

    agent.env.execute = execute
    assert agent.run("fix it")["submission"] == "done"
    assert all(tokens <= 20_000 for tokens, _ in model.prompts[-3:])
    assert any(m["role"] == "tool" and len(m["content"]) == 200_000 for m in agent.messages)  # log intact
