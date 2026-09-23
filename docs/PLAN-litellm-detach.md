# Plan: detach from litellm — one direct base URL per provider

Status: **implemented (2026-09-23, 0.9.0)** — fases 1–4 landed together in one PR. Decision
results: escape hatch kept for one release (\`--model-class litellm\` / \`[litellm]\` extra),
openrouter became a registry row while portkey/requesty stayed behind the extra, price table
is in-repo snapshots plus \`MSWEA_PRICE_TABLE_PATH\`, and the existing env names were kept.
This is fase 3/A6 of [PLAN-ram-reduction.md](PLAN-ram-reduction.md) ("cliente HTTP propio para
los proveedores directos"), extended to *every* provider. The pattern it generalizes is already
proven in production: since 0.7.0 the gateways (`cliproxy/`, `rosetta/`, `xiaomi/`) call their
OpenAI-compatible `/chat/completions` with `OpenaiCompatModel` (stdlib `http.client`) —
peak RSS 214 → 40 MB and the first answer ~2.3 s sooner per run
([mini-swe-agent-patches.md §4](mini-swe-agent-patches.md)).

## 1. Goal

Zero `litellm` imports on any run path. Every provider is just a row of
**(prefix, base URL, key env, protocol)** and one of three thin clients. Model names
(`mini -m deepseek/deepseek-chat`, `mini -m gpt-6-astra`, `mini -m mimo-v2.6-pro`, …) keep
working unchanged; the trajectory/message shape stays byte-compatible (see §4.2).

What litellm still gives us today — and what replaces it:

| litellm provides | kept for | replacement |
| --- | --- | --- |
| price tables (`completion_cost`) | DeepSeek + OpenAI cost tracking | our own `models/prices.py` (§4.3) |
| protocol adapters (Anthropic Messages, OpenAI Responses) | `anthropic/*`, `gpt-6*`, 3 OpenCode Go endpoints | two new thin clients (§4.2) |
| exception taxonomy + retries | abort-vs-retry classification | `models/errors.py` + existing `utils/retry.py` (§4.4) |
| the model-name zoo (`openrouter/`, `portkey/`, …) | exotic stock providers | `openai/` generic compat escape hatch + `[litellm]` extra for one release (§5) |

## 2. Where we are today

`agent/src/minisweagent/models/` — after the 0.7.0 gateways work:

| prefix | protocol | class | transport | default base URL | key / base env |
| --- | --- | --- | --- | --- | --- |
| `cliproxy/` | chat | `CliproxyModel` | **direct** (`OpenaiCompatModel`) | `http://127.0.0.1:8317/v1` | `CLIPROXY_API_KEY` / `CLIPROXY_API_BASE` |
| `rosetta/` | chat | `RosettaModel` | **direct** | `http://127.0.0.1:9120/v1` | `ROSETTA_API_KEY` / `ROSETTA_API_BASE` |
| `xiaomi/` (+ bare `mimo*`) | chat | `XiaomiModel` | **direct** | `https://token-plan-sgp.xiaomimimo.com/v1` | `XIAOMI_API_KEY` / `XIAOMI_API_BASE` |
| `deepseek/` (+ bare `deepseek*`) | chat | `DeepseekModel(LitellmModel)` | litellm | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` / `DEEPSEEK_API_BASE` |
| `openai/` | chat | `OpenaiModel(LitellmModel)` | litellm | `https://api.openai.com/v1` | `OPENAI_API_KEY` / `MSWEA_OPENAI_API_BASE`→`OPENAI_API_BASE` |
| `openai/` (`gpt-6*`) | responses | `OpenaiResponseModel` | litellm | same | same |
| `opencode-go/` | chat / messages / responses (per id) | `OpencodeGo(Model\|ResponseModel)` | litellm | `https://opencode.ai/zen/go/v1` (messages flavor `https://opencode.ai/zen/go`) | `OPENCODE_GO_API_KEY` / `OPENCODE_GO_API_BASE` / `OPENCODE_GO_ANTHROPIC_API_BASE` |
| `anthropic/` | messages | litellm default class | litellm | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |
| `moonshot/`, `zhipu/`, `groq/`, `openrouter/` | chat | litellm native providers | litellm | `https://api.moonshot.ai/v1`, `https://open.bigmodel.cn/api/paas/v4`, `https://api.groq.com/openai/v1`, `https://openrouter.ai/api/v1` | `MOONSHOT_API_KEY`, `ZHIPUAI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` |
| Z.AI, MiniMax (TUI `openai-compat` route) | chat | litellm `openai/` provider | litellm | `https://api.z.ai/api/coding/paas/v4`, `https://api.minimax.io/v1` | funneled into `OPENAI_API_KEY`/`OPENAI_API_BASE` (one shared slot!) |
| `portkey/`, `requesty/`, `openrouter_*` variants | chat/responses | stock upstream classes | litellm | provider-specific | provider-specific |

Costs of the litellm half: **~198 MB RSS and ~2.1 s of import per run** (measured,
PLAN-ram-reduction §1) plus the exception noise users see when a provider errors (the
`BadRequestError: litellm.BadRequestError: DeepseekException - …` walls in the TUI's
`mini.log tail`). Bonus bug the registry fixes: today **two `openai-compat` BYOK providers
cannot coexist** — Z.AI and MiniMax share the single `OPENAI_API_BASE` env slot.

## 3. Target architecture

```
minisweagent/models/
├── providers.py          # NEW: the registry (§3.1) — one row per provider
├── errors.py             # NEW: ProviderError / ProviderAbortError (§4.4)
├── prices.py             # NEW: per-id token prices (§4.3)
├── openai_compat_model.py  # KEEP: chat client (generalized: explicit base_url/key)
├── anthropic_compat_model.py  # NEW: messages client (§4.2)
├── responses_compat_model.py  # NEW: responses client (§4.2)
├── deepseek_model.py     # REWRITE over OpenaiCompatModel (keeps alias + error rewrites)
├── openai_model.py       # REWRITE over the two new clients (keeps temperature fallback)
├── opencode_go_model.py  # KEEP the GoModelInfo/endpoint table; REWRITE transport
├── xiaomi_model.py / rosetta_model.py / cliproxy_model.py  # KEEP (thin registry rows now)
├── routing.py            # KEEP predicates; registry-driven class pick
└── litellm*.py, openrouter_*, portkey_*, requesty_*  # MOVE behind [litellm] extra, then delete
```

## 4. Design

### 4.1 Provider registry — `models/providers.py`

Single source of truth on the agent side (mirrors TUI `src/providers.ts` `ProviderDef`):

```python
@dataclass(frozen=True)
class Provider:
    prefix: str                 # "deepseek/", "opencode-go/", ...
    base_env: str               # "DEEPSEEK_API_BASE"
    default_base: str           # "https://api.deepseek.com/v1"
    key_env: str                # "DEEPSEEK_API_KEY"
    protocol: Literal["chat", "messages", "responses"] | Callable[[str], ...]  # Go routes per id
    strip_prefix: bool = True
    prices: bool = True         # subscription gateways report no prices
```

Rules:
- Base URL resolution is uniform: `os.getenv(base_env)` → `default_base`, `rstrip("/")`;
  `model_kwargs["api_base"]`/`["api_key"]` keep overriding env (config compatibility).
- Every provider gets its **own** env slot (`ZAI_API_BASE`, `MINIMAX_API_BASE`, …).
  `OPENAI_API_BASE` stays only for the generic `openai/` escape hatch (arbitrary
  OpenAI-compatible endpoints) — same semantics litellm's `openai/` provider had via
  `MSWEA_OPENAI_API_BASE`.
- `get_model_class` keeps its public behavior (predicate names in `routing.py` untouched,
  bare-id disambiguation for `mimo*`/`deepseek*` untouched) but resolves through the registry.
- TUI passthrough is unchanged in shape: `modelEnv()` already exports
  `<PROVIDER>_API_KEY`/`<PROVIDER>_API_BASE` per connection (§4.5).

### 4.2 Three clients, one message contract

`OpenaiCompatModel` already IS the template (keep-alive `http.client`, one shared SSL
context, tenacity retries, `_Obj` responses). Two siblings complete the protocol set:

| client | protocol | who | new work |
| --- | --- | --- | --- |
| `OpenaiCompatModel` | `POST {base}/chat/completions` | deepseek, openai (non-gpt-6), opencode-go chat ids, moonshot, zhipu, groq, zai, minimax, openrouter, 3 gateways | generalize `gateway_settings()` → registry row |
| `AnthropicCompatModel` (new) | `POST {base}/v1/messages` (`x-api-key`, `anthropic-version: 2023-06-01`) | `anthropic/*`, opencode-go messages ids | ~200 lines; `utils/anthropic_utils` + `utils/cache_control` already exist |
| `ResponsesCompatModel` (new) | `POST {base}/responses` | `gpt-6*`, opencode-go responses ids | ~250 lines; parse `output[]` items → actions |

All three emit the **exact message shape `LitellmModel` produced** (the contract documented in
mini-swe-agent-patches.md §4 and relied on by `traj/parse.ts`, `traj/slim.ts`, `--resume`):
`message` with `tool_calls`, `extra.actions`, `extra.response` (dict), `extra.cost`, and
plain-text final answers as `extra.submission`. That is what keeps the TUI, the journal,
`--resume` and the trajectory files byte-compatible across the migration.

Existing quirk-handling ports 1:1 (they live in litellm-era modules today):
- DeepSeek: `DEEPSEEK_MODEL_ALIASES` id re-spelling + the "supported API model names are …"
  error rewrite + auth-error hint (`deepseek_model.py` bodies survive, transport swaps).
- OpenAI: the temperature-fallback mixin (`temperature is not supported with this model`) and
  `gpt-6*` → Responses routing (`routing.openai_needs_responses_api`).
- OpenCode Go: the `GoModelInfo` catalog (600+ lines of per-id endpoint/tier facts — keep as
  data), `endpoint_for()` per-id chat/messages/responses routing, session-id header.
- Anthropic: `set_cache_control` / thinking-block reordering (`utils/anthropic_utils`).

### 4.3 Cost without litellm — `models/prices.py`

- `Price(input, output, cache_read, cache_write)` in $/1M tokens; a flat
  `PRICES: dict[str, Price]` keyed by canonical id, with a snapshot-date comment per source.
  Initial rows: the DeepSeek ids (`deepseek-chat`, `deepseek-reasoner`, `deepseek-v4*`), the
  OpenAI ids (`gpt-6-astra`, `gpt-5.4`, `gpt-4o-mini`), Claude 4.x, Kimi K2.x, GLM 5.x/4.x,
  MiniMax M3/M2.7, Groq `llama-3.3-70b`.
- Compute from the response `usage` (`prompt_tokens`/`completion_tokens`; Anthropic:
  `input_tokens`/`output_tokens` + cache counters) → `extra.cost`, then
  `GLOBAL_MODEL_STATS.add(...)` as today.
- **Unknown id or subscription gateway → cost 0.0** (identical to litellm's behavior for ids
  it has no price for — `DeepseekModel`'s docstring already documents this).
- `MSWEA_COST_TRACKING=default|ignore_errors` semantics kept per config class.
  `LITELLM_MODEL_REGISTRY_PATH` is dropped (replaced by `MSWEA_PRICE_TABLE_PATH`, same "file
  with extra prices" idea); note it in the changelog.

### 4.4 Errors and retries — `models/errors.py`

- `ProviderError(message, status)` and `ProviderAbortError(ProviderError)`; classification is
  status-based and shared: **abort** on 400/401/403/404/413/422 (and auth-shaped errors),
  **retry** on 408/429/5xx and transport errors via the existing
  `utils/retry.retry(abort_exceptions=[ProviderAbortError])` (tenacity, 10 attempts, exp
  backoff — unchanged knobs).
- Error text = the provider's raw error body (short JSON), prefixed with
  `{provider} - ` like litellm's message. No wrapper tracebacks: the TUI shows the
  `mini.log tail` of crashed runs (0.8.1), and shorter tails read better.

### 4.5 TUI side — `src/providers.ts`

- `ProviderDef.route: "native" | "openai-compat"` collapses to one direct route plus
  `protocol: "chat" | "messages" | "responses"` (or "auto" = ask the agent's per-id routing).
  `probe` stays as-is (catalog fetch is already plain HTTP).
- `connectionEnv()` emits `{ keyEnv, baseEnv: baseUrl }` per provider row. Keep emitting
  `MSWEA_OPENAI_*`/`OPENAI_API_*` for the `openai/` escape hatch one release so old saved
  `providers.json` connections keep working; `SavedConnection` gains `baseEnv` with a lazy
  migration (derive from `id` on load).
- `testProviderModel` is unchanged by design — `scripts/test_model.py` goes through mini's own
  model layer, so it automatically tests the direct client after the swap ("a passing test
  means a run will work").
- Cosmetic: picker labels ("litellm" / "openai-compat" descriptions) → "direct".

## 5. Rollout fases

| fase | scope | risk | effort |
| --- | --- | --- | --- |
| **1 · registry + DeepSeek** | `models/providers.py`, `models/errors.py`, `models/prices.py` (deepseek rows), `DeepseekModel` rewritten over `OpenaiCompatModel` (alias table + error rewrites ported). Default route direct; `MSWEA_LITELLM=1` (or `--model-class litellm`) falls back to the old class while litellm is installed | low (pure OpenAI-compat provider, quirks already extracted) | ~half a day |
| **2 · OpenAI + the openai-compat crowd** | `ResponsesCompatModel` (new), `OpenaiModel` rewritten (temperature fallback ported), moonshot/zhipu/groq/zai/minimax/openrouter become registry rows on `OpenaiCompatModel`; per-provider env slots fix the shared-`OPENAI_API_BASE` collision | medium (Responses API shape; gpt-6 quirks) | ~a day |
| **3 · Anthropic + OpenCode Go** | `AnthropicCompatModel` (new), OpenCode Go transport rewritten over the three clients (catalog/`endpoint_for` kept as data), cache_control + thinking reorder kept | medium (3 endpoints, per-id routing) | ~a day |
| **4 · detach** | `litellm` moves to `[project.optional-dependencies] litellm`; litellm modules and `openrouter_*`/`portkey_*`/`requesty_*` quarantine→delete; TUI `providers.ts` route cleanup + `providers.json` migration; docs (patches doc §6 "direct clients", README) | low (mechanical) | ~half a day |

Each fase lands independently (own PR, own release) and is reversible via the escape hatch
until fase 4. Per-fase checkpoints: parity harness green (§6), no `litellm` in
`python -X importtime` for the touched paths, RSS/import measurements recorded in
PLAN-ram-reduction §7 style.

## 6. Test plan

- **Unit (`agent/tests/models/`)**: request shaping per client against recorded fixtures
  (headers, body, tool payload); `usage → cost` math incl. cache tokens and unknown ids;
  status → abort/retry classification (table-driven); DeepSeek alias + error-rewrite tests
  (behavior must survive the transport swap); `endpoint_for()`/`needs_responses_api` routing.
- **Parity harness**: the same scripted task against a mock endpoint, once through
  `MSWEA_LITELLM=1`, once direct; diff the trajectory messages
  (role/content/`tool_calls`/`extra.actions`/`extra.submission`) — cost excluded. This is the
  gate that keeps `traj/parse.ts`, `traj/slim.ts` and `--resume` safe without TUI changes.
- **Live smoke (manual, keys required)**: `python3 scripts/test_model.py "<id>"` per provider
  row (this is exactly the TUI `/connect` test), plus one `mini` hello-world per protocol.
- **TUI**: `bun test` green with updated `providers.test.ts` (connectionEnv/modelEnv shapes);
  the fake-mini e2e repro from the 0.8.1 fix is unaffected and re-run as a regression.
- **Perf gates**: `minisweagent.models.<provider>` imports without litellm (assert no
  `litellm` in `sys.modules`); peak RSS of a real run back to the 0.7.0 gateway numbers
  (~40 MB) for deepseek/openai; first-answer latency ~2 s better than the litellm path.

## 7. Risks and mitigations

| risk | mitigation |
| --- | --- |
| price drift (our table vs reality) | unknown ids cost 0.0 exactly like today; one small file with dated snapshots; `MSWEA_COST_TRACKING=ignore_errors` stays the BYOK default |
| protocol quirks bite (thinking blocks, cache_control, temperature, Go tiers) | every existing workaround is ported 1:1 (§4.2) and locked by the parity harness before each swap |
| Responses API churn (it is young) | isolated in `responses_compat_model.py`; `gpt-6*` can fall back to `MSWEA_LITELLM=1` / the extra until fixed |
| upstream sync drift (vendored `agent/`) | the divergence is real either way (patches doc §4–§5 already are); keep patches doc §6 as the upstreamable description of the clients |
| losing litellm's exotic providers (portkey, requesty, …) | `[litellm]` extra + `--model-class litellm` escape hatch for one release; drop in fase 4 if unused (track usage first) |

## 8. Decisions needed before fase 1

1. **Escape hatch**: keep `LitellmModel` behind `mini-swe-agent[litellm]` for one release
   (recommended) or delete litellm outright in fase 4?
2. **Stock provider classes** (`openrouter_*`, `portkey_*`, `requesty_*`): openrouter becomes
   a plain registry row (it *is* OpenAI-compatible); portkey/requesty — move to the extra or
   drop?
3. **Price table**: in-repo snapshots (recommended — offline, testable) vs a fetched registry?
4. **Env naming**: keep the existing per-provider names (`DEEPSEEK_API_BASE`, `XIAOMI_API_BASE`,
   `MSWEA_OPENAI_API_BASE`, …) and only add the missing ones (recommended — zero churn for
   saved connections), or normalize everything to `MSWEA_<PROVIDER>_API_*`?
