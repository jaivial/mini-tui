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


def test_manual_compact_via_control_file(tmp_path, monkeypatch):
    control = tmp_path / "control"
    control.write_text("")
    monkeypatch.setenv("MSWEA_CONTROL_FILE", str(control))
    model = ScriptedModel(steps=12, window=1_000_000)
    agent = make_agent(model)
    original = agent.execute_actions

    def with_compact(message):
        if model.calls == 8:
            control.write_text("COMPACT\n")
        return original(message)

    agent.execute_actions = with_compact
    agent._wait_for_control_followup = lambda: False
    assert agent.run("fix it")["submission"] == "done"
    compactions = [m for m in agent.messages if "compaction" in m.get("extra", {})]
    assert [c["extra"]["compaction"]["reason"] for c in compactions] == ["manual"]
    assert compactions[0]["extra"]["compaction"]["summarized_messages"] > 0
    # the next model call already sees the compacted view
    after = next(msgs for _, msgs in model.prompts if any("compaction" in m.get("extra", {}) for m in msgs) and msgs[-1]["content"] != cmp.SUMMARY_PROMPT)
    assert len(after) < 12


def test_manual_compact_on_a_tiny_conversation_is_skipped_with_a_marker(tmp_path, monkeypatch):
    control = tmp_path / "control"
    control.write_text("COMPACT\n")
    monkeypatch.setenv("MSWEA_CONTROL_FILE", str(control))
    agent = make_agent(ScriptedModel(steps=0))
    agent._wait_for_control_followup = lambda: False
    agent.run("fix it")
    assert any(m.get("extra", {}).get("interrupt_type") == "CompactionSkipped" for m in agent.messages)


def test_journal_reports_compacting_while_the_summary_runs(tmp_path):
    model = ScriptedModel(steps=30, window=30_000)
    agent = make_agent(model, reserve_tokens=2000)
    agent.config.output_path = tmp_path / "traj.json"
    seen = []
    real = model.query

    def query(messages, **kw):
        if messages[-1]["content"] == cmp.SUMMARY_PROMPT:
            infos = [json.loads(l)["i"] for l in (tmp_path / "traj.jsonl").read_text().splitlines() if '"t":"info"' in l]
            seen.append(infos[-1]["compacting"])
        return real(messages, **kw)

    model.query = query
    agent.run("fix it")
    assert seen and set(seen) == {"auto"}
    last_info = [json.loads(l)["i"] for l in (tmp_path / "traj.jsonl").read_text().splitlines() if '"t":"info"' in l][-1]
    assert last_info["compacting"] == ""


def test_messages_after_the_exit_wait_reach_the_journal(tmp_path, monkeypatch):
    """A follow-up (or a /compact result) that arrives while the agent waits at exit must be
    journaled: the TUI only sees the journal."""
    control = tmp_path / "control"
    control.write_text("")
    monkeypatch.setenv("MSWEA_CONTROL_FILE", str(control))
    model = ScriptedModel(steps=12, window=1_000_000)
    agent = make_agent(model)
    agent.config.output_path = tmp_path / "traj.json"
    waits = {"n": 0}

    def wait():
        waits["n"] += 1
        if waits["n"] == 1:
            control.write_text("COMPACT\n")
            agent._apply_control_commands()
            agent.add_messages(agent._user_task_message("and now the follow-up"))
            agent.save(agent.config.output_path, force=False)
            model.calls, model.steps = 0, 0  # next reply submits
            return True
        return False

    agent._wait_for_control_followup = wait
    agent.run("fix it")
    journal = [json.loads(l)["m"] for l in (tmp_path / "traj.jsonl").read_text().splitlines() if l.startswith('{"t":"msg"')]
    assert any("compaction" in m.get("extra", {}) for m in journal)
    assert any(m.get("content") == "The user added a new task: and now the follow-up" for m in journal)
    assert journal[-1]["role"] == "exit"


