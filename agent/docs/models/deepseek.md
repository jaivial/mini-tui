# DeepSeek API

[DeepSeek](https://api-docs.deepseek.com/) hosts its models behind an
OpenAI-compatible `/chat/completions` endpoint. `mini` talks to it through the
`deepseek/` model-name prefix, which is also how
[litellm](https://docs.litellm.ai/docs/providers/deepseek) identifies the
provider.

## Quick start

```bash
# See what your account currently offers
mini-extra deepseek-models

# Run a task
mini -m deepseek/deepseek-chat -t "Fix the failing test in test_utils.py"
mini -m deepseek-flash -t "Fix the failing test in test_utils.py"          # bare id also works
mini -m deepseek/deepseek-v4.1-flash -t "Fix the failing test in test_utils.py"
mini -m deepseek-v41-flash -t "Fix the failing test in test_utils.py"      # dot-less spelling
```

Bare DeepSeek ids (any id starting with `deepseek` and without a `/`) are routed
to this profile automatically, because litellm cannot infer the provider from
them on its own.

To make it your default model:

```bash
mini-extra config set MSWEA_MODEL_NAME deepseek/deepseek-chat
```

## Configuration

`mini` reads the key from `DEEPSEEK_API_KEY`. Set it permanently with:

```bash
mini-extra config set DEEPSEEK_API_KEY sk-your-key
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | *(unset)* | DeepSeek API key |
| `DEEPSEEK_API_BASE` | `https://api.deepseek.com/v1` | API base URL (point it elsewhere for DeepSeek-compatible endpoints) |

`api_base` and `api_key` can also be overridden per model through `model_kwargs`
in a [yaml config file](../advanced/yaml_configuration.md); explicit values
always win over the defaults above:

```yaml
model:
  model_name: "deepseek/deepseek-chat"
  model_kwargs:
    temperature: 0.0
    api_base: "https://my-deepseek-compatible-host/v1"
```

## Model ids and aliases

`mini-extra deepseek-models` reads DeepSeek's `/models` endpoint, which does not
necessarily list every id the API accepts, so an id can work even when it is not
listed. The reverse is also true: an id that is not valid for your key fails on
the first call with the definitive answer, e.g.

```
The supported API model names are deepseek-flash, deepseek-v4-pro,
but you passed deepseek-v4.1-flash.
```

DeepSeek also serves several aliases through the same backend, which matters for
cost tracking (`mini` gets its prices from litellm, and litellm only maps some
ids):

| id passed to `mini` | served by DeepSeek as | litellm price map |
| --- | --- | --- |
| `deepseek/deepseek-flash` | `deepseek-flash` | no (cost reported as `0.0`) |
| `deepseek/deepseek-v4-flash` | `deepseek-flash` | yes |
| `deepseek/deepseek-v4.1-flash` | `deepseek-flash` | yes (priced as `deepseek-v4-flash`) |
| `deepseek/deepseek-v41-flash` | `deepseek-flash` | yes (priced as `deepseek-v4-flash`) |
| `deepseek/deepseek-chat` | `deepseek-flash` | yes |

`mini` resolves the ids in the last two rows itself, before anything is sent
upstream: DeepSeek still only accepts the `deepseek-v4-flash` spelling for the
flash tier, so `deepseek/deepseek-v4.1-flash` (and the dot-less
`deepseek/deepseek-v41-flash`) is rewritten to it. The id you asked for is kept
on the model as `requested_model_name`, so trajectory files still show what you
ran. Running a raw id the API rejects fails fast with a pointer to the id that
serves it.

Prefer a mapped alias (`deepseek/deepseek-v4-flash`) when you want real cost
numbers and working `--cost-limit`; use the canonical id when you specifically
want to hit the name the API advertises.

## Notes and caveats

- **Pick a tool-calling model.** The agent drives the model through native tool
  calls, so models that reject tools (for example `deepseek/deepseek-reasoner`)
  cannot run the loop. Prefer `deepseek/deepseek-chat` or
  `deepseek/deepseek-v3.2`.
- **Cost tracking is lenient.** DeepSeek ships new model ids faster than litellm
  maps their prices, and an unmapped id would abort the run on the first
  response. `deepseek/` models therefore default to `cost_tracking:
  ignore_errors` (unknown ids report a cost of `0.0`). Pass
  `cost_tracking: default` (or `export MSWEA_COST_TRACKING=default`) if you want
  unmapped ids to be fatal.
- **Anthropic cache-control markers are never added** to `deepseek/` models, so
  they are sent as-is to the OpenAI-compatible endpoint.
- **Run `mini-extra deepseek-models`** to see the ids your key can actually use;
  availability differs between accounts and platforms.
- **A wrong key fails fast.** DeepSeek answers an invalid key with a `400`
  (not a `401`), which would otherwise be retried over and over. `mini`
  recognizes it and aborts straight away with a pointer to
  `mini-extra config set DEEPSEEK_API_KEY ...`.

{% include-markdown "../_footer.md" %}
