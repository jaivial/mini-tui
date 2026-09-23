"""The task reaches the journal before the first model call, and replies carry timing."""

from pathlib import Path

import pytest

from minisweagent.agents.default import DefaultAgent
from minisweagent.environments import get_environment

TEMPLATE = "Please solve this issue: {{ task }}\n\nYou can execute bash commands"


class ProbeModel:
    """One scripted reply; asserts what the journal already holds at query time."""

    def __init__(self, journal: Path, expect_in_journal: str):
        self.journal = journal
        self.expect = expect_in_journal
        self.checked = False

    def query(self, messages, **kwargs):
        assert self.expect in self.journal.read_text(), "the prompt must be journaled before the first model call"
        self.checked = True
        return {"role": "assistant", "content": "done", "extra": {"actions": [], "cost": 0.0, "submission": "done"}}

    def format_message(self, **kwargs):
        return dict(kwargs)

    def format_observation_messages(self, message, outputs, template_vars=None):
        return []

    def get_template_vars(self, **kwargs):
        return {}

    def serialize(self):
        return {"info": {"config": {"model": {"model_name": "probe"}, "model_type": "probe"}}}


def _agent(tmp_path, model):
    return DefaultAgent(
        model,
        get_environment({}, default_type="local"),
        system_template="system",
        instance_template=TEMPLATE,
        output_path=tmp_path / "traj.json",
    )


def test_task_is_journaled_before_the_first_model_call(tmp_path, monkeypatch):
    monkeypatch.delenv("MSWEA_CONTROL_FILE", raising=False)  # no exit hold without a TUI
    model = ProbeModel(tmp_path / "traj.jsonl", "my task here")
    agent = _agent(tmp_path, model)
    result = agent.run("my task here")
    assert model.checked
    assert result["exit_status"] == "Submitted"
    assistant = next(m for m in agent.messages if m["role"] == "assistant")
    assert isinstance(assistant["extra"]["thinking_seconds"], float)  # "Thought for {n} seconds"


def test_control_followups_are_journaled_immediately(tmp_path, monkeypatch):
    control = tmp_path / "control"
    control.write_text('MESSAGE "follow-up word"\n')
    monkeypatch.setenv("MSWEA_CONTROL_FILE", str(control))
    model = ProbeModel(tmp_path / "traj.jsonl", "follow-up word")
    agent = _agent(tmp_path, model)
    agent._apply_control_commands()
    assert model.checked is False  # no model call \u2014 just the control drain and the save
    assert "follow-up word" in (tmp_path / "traj.jsonl").read_text()
