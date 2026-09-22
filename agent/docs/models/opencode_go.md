# OpenCode Go

[OpenCode Go](https://opencode.ai/docs/go/) is a low cost subscription ($10/month) that
gives stable access to a curated set of open coding models through one gateway,
`https://opencode.ai/zen/go/v1`. `mini` talks to it through the `opencode-go/`
model-name prefix, which routes every id to the endpoint flavor the gateway documents
for it (see the [`Endpoints` table](https://opencode.ai/docs/go/#endpoints)):

| Endpoint | API | Models |
| --- | --- | --- |
| `/chat/completions` | OpenAI compatible | GLM, Kimi, LongCat, DeepSeek, MiMo, Hy |
| `/messages` | Anthropic compatible | MiniMax, Qwen, Union Alpha |
| `/responses` | OpenAI Responses API | Grok 4.6, GPT 5.6 Luna, Muse Spark |

## Quick start

```bash
# See what your key currently offers, with endpoint and prices
mini-extra opencode-go-models

# Run a task
mini -m opencode-go/glm-5.3-flash -t "Fix the failing test in test_utils.py"
mini -m opencode-go/kimi-k3 -t "Fix the failing test in test_utils.py"
mini -m opencode-go/minimax-m3 -t "Fix the failing test in test_utils.py"
mini -m opencode-go/grok-4.6 -t "Fix the failing test in test_utils.py"
```

There is no need to pick a model class: `opencode-go/...` ids select the right one
(`OpencodeGoModel`, or `OpencodeGoResponseModel` for `/responses` ids) and the right
litellm provider (`openai` for the OpenAI compatible endpoints, `anthropic` for the
`/messages` one, which needs the `x-api-key` header).

To make a Go model your default:

```bash
mini-extra config set MSWEA_MODEL_NAME opencode-go/glm-5.3-flash
```

or use the bundled profile, which only pins the model and a cost limit:

```bash
mini -c mini.yaml -c opencode_go.yaml -t "Fix the failing test in test_utils.py"
```

### Muse Spark 1.3 Contributor

Use **`opencode-go/muse-spark-1.3-contributor`**, with a dot in `1.3`
(not `muse-spark-1-3-contributor`). To override the bundled profile's default model:

```bash
mini -c mini.yaml -c opencode_go.yaml -m opencode-go/muse-spark-1.3-contributor -t "Fix the failing test in test_utils.py"
```

For a YAML configuration, set `model.model_name` to
`opencode-go/muse-spark-1.3-contributor`. The prefix automatically selects the
Responses API adapter; no explicit model class is needed.

## Configuration

`mini` reads the key from `OPENCODE_GO_API_KEY`. Set it permanently with:

```bash
mini-extra config set OPENCODE_GO_API_KEY sk-your-key
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `OPENCODE_GO_API_KEY` | *(unset)* | OpenCode Go API key |
| `OPENCODE_GO_API_BASE` | `https://opencode.ai/zen/go/v1` | API base URL for the OpenAI compatible endpoints |
| `OPENCODE_GO_ANTHROPIC_API_BASE` | *(derived from the base above)* | Base URL for the `/messages` endpoint (litellm appends `/v1/messages`) |
| `OPENCODE_GO_SESSION` | *(random per run)* | Value of the mandatory `x-opencode-session` header |

`api_base`, `api_key` and `extra_headers` can also be set per model through
`model_kwargs` in a [yaml config file](../advanced/yaml_configuration.md); explicit
values always win over the defaults above:

```yaml
model:
  model_name: "opencode-go/kimi-k3"
  model_kwargs:
    temperature: 0.0
    api_base: "https://my-go-compatible-host/v1"
```

## Models, endpoints and prices

Every id below comes from the `Endpoints` table of the
[Go documentation](https://opencode.ai/docs/go/#endpoints); prices and included monthly
budgets come from the same page (per 1M tokens, `a / b` marks the price above the tier
threshold, e.g. Grok 4.6 above 200K input tokens).

<!-- BEGIN GENERATED: mini-extra opencode-go-models prints the live version of this table -->

This is mini-swe-agent version 2.4.6.
Check the v2 migration guide at https://klieret.short.gy/mini-v2-migration
Loading global config from '/home/jaime/.config/mini-swe-agent/.env'
| `opencode-go/<id>` | Endpoint | in $/1M | out $/1M | cache read | cache write | $ / month |
| --- | --- | --- | --- | --- | --- | --- |
| `grok-4.6` | `/responses` | 2 / 4 | 6 / 12 | 0.5 / 1 | 0 / 0 | 15 |
| `gpt-5.6-luna` | `/responses` | 0.2 / 0.4 | 1.2 / 1.8 | 0.02 / 0.04 | 0.25 / 0.5 | 15 |
| `glm-5.3-flash` | `/chat/completions` | 0.15 | 0.5 | 0.03 | 0 | 60 |
| `glm-5.3` | `/chat/completions` | 1.4 | 4.4 | 0.26 | 0 | 15 |
| `glm-5.2` | `/chat/completions` | 1.4 | 4.4 | 0.26 | 0 | 60 |
| `glm-5.1` | `/chat/completions` | 1.4 | 4.4 | 0.26 | 0 | 60 |
| `kimi-k3` | `/chat/completions` | 3 | 15 | 0.3 | 0 | 15 |
| `kimi-k2.7-code` | `/chat/completions` | 0.95 | 4 | 0.19 | 0 | 60 |
| `kimi-k2.6` | `/chat/completions` | 0.95 | 4 | 0.16 | 0 | 60 |
| `longcat-2.0` | `/chat/completions` | 0.3 | 1.2 | 0.006 | 0 | 60 |
| `deepseek-v4.1-flash` | `/chat/completions` | 0.15 | 0.6 | 0.003 | 0 | 60 |
| `deepseek-v4-pro` | `/chat/completions` | 0.66 | 1.98 | 0.022 | 0 | 15 |
| `deepseek-v4-flash` | `/chat/completions` | 0.15 | 0.6 | 0.003 | 0 | 30 |
| `deepseek-v4-flash-vision-exp` | `/chat/completions` | 0.15 | 0.6 | 0.003 | 0 | 15 |
| `mimo-v2.5` | `/chat/completions` | 0.14 | 0.28 | 0.0028 | 0 | 60 |
| `mimo-v2.5-pro` | `/chat/completions` | 0.435 | 0.87 | 0.003625 | 0 | 15 |
| `minimax-m3` | `/messages` | 0.3 | 1.2 | 0.06 | 0 | 60 |
| `minimax-m2.7` | `/messages` | 0.3 | 1.2 | 0.06 | 0.375 | 60 |
| `minimax-m2.5` | `/messages` | 0.3 | 1.2 | 0.06 | 0.375 | 60 |
| `muse-spark-1.3-contributor` | `/responses` | 0.1 | 0.2 | 0.002 | 0 | 60 |
| `muse-spark-1.2-contributor` | `/responses` | 0.1 | 0.2 | 0.002 | 0 | 60 |
| `qwen3.8-max` | `/messages` | 2 | 6 | 0.25 | 2.5 | 15 |
| `qwen3.8-flash` | `/messages` | 0.15 | 0.47 | 0.016 | 0.2 | 30 |
| `qwen3.7-max` | `/messages` | 2.5 | 7.5 | 0.5 | 3.125 | 30 |
| `qwen3.7-plus` | `/messages` | 0.4 / 1.2 | 1.6 / 4.8 | 0.04 / 0.12 | 0.5 / 1.5 | 60 |
| `qwen3.6-plus` | `/messages` | 0.5 / 2 | 3 / 6 | 0.05 / 0.2 | 0.625 / 2.5 | 60 |
| `hy4-preview` | `/chat/completions` | 0.834 | 2.501 | 0.042 | 0 | 30 |
| `hy3` | `/chat/completions` | 0.14 | 0.58 | 0.035 | 0 | 60 |
| `union-alpha` | `/messages` | 0 | 0 | 0 | 0 | free |

<!-- END GENERATED -->

## Using the same profile in pi

The pi coding agent already knows the `opencode-go` provider id (it adds the mandatory
`x-opencode-session` header itself), so it only needs the provider entry with the key
and the per-model endpoint, prices and context windows. The
`scripts/sync_opencode_go_to_pi.py` script in this repository writes it from the same
table this model class uses, which keeps ids, endpoints and prices identical between
`mini` and pi:

```bash
python scripts/sync_opencode_go_to_pi.py --api-key sk-your-key
pi --list-models opencode-go
pi -p --provider opencode-go --model grok-4.6 "Run ls in the current directory"
```

The script backs up `~/.pi/agent/models.json` next to the original and only replaces the
`opencode-go` provider entry, leaving every other provider untouched.

## Troubleshooting upstream unavailability

`ServiceUnavailableError: AnthropicException` with
`Upstream request failed: Endpoint is unavailable.` means Go returned HTTP 503.
`AnthropicException` identifies the `/messages` protocol adapter, not necessarily
Anthropic as the model vendor. The LiteLLM provider/help banners are generic error
output, not evidence that the provider is missing.

During investigation, a direct HTTP request to Go's documented `/v1/messages`
endpoint for `union-alpha`, with authentication and a session header, returned the
same HTTP 503 and error body without either LiteLLM or Rosetta involved. The exact
reason Go's upstream is unavailable cannot be determined from that response.

Mini already retries up to 10 attempts by default, waiting 4, 4, 4, 8, 16, 32,
60, 60 and 60 seconds between them. `MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT` controls
the attempt limit. Wait and retry later, or explicitly choose another available
model; retries cannot guarantee recovery during an upstream outage.

The adapter logs `checkpoint=upstream_unavailable` with the model and a request ID
sent upstream as `x-request-id`. Debug logging also exposes `upstream_request` and
`upstream_received`. Request IDs identify individual HTTP attempts; the session
header stays stable across retries. No API keys or message bodies are logged.

Keep the direct provider for now: moving it to Rosetta would reach the same failing
upstream, add another translation step, and require explicit forwarding of Go's
session header (the installed gateway does not forward it). Its generic Rosetta
adapter also does not preserve Go's documented pricing. Model routing in this
adapter matches the current Go endpoint documentation. The live model-list utility
already displays additional, undocumented IDs without changing the static catalog;
verify their endpoint before relying on its default chat route.

## Notes and caveats

- **The session header is mandatory.** Go refuses requests without a stable
  `x-opencode-session` header (`MissingSessionID`), so `OpencodeGoModel` adds one to
  every request and reuses it for the whole run. Set `OPENCODE_GO_SESSION` to keep the
  same routing and prompt-cache bucket across runs. A `MissingSessionID` answer aborts
  the run instead of being retried.
- **Cost tracking uses the documented prices.** litellm does not know these ids, so the
  module registers the prices above with litellm; tiered ids (Grok 4.6, GPT 5.6 Luna,
  Qwen Plus) use litellm's `tiered_pricing` table, which picks one tier per request from
  the input token count, matching how Go bills them. New ids that are not documented yet
  report a cost of `0.0` instead of aborting a run (`cost_tracking: ignore_errors`).
- **Anthropic cache-control markers are never added** to `opencode-go/` models: the
  OpenAI compatible endpoints do not understand them.
- **Off-peak pricing.** For the DeepSeek models the docs list Off-Peak and Peak prices;
  this profile ships the Off-Peak ones. Peak hours are 01:00-04:00 and 06:00-10:00 UTC
  on weekdays.
- **Run `mini-extra opencode-go-models`** to list the ids your key can actually use. Go
  also serves ids that the docs do not list yet; those are sent to
  `/chat/completions`, and the utility marks them with `*`.

{% include-markdown "../_footer.md" %}
