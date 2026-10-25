from minisweagent.models.effort import apply_effort, apply_effort_from_env


def kwargs(model: str, effort: str) -> dict:
    config = {}
    apply_effort(model, effort, config)
    return config["model_kwargs"]


def test_provider_wire_vocabularies():
    assert kwargs("openai/gpt-6-astra", "high")["reasoning_effort"] == "high"
    assert kwargs("anthropic/claude-opus-5-5", "max")["output_config"] == {"effort": "max"}
    assert kwargs("cliproxy/claude-opus-5-5", "max")["reasoning_effort"] == "max"
    assert kwargs("openrouter/anthropic/claude-opus-5-5", "low")["reasoning"] == {"effort": "low"}
    assert kwargs("ollama/gpt-oss", "off")["think"] is False


def test_mandatory_reasoning_cannot_be_disabled():
    assert "thinking" not in kwargs("zai/glm-5.3", "off")
    assert "thinking" not in kwargs("moonshot/kimi-k3", "off")
    assert kwargs("zai/glm-5.3", "low")["reasoning_effort"] == "low"


def test_env_only_changes_the_exact_model(monkeypatch):
    monkeypatch.setenv("MINI_AGENT_MODEL_EFFORTS", '{"openai/gpt-6-astra":"xhigh"}')
    selected, other = {}, {}
    apply_effort_from_env("openai/gpt-6-astra", selected)
    apply_effort_from_env("openai/gpt-5.4", other)
    assert selected["model_kwargs"]["reasoning_effort"] == "xhigh"
    assert other == {}
