# Fusion: the strong model thinks, cheaper models act, in one session

Fusion keeps **one conversation** and changes the model that answers it, step by step. No
subagents, no new process, no brief files, no lost context.

- The **main model** (the run's `-m`, e.g. `cliproxy/claude-opus-5-5`) reasons, plans, reads and
  reviews.
- For every execution step it calls the `model_phase` tool and **chooses the worker model and
  the reasoning effort** from the pool: the fastest model at `low` effort for a `git status`, a
  strong UI coder at `high` effort for a complex component.
- The worker answers the next steps with the full history in view, then calls
  `model_phase {model: "base", summary}`. Control also returns when the worker answers without a
  tool call (the run never ends on a worker's word) or exceeds
  `MINI_AGENT_MODEL_PHASE_MAX_STEPS` steps (default 40).
- In **strict** mode the main model never runs bash, write or edit: those actions are refused
  with a pointer to `model_phase`. It is told so in its system prompt, so it plans with workers
  from the first step. It can still `read`, and run `code`/`codejs` scripts **read-only**: any
  `write`/`edit`/`bash` inside its script is refused, does nothing, and the observation says how
  many calls were refused.
- Every return to the main model carries the working tree (`git status --short`), so it reviews
  what the worker really changed instead of trusting the summary.
- A worker whose provider fails hands the step back to the main model, which picks another
  worker; the run does not die on a worker's outage.
- Runs driven by a scripted test model ignore the pool file (an explicit
  `MINI_AGENT_FUSION_MODELS` still applies), so test suites and replays behave the same on a
  machine with fusion configured.

```
opus (think)  → model_phase {model:"fast", effort:"low", brief:"run the test suite, report failures"}
haiku (act)   → bash … → model_phase {model:"base", summary:"3 failures in auth.test.ts"}
opus (think)  → model_phase {model:"ui", effort:"high", brief:"fix LoginForm.tsx so …"}
sonnet (act)  → edit … bash … → model_phase {model:"base", summary:"…"}
opus (review) → final answer
```

## Configure

`~/.config/mini-tui/fusion` (read by the TUI, the web app and the Docker image, which mounts
the home):

```
# [alias=]provider/model | note the main model reads when it chooses
strict
fast=cliproxy/claude-haiku-5-5 | shell, listings, git, builds/tests, tiny edits
coder=xiaomi/mimo-v2.6-flash | single components, straightforward edits
ui=cliproxy/claude-sonnet-5-5 | complex components, layout, multi-file refactors
glm=zai/glm-5.3 | components
```

Or the environment: `MINI_AGENT_FUSION_MODELS="fast=… | note, …"` and `MINI_AGENT_FUSION=1`
(strict; `0` turns strict off even when the file says `strict`). `MINI_AGENT_MODEL_PHASES` is
read too (the first version's name).

Efforts are the abstract levels (`auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`) translated per provider by the same code as the `/effort` setting. Returning to the main
model restores its own effort.

The tool exists only when the pool is not empty, and never for subagents
(`MINI_AGENT_DEPTH`) or the work-queue dispatcher.

Code: `agent-rs/src/model_phase.rs` (pool, tool schema, strict rules) and
`Agent::model_phase_outcome` / `leave_phase` in `agent-rs/src/agent.rs`. Each switch is also
written to the run journal as `{"t":"fusion","from":…,"to":…,"effort":…}`.
