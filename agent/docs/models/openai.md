# OpenAI API

[OpenAI](https://platform.openai.com/docs/api-reference) hosts its models behind an
OpenAI-compatible `/chat/completions` endpoint. `mini` talks to it through the
`openai/` model-name prefix, which is also how
[litellm](https://docs.litellm.ai/docs/providers/openai) identifies the provider.

## Quick start

```bash
# See what your account currently offers
mini-extra openai-models

# ...or just one family
mini-extra openai-models -f gpt-5

# Run a task
mini -m openai/gpt-5.4 -t "Fix the failing test in test_utils.py"
mini -m openai/gpt-4o   -t "Fix the failing test in test_utils.py"
```

To make it your default model:

```bash
mini-extra config set MSWEA_MODEL_NAME openai/gpt-5.4
```

## Configuration

`mini` reads the key from `OPENAI_API_KEY`. Set it permanently with:

```bash
mini-extra config set OPENAI_API_KEY sk-your-key
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | *(unset)* | OpenAI API key |
| `OPENAI_API_BASE` | `https://api.openai.com/v1` | API base URL (point it elsewhere for OpenAI-compatible endpoints) |

Because many other tools export `OPENAI_API_KEY`/`OPENAI_API_BASE` pointing at
their **own** OpenAI-compatible gateway (the Rosetta/cli-proxy proxies in this
setup do exactly that), the `openai/` profile also honours `MSWEA_`-prefixed
overrides that always win:

| Preferred setting | Meaning |
| --- | --- |
| `MSWEA_OPENAI_API_KEY` | Overrides `OPENAI_API_KEY` |
| `MSWEA_OPENAI_API_BASE` | Overrides `OPENAI_API_BASE` |

So if some other tool already occupies `OPENAI_API_KEY`, set the key you want
`mini` to use without disturbing it:

```bash
mini-extra config set MSWEA_OPENAI_API_KEY sk-your-key
```

`api_base` and `api_key` can also be overridden per model through `model_kwargs`
in a [yaml config file](../advanced/yaml_configuration.md); explicit values
always win over the defaults above:

```yaml
model:
  model_name: "openai/gpt-5.4"
  model_kwargs:
    temperature: 0.0
    api_base: "https://my-openai-compatible-host/v1"
```

## Notes and caveats

- **The `openai/` prefix is kept** in the name sent to litellm: it is exactly how
  litellm selects the provider and its prices, so cost tracking and `--cost-limit`
  work for every id litellm knows the price of.
- **Cost tracking is lenient.** OpenAI ships new model ids faster than litellm maps
  their prices, and an unmapped id would abort the run on the first response.
  `openai/` models therefore default to `cost_tracking: ignore_errors` (unknown ids
  report a cost of `0.0`). Pass `cost_tracking: default` (or `export
  MSWEA_COST_TRACKING=default`) if you want unmapped ids to be fatal.
- **`drop_params` is enabled** by default, because OpenAI's reasoning models
  (o-series, some `gpt-5`/`gpt-6` ids) reject sampling parameters such as `temperature`.
- **A rejected `temperature` is retried without it.** Some reasoning ids (e.g.
  `openai/gpt-6-astra`) only accept the default temperature and answer with
  `Unsupported value: 'temperature' does not support 0.0 with this model`. litellm cannot
  drop it via `drop_params` (it advertises `temperature` as supported), so the `openai/`
  profile strips `temperature` and retries once. Configure it through `model_kwargs` only
  for models that accept it.
- **Anthropic cache-control markers are never added** to `openai/` models, so they
  are sent as-is to the OpenAI-compatible endpoint.
- **Run `mini-extra openai-models`** to see the ids your key can actually use;
  availability differs between accounts and organizations.

{% include-markdown "../_footer.md" %}
