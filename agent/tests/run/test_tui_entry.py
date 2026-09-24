"""Tests for mini-tui's lightweight embedded runner."""

import json
import sys
from pathlib import Path

import pytest

from minisweagent.agents import get_agent
from minisweagent.agents.default import DefaultAgent
from minisweagent.environments import get_environment
from minisweagent.models import get_model
from minisweagent.run.config import build_run_config
from minisweagent.run.tui import UsageError, _parse_args, _run_cli_main


def test_shared_config_keeps_cli_override_precedence():
    config = build_run_config(
        ["mini.yaml"],
        task="new task",
        model_name="new/model",
        model_class="new/class",
        agent_class="new/agent",
        environment_class="new/env",
        yolo=True,
        cost_limit=0,
        output=Path("/tmp/out.json"),
        exit_immediately=True,
        config_loader=lambda spec: {
            "run": {"task": "old task"},
            "agent": {"mode": "confirm", "cost_limit": 9, "confirm_exit": True},
            "model": {"model_name": "old/model", "model_class": "old/class"},
            "environment": {"environment_class": "old/env"},
        },
    )
    assert config["run"]["task"] == "new task"
    assert config["agent"] == {
        "mode": "yolo",
        "cost_limit": 0,
        "confirm_exit": False,
        "output_path": Path("/tmp/out.json"),
        "agent_class": "new/agent",
    }
    assert config["model"] == {"model_name": "new/model", "model_class": "new/class"}
    assert config["environment"] == {"environment_class": "new/env"}


def test_parser_accepts_cli_shapes_and_rejects_unsafe_modes():
    options = _parse_args(
        [
            "-y",
            "--exit-immediately",
            "-o",
            "/tmp/traj.json",
            "-m",
            "model",
            "-c",
            "one",
            "-c",
            "two",
            "-t",
            "hello world",
        ]
    )
    assert options.task == "hello world"
    assert options.model_name == "model"
    assert options.configs == ["one", "two"]
    assert options.output == Path("/tmp/traj.json")
    assert options.yolo and options.exit_immediately

    assert _parse_args(["-y", "--task=hello"]).task == "hello"
    with pytest.raises(UsageError):
        _parse_args(["-t", "not-yolo"])
    with pytest.raises(UsageError):
        _parse_args(["-y"])
    with pytest.raises(UsageError):
        _parse_args(["-y", "-t"])


def test_embedded_runner_is_available_and_yolo_uses_noninteractive_agent(monkeypatch):
    monkeypatch.delenv("MSWEA_CONTROL_FILE", raising=False)
    assert "minisweagent.run.tui" in sys.modules
    model = get_model(
        "benchmark-model",
        {
            "model_class": "minisweagent.models.test_models.DeterministicModel",
            "outputs": [{"role": "assistant", "content": "done", "extra": {"actions": [], "submission": "done"}}],
        },
    )
    agent = get_agent(
        model,
        get_environment({}, default_type="local"),
        {"system_template": "system", "instance_template": "{{ task }}", "output_path": None},
        default_type="default",
    )
    assert isinstance(agent, DefaultAgent)
    result = agent.run("benchmark")
    assert result["exit_status"] == "Submitted"


def test_embedded_runner_uses_shared_config_and_writes_journal(tmp_path, monkeypatch):
    output = tmp_path / "traj.json"
    model_source = tmp_path / "embedded_model.py"
    model_source.write_text(
        "class Config:\n"
        "    def __init__(self, **kwargs): self.model_name = kwargs.get('model_name', 'embedded')\n"
        "    def model_dump(self, mode='python'): return {'model_name': self.model_name}\n"
        "class EmbeddedModel:\n"
        "    def __init__(self, **kwargs): self.config = Config(**kwargs)\n"
        "    def query(self, messages, **kwargs): return {'role': 'assistant', 'content': 'done', 'extra': {'actions': [], 'submission': 'done'}}\n"
        "    def format_message(self, **kwargs): return dict(kwargs)\n"
        "    def format_observation_messages(self, *args, **kwargs): return []\n"
        "    def get_template_vars(self, **kwargs): return {}\n"
        "    def serialize(self): return {'info': {'config': {'model_type': 'EmbeddedModel'}}}\n",
        encoding="utf-8",
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setenv("MSWEA_CONFIGURED", "1")
    monkeypatch.delenv("MSWEA_CONTROL_FILE", raising=False)
    agent = _run_cli_main(
        [
            "-y",
            "--exit-immediately",
            "--model-class",
            "embedded_model.EmbeddedModel",
            "-m",
            "embedded",
            "-o",
            str(output),
            "-c",
            str(Path(__file__).parents[2] / "src" / "minisweagent" / "config" / "mini.yaml"),
            "-t",
            "benchmark task",
        ]
    )
    data = json.loads(output.read_text(encoding="utf-8"))
    assert agent.messages[-1]["role"] == "exit"
    assert data["info"]["config"]["model_type"] == "EmbeddedModel"
    assert output.with_suffix(".jsonl").exists()