def test_followup_after_tool_call_gets_synthetic_result_before_user_message():
    """A queued TUI follow-up must not strand an assistant tool call."""
    model = ScriptedModel(steps=1, window=1_000_000)
    agent = make_agent(model)
    agent.add_messages(
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "call_orphan", "type": "function", "function": {"name": "bash", "arguments": "{}"}}
            ],
        }
    )
    agent.add_messages(agent._user_task_message("continue"))

    assert [m["role"] for m in agent.messages[-3:]] == ["assistant", "tool", "user"]
    repaired = agent.messages[-2]
    assert repaired["tool_call_id"] == "call_orphan"
    assert repaired["extra"]["interrupted"] is True
    assert "no result" in repaired["content"]


def test_followup_repair_closes_all_parallel_tool_calls_once():
    model = ScriptedModel(steps=0, window=1_000_000)
    agent = make_agent(model)
    agent.add_messages(
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "call_a", "type": "function", "function": {"name": "bash", "arguments": "{}"}},
                {"id": "call_b", "type": "function", "function": {"name": "bash", "arguments": "{}"}},
            ],
        }
    )
    agent.add_messages(agent._user_task_message("continue"))

    repairs = [m for m in agent.messages if m.get("extra", {}).get("interrupted")]
    assert [m["tool_call_id"] for m in repairs] == ["call_a", "call_b"]
    assert all(m["role"] == "tool" for m in repairs)
    assert agent.messages[-1]["role"] == "user"


def test_followup_does_not_add_a_second_result_for_an_answered_call():
    model = ScriptedModel(steps=0, window=1_000_000)
    agent = make_agent(model)
    agent.add_messages(
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "call_done", "type": "function", "function": {"name": "bash", "arguments": "{}"}}
            ],
        },
        {"role": "tool", "tool_call_id": "call_done", "content": "done"},
    )
    agent.add_messages(agent._user_task_message("continue"))

    assert not any(m.get("extra", {}).get("interrupted") for m in agent.messages)
    assert [m["role"] for m in agent.messages[-2:]] == ["tool", "user"]


def test_history_repair_preserves_an_existing_tool_result():
    model = ScriptedModel(steps=0, window=1_000_000)
    agent = make_agent(model)
    repaired = agent._repair_tool_call_history(
        [
            {
                "role": "assistant",
                "tool_calls": [
                    {"id": "call_answered", "type": "function", "function": {"name": "bash", "arguments": "{}"}}
                ],
            },
            {"role": "tool", "tool_call_id": "call_answered", "content": "done"},
            {"role": "user", "content": "next"},
        ]
    )
    assert [m.get("tool_call_id") for m in repaired if m.get("role") == "tool"] == ["call_answered"]
    assert not any(m.get("extra", {}).get("interrupted") for m in repaired)


def test_resume_repairs_a_boundary_already_followed_by_user_message():
    model = ScriptedModel(steps=0, window=1_000_000)
    agent = make_agent(model)
    agent.run(
        "continue",
        resume_messages=[
            {"role": "system", "content": "system"},
            {"role": "user", "content": "task"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {"id": "call_saved_boundary", "type": "function", "function": {"name": "bash", "arguments": "{}"}}
                ],
            },
            {"role": "user", "content": "The user added a new task: continue"},
        ],
    )

    repaired = next(m for m in agent.messages if m.get("tool_call_id") == "call_saved_boundary")
    assert repaired["role"] == "tool"
    assert repaired["extra"]["interrupted"] is True


def test_resume_repairs_orphaned_tool_call_before_followup():
    model = ScriptedModel(steps=0, window=1_000_000)
    agent = make_agent(model)
    agent.run(
        "continue",
        resume_messages=[
            {"role": "system", "content": "system"},
            {"role": "user", "content": "task"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {"id": "call_saved", "type": "function", "function": {"name": "bash", "arguments": "{}"}}
                ],
            },
            {"role": "user", "content": "The user added a new task: continue"},
        ],
    )

    repaired = next(m for m in agent.messages if m.get("tool_call_id") == "call_saved")
    assert repaired["role"] == "tool"
    assert repaired["extra"]["interrupted"] is True
    assert any(m.get("content") == "The user added a new task: continue" for m in agent.messages)
