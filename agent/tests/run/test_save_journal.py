"""Trajectory persistence: append-only journal + throttled atomic full export."""

import json
import tempfile
from pathlib import Path

import yaml

from minisweagent.agents.default import DefaultAgent
from minisweagent.environments.local import LocalEnvironment
from minisweagent.models.test_models import DeterministicModel, make_output


def make_agent() -> DefaultAgent:
    config_path = Path("src/minisweagent/config/default.yaml")
    with open(config_path) as f:
        default_config = yaml.safe_load(f)["agent"]
    model = DeterministicModel(outputs=[make_output("echo 'test'", [])])
    env = LocalEnvironment()
    agent = DefaultAgent(model, env, **default_config)
    agent.add_messages({"role": "system", "content": "test system message"})
    agent.add_messages({"role": "user", "content": "test user message"})
    return agent


def read_journal(traj: Path) -> list[dict]:
    return [json.loads(line) for line in traj.with_suffix(".jsonl").read_text().splitlines() if line]


def test_journal_holds_every_message_and_info():
    with tempfile.TemporaryDirectory() as temp_dir:
        traj = Path(temp_dir) / "test_trajectory.json"
        agent = make_agent()
        agent.save(traj)

        entries = read_journal(traj)
        assert entries[0] == {"t": "meta", "trajectory_format": "mini-swe-agent-1.1"}
        assert [e["m"] for e in entries if e["t"] == "msg"] == agent.messages
        infos = [e["i"] for e in entries if e["t"] == "info"]
        assert infos[-1]["config"]["agent_type"] == "minisweagent.agents.default.DefaultAgent"

        agent.add_messages({"role": "assistant", "content": "more"})
        agent.save(traj)
        entries = read_journal(traj)
        assert len([e for e in entries if e["t"] == "meta"]) == 1  # never restarted
        assert len([e for e in entries if e["t"] == "msg"]) == len(agent.messages)  # appended, not rewritten


def test_full_export_is_complete_and_leaves_no_tmp():
    with tempfile.TemporaryDirectory() as temp_dir:
        traj = Path(temp_dir) / "test_trajectory.json"
        agent = make_agent()
        agent.save(traj)
        data = json.loads(traj.read_text())
        assert data["messages"] == agent.messages
        assert data["trajectory_format"] == "mini-swe-agent-1.1"
        assert not traj.with_name(traj.name + ".tmp").exists()


def test_force_false_throttles_the_export_but_not_the_journal():
    with tempfile.TemporaryDirectory() as temp_dir:
        traj = Path(temp_dir) / "test_trajectory.json"
        agent = make_agent()
        agent.save(traj, force=False)  # first save establishes the export
        export_size = traj.stat().st_size

        agent.add_messages({"role": "assistant", "content": "mid-run"})
        agent.save(traj, force=False)  # inside the throttle window: journal only
        assert traj.stat().st_size == export_size
        assert len([e for e in read_journal(traj) if e["t"] == "msg"]) == len(agent.messages)

        agent.add_messages(
            {"role": "exit", "content": "done", "extra": {"exit_status": "Submitted", "submission": "done"}}
        )
        agent.save(traj, force=False)  # run over: the export lands regardless of throttling
        data = json.loads(traj.read_text())
        assert data["messages"][-1]["content"] == "done"


def test_rerunning_with_the_same_path_restarts_the_journal():
    with tempfile.TemporaryDirectory() as temp_dir:
        traj = Path(temp_dir) / "test_trajectory.json"
        make_agent().save(traj)
        second = make_agent()
        second.save(traj)
        entries = read_journal(traj)
        assert len([e for e in entries if e["t"] == "meta"]) == 1
        assert len([e for e in entries if e["t"] == "msg"]) == len(second.messages)


def test_run_loop_writes_journal_end_to_end():
    """A whole run() through the step loop lands in the journal and in the final export."""
    with tempfile.TemporaryDirectory() as temp_dir:
        traj = Path(temp_dir) / "traj.json"
        config_path = Path("src/minisweagent/config/default.yaml")
        with open(config_path) as f:
            default_config = yaml.safe_load(f)["agent"]
        model = DeterministicModel(
            outputs=[
                make_output("running", [{"command": "echo hi"}]),
                {
                    "role": "assistant",
                    "content": "all done",
                    "extra": {"actions": [], "submission": "all done", "cost": 1.0},
                },
            ]
        )
        agent = DefaultAgent(model, LocalEnvironment(), **{**default_config, "output_path": traj})
        result = agent.run("a task")

        assert result["exit_status"] == "Submitted"
        assert result["submission"] == "all done"
        entries = read_journal(traj)
        assert [e["m"] for e in entries if e["t"] == "msg"] == agent.messages
        assert json.loads(traj.read_text())["messages"] == agent.messages  # export complete at run end
