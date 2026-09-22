# Rosetta LLM gateway

[Rosetta](http://127.0.0.1:9120) is a local LLM gateway that fronts many upstream
providers behind one endpoint, speaking both the OpenAI `/v1/chat/completions`
and the Anthropic `/v1/messages` protocols.

`mini` talks to it through the `rosetta/` model-name prefix.

## Quick start

```bash
# See everything the gateway currently offers
mini-extra rosetta-models

# ...or just one family
mini-extra rosetta-models -f glm

# Run a task
mini -m rosetta/zai-glm/glm-4.6 -t "Fix the failing test in test_utils.py"
```

To make it your default model:

```bash
mini-extra config set MSWEA_MODEL_NAME rosetta/zai-glm/glm-4.6
```

## How model names map

Take any id from `mini-extra rosetta-models` (equivalently, from the gateway's
`/v1/models` endpoint) and prefix it with `rosetta/`:

| Gateway id | Use with `mini -m` |
| --- | --- |
| `zai-glm/glm-4.6` | `rosetta/zai-glm/glm-4.6` |
| `minimax/claude-minimax-m3` | `rosetta/minimax/claude-minimax-m3` |
| `deepseek-web/deepseek-chat` | `rosetta/deepseek-web/deepseek-chat` |

The `rosetta/` prefix only controls routing inside `mini`; it is stripped before
the request is sent, so the gateway receives exactly the id it advertises.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `ROSETTA_API_BASE` | `http://127.0.0.1:9120/v1` | Gateway base URL |
| `ROSETTA_API_KEY` | `rosetta-local` | Gateway API key |

Set them permanently with `mini-extra config set ROSETTA_API_BASE ...`, or per
run as normal environment variables.

Anything else can be passed straight through to litellm via `model_kwargs` in a
[yaml config file](../advanced/yaml_configuration.md); explicit values always win
over the defaults above:

```yaml
model:
  model_name: "rosetta/zai-glm/glm-4.6"
  model_kwargs:
    temperature: 0.0
    api_base: "http://my-other-host:9120/v1"
```

## Notes and caveats

- **Cost tracking is off.** Rosetta fronts local/subscription backends that do
  not report per-token prices, so `cost_tracking` defaults to `ignore_errors`
  for `rosetta/` models and reported cost is always `0.0`. Other providers are
  unaffected.
- **No Anthropic cache-control markers.** Many Rosetta ids contain `claude`
  (e.g. `rosetta/claude-codex/...`), but they are served over the OpenAI
  protocol, so `mini`'s usual "looks like Anthropic ⇒ enable cache control"
  heuristic is deliberately skipped. Pass `set_cache_control: default_end`
  explicitly if a particular backend supports it.
- **`drop_params` is enabled** by default, because Rosetta backends differ in
  which sampling parameters they accept.
- **Upstream availability varies.** A `rosetta/` model can fail with
  `upstream_error`, `Invalid API key` or a usage-limit error even though it is
  listed by `/v1/models`; that reflects the state of the upstream account behind
  the gateway, not your `mini` setup. Verify with:

  ```bash
  curl -s $ROSETTA_API_BASE/chat/completions \
    -H "content-type: application/json" -H "x-api-key: $ROSETTA_API_KEY" \
    -d '{"model":"zai-glm/glm-4.6","messages":[{"role":"user","content":"say OK"}],"max_tokens":8}'
  ```

{% include-markdown "../_footer.md" %}
