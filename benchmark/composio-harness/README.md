# Composio Kimi K3 harness comparison

Reference: <https://composio.dev/content/best-ai-agent-harnesses> (4 Aug 2026).

This directory contains the article's published numbers and a chart generator that can add a
**real mini-tui run** without silently mixing benchmarks.

## Published methodology read from the article

- 25 valid stateful tasks; one valid scored attempt per harness/task; 900-second ceiling.
- `moonshotai/kimi-k3`, OpenRouter, maximum reasoning, the same hosted Composio MCP tools,
  instructions, seeded app state, and deterministic final-state verifier for every harness.
- Five tasks were excluded from every arm. Provider/runtime/evaluator-invalid attempts were
  replaced; normal task failures and timeouts stayed in the score.
- Pass rate and median wall time cover 25 tasks. Tool calls are the reported all-task total.
- Token and cost charts cover a shared 24-task slice. The article does not identify the excluded
  usage task, so a new run must obtain that list from the original evaluation artifacts rather
  than guess it.

`published_kimi_k3.json` records the article's overall table and the totals shown in its two
images. These are **published reference values, not a local reproduction**.

## Exact-run access status (24 Oct 2026)

An exact mini-tui result has **not** been produced from the public article alone:

1. The article and public Bench pages expose task families, case IDs and abbreviated prompts,
   but not the run-specific parameters, complete seeded state, reset procedure, isolated connected
   accounts, hosted MCP credentials, or deterministic verifier bundle. The current 30-task public
   roster is not identical to the article's older 25-task slice (and its `retained` flags mark 26,
   not 25, cases), so it cannot be used to infer that slice. Prompts refer to values such as a
   “supplied run tag”, “named ledger”, and a starting Gmail history ID that are not in the public text.
2. This machine has a working Kimi for Coding `k3` credential, but no Composio or OpenRouter
   credential and no checkout of the private `golden.*` evaluation bundle. The public
   `ComposioHQ/composio` repository does not contain those fixtures. Local agent smokes and a full
   ten-task mini-vs-pi K3 A/B passed (10/10 on both), but they are not Composio results.
3. `mini-agent-rs` now has an opt-in native MCP client (`agent-rs/src/mcp.rs`, documented in
   `docs/mcp.md`), and the official `@composio/cli 0.5.0` is installed. However, the official
   `composio login --agent` provisioning endpoint returned HTTP 503 on both attempts, so there is
   still no Composio project credential or authorized benchmark environment. The local MCP test
   proves the protocol path only, not access to Composio or the benchmark.

Consequently the `published-*.png` charts are reference-only. They deliberately do **not** contain
an invented mini score or a score from the unrelated local coding corpus.

To complete the exact run, supply the original evaluation bundle/access (or an isolated equivalent
with identical tasks, state, MCP tools and verifier), including the 24-task usage slice. Use Kimi
for Coding `k3` as requested, and label the provider difference: the article's other arms used
OpenRouter, while mini would use Kimi for Coding directly.

## Charts

```bash
python3 benchmark/composio-harness/plot_results.py
```

Writes four dark horizontal-bar charts under `charts/`: pass rate, median time, tokens and cost.

To add mini, create a result JSON and run:

```bash
python3 benchmark/composio-harness/plot_results.py \
  --mini benchmark/composio-harness/mini-k3.json --out-dir benchmark/composio-harness/charts
```

The loader refuses incomplete runs, another corpus, fewer/more than 25 unique tasks, missing raw
evidence, non-K3 models, multiple scored attempts, or a timeout other than 900 seconds. It computes
pass rate, median wall time and tool calls from `task_results`; it does not trust handwritten
aggregates. Tokens/cost remain `N/A` unless the comparable measurements exist.

Required mini result shape:

```json
{
  "benchmark_id": "composio-kimi-k3-25-v1",
  "harness": "mini-tui",
  "model": "kimi-coding/k3",
  "provider": "Kimi for Coding (direct)",
  "run_label": "run-id",
  "run_complete": true,
  "attempts_per_task": 1,
  "timeout_seconds": 900,
  "evidence_files": ["runs/run-id/summary.json"],
  "task_results": [
    {"task_id": "golden....", "passed": true, "wall_seconds": 123.4, "tool_calls": 8,
     "total_tokens": 100000}
  ],
  "usage_task_ids": ["the same 24 task IDs used by Composio"],
  "total_cost_usd": null
}
```

`task_results` must contain all 25 entries (the example is abbreviated). `total_cost_usd: null`
is rendered as `N/A`, never zero. Evidence paths are resolved relative to the result JSON.
