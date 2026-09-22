# Xiaomi MiMo models

[Xiaomi](https://xiaomimimo.com) serves its MiMo models behind an OpenAI-compatible
`/v1/chat/completions` surface (the MiMo Token Plan endpoint at
`https://token-plan-sgp.xiaomimimo.com`).

`mini` talks to it through the `xiaomi/` model-name prefix (bare `mimo-*` ids work too).

## Quick start

```bash
# See everything your key currently offers
mini-extra xiaomi-models

# ...or just one family
mini-extra xiaomi-models -f v2.6

# Run a task
mini -m xiaomi/mimo-v2.6-flash -t "Fix the failing test in test_utils.py"
```

To make it your default model:

```bash
mini-extra config set MSWEA_MODEL_NAME xiaomi/mimo-v2.6-flash
```

## How model names map

Take any id from `mini-extra xiaomi-models` (equivalently, from the `/v1/models`
endpoint) and prefix it with `xiaomi/`, or pass it bare:

| API id | Use with `mini -m` |
| --- | --- |
| `mimo-v2.6-pro` | `xiaomi/mimo-v2.6-pro` or `mimo-v2.6-pro` |
| `mimo-v2.6-flash` | `xiaomi/mimo-v2.6-flash` or `mimo-v2.6-flash` |

The `xiaomi/` prefix only controls routing inside `mini`; it is stripped before the
request is sent, so Xiaomi receives exactly the id it advertises.

The speech/audio ids (`*-asr`, `*-tts*`) are listed as well, but they cannot drive
the agent loop.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `XIAOMI_API_BASE` | `https://token-plan-sgp.xiaomimimo.com/v1` | API base URL |
| `XIAOMI_API_KEY` | (empty) | MiMo Token Plan API key |

Set them permanently with `mini-extra config set XIAOMI_API_KEY ...`, or per run as
normal environment variables.

Anything else can be passed straight through to litellm via `model_kwargs` in a
[yaml config file](../advanced/yaml_configuration.md); explicit values always win over
the defaults above:

```yaml
model:
  model_name: "xiaomi/mimo-v2.6-pro"
  model_kwargs:
    temperature: 0.0
```

There is also a ready-made [profile config](https://github.com/swe-agent/mini-swe-agent/blob/main/src/minisweagent/config/xiaomi.yaml):

```bash
mini -c mini.yaml -c xiaomi.yaml -t "Fix the failing test in test_utils.py"
```

## Notes and caveats

- **Cost tracking is off.** The token-plan endpoint reports no per-token prices, so
  `cost_tracking` defaults to `ignore_errors` for `xiaomi/` models and reported cost is
  always `0.0`. Other providers are unaffected.
- **MiMo ids are served by more than one gateway.** The same `mimo-*` ids also appear in
  the [OpenCode Go](opencode_go.md) catalog; that gateway is reached through the
  `opencode-go/` prefix, this one through `xiaomi/` (or bare ids).

## Checking the connection

```bash
curl -s https://token-plan-sgp.xiaomimimo.com/v1/models \
    -H "Authorization: Bearer $XIAOMI_API_KEY"
```

{% include-markdown "../_footer.md" %}
