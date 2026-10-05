from minisweagent.models.connections import model_env

SAVED = [
    {"prefix": "minimax", "route": "native", "keyEnv": "MINIMAX_API_KEY", "key": "k1",
     "extraEnv": {"MINIMAX_API_BASE": "https://api.minimax.io/v1"}, "models": ["MiniMax-M3.1-Flash-Preview"]},
    {"prefix": "openai", "route": "openai-compat", "key": "k2", "baseUrl": "https://compat/v1", "models": ["m"]},
]


def test_native_connection_gives_key_and_base():
    assert model_env("minimax/MiniMax-M3.1-Flash-Preview", SAVED) == {
        "MINIMAX_API_KEY": "k1", "MINIMAX_API_BASE": "https://api.minimax.io/v1"}


def test_compat_connection_uses_openai_slot():
    env = model_env("openai/m", SAVED)
    assert env["MSWEA_OPENAI_API_KEY"] == "k2" and env["OPENAI_API_BASE"] == "https://compat/v1"


def test_unlisted_or_unknown_model_gives_nothing():
    assert model_env("minimax/Other", SAVED) == {} and model_env("rosetta/x", SAVED) == {}
