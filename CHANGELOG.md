# Changelog

All notable changes to mini-tui, newest first. Versions follow [semver](https://semver.org/).

## Unreleased

### Fixed

- **Pasting into the `/connect` API key field works now.** The wizard's inputs are display-only
  and never handled paste, so the key had to be typed character by character. Bracketed pastes
  (the usual ctrl+shift+v / shift+insert in modern terminals) are wired into the key field, the
  model search and the `/resume` search; ctrl+v and shift+insert read the system clipboard
  directly (wl-clipboard · xclip · xsel · pbpaste · tmux buffer); and pastes that arrive as
  plain input bursts land as one token. Pasted keys collapse to a single whitespace-free token
  (line-wrapped clipboard values included).

### Changed

- **The OpenCode Go catalog matches the docs `Endpoints` table** (32 models). Added with their
  documented prices and limits: `grok-4.7` (responses, tiered above 200K like 4.6),
  `MiMo-V2.6-Flash` / `MiMo-V2.6-Pro` (chat) and the free-for-now `Space Bunny Free` (chat,
  replacing `union-alpha` as the promo model). The TUI's static fallback list drops the ids
  the docs no longer advertise (`glm-5`, `grok-4.5`, `kimi-k2.5`, `mimo-v2-omni`, `mimo-v2-pro`,
  `omen-alpha`, `ox-alpha-free`, `qwen3.5-plus`), and the pi sync fallbacks cover the new ids.

## 0.10.0 — 2026-09-23

Your prompt is on screen the instant you send it; the model's thinking can be too.

### Added

- **Your prompt is on screen the moment you send it.** The task card used to wait for the
  first journal write — which lands with the first assistant reply — so every prompt left a
  visible gap before it appeared. The TUI now echoes the task immediately (typed prompts,
  post-run follow-ups and `mini -t` run mode alike), and mini writes the prompt to its
  trajectory journal *before* the first model call (control-file follow-ups too), so the real
  transcript confirms the echo right away. Sent twice-by-later-parsing tasks dedupe to one.
- **The model's thinking, in the same three states as tool outputs.** mini-swe-agent captures
  chain-of-thought from all three provider flavors — `reasoning_content`/`reasoning` (DeepSeek,
  Qwen), Anthropic `thinking` blocks (incl. redacted ones and replay signatures), and OpenAI
  Responses `reasoning` summaries (live deltas do not exist here: the agent's query is a single
  non-streaming call, so the thinking arrives complete with the reply). It renders above the
  reply: `expanded` shows it in full, `trimmed (2 lines)` at most two lines, `collapsed` shows
  just “Thinking...” while the model works and “Thought for {n} seconds” once it answers
  (per-reply timing recorded as `extra.thinking_seconds`). The live “Thinking...” tail shows
  in every mode while a turn is in flight.

## 0.9.0 — 2026-09-23

Every provider on its own direct base URL; litellm becomes an optional extra.

### Changed

- **litellm is detached: every provider runs on its own direct base URL.** DeepSeek, OpenAI,
  Anthropic, Moonshot, Zhipu, Groq, Z.AI, MiniMax and OpenRouter now call their endpoints
  directly — three thin clients (OpenAI chat, Anthropic Messages, OpenAI Responses) with
  zero litellm imports on any run path. `litellm` becomes an optional
  `mini-swe-agent[litellm]` extra that only backs the opt-in `--model-class litellm`
  escape hatch. Everything litellm silently provided is now explicit: cost tracking ships
  in `models/prices.py` (per-provider price rows — DeepSeek/OpenAI/Anthropic prices kept,
  OpenCode Go's documented prices and tiered billing included; unknown ids cost 0.0 like
  before), and the protocol quirks carry over 1:1 (DeepSeek id aliases and error rewrites,
  the `gpt-6*` Responses API, the temperature fallback, Anthropic cache markers and
  thinking-block replay, OpenCode Go's three endpoints and session headers).
- **One base URL/env slot per provider** (`ZAI_API_BASE`, `MINIMAX_API_BASE`, `MOONSHOT_API_BASE`,
  …). Two OpenAI-compatible BYOK providers can now coexist — they used to collide on the
  single `OPENAI_API_BASE` slot. Saved connections on that generic slot keep working.
- Unknown model names fall back to the generic OpenAI-compatible client (any endpoint via
  `OPENAI_API_BASE`) instead of litellm's model zoo. `MSWEA_PRICE_TABLE_PATH` adds custom
  price rows; `LITELLM_MODEL_REGISTRY_PATH` is gone with the litellm path.

## 0.8.1 — 2026-09-23

A crash error that scrolls with the chat.

### Fixed

- **A crashed run's `mini.log tail` no longer sticks to the bottom of the chat.** When `mini`
  died mid-run (a `BadRequestError`, e.g. DeepSeek's "Insufficient Balance"), its log tail
  pinned itself below the transcript and stayed there: after switching model and continuing
  the conversation, every newer message rendered above it and the stale error sat at the very
  bottom of the chat thread. The tail is now posted as a transcript item at the failure point,
  so it moves up with the thread as the conversation continues (and clears when the thread
  rebuilds from the resumed conversation on the next run).
- An interrupted run no longer swallows what comes after it: a follow-up run's exit reported
  "interrupted" and its crash tail was never posted.
- An unreadable trajectory posts a transcript notice (it used to show under the mislabeled
  `mini.log tail` block).

## 0.8.0 — 2026-09-22

Faster agent loop: 5× less overhead per step (8.9 → 1.8 ms) and keep-alive to the gateway.

### Performance

- **The agent's own overhead per step is 5× lower: 8.9 → 1.8 ms** (600-step bench, same
  output). This is everything except the model and the command itself.
  - **Young-generation GC per step, full pass every 50 steps.** A full `gc.collect()` walked
    the whole heap on every step and was more than half of the agent's time.
  - **Compiled Jinja templates are cached.** The observation, format-error and system templates
    were re-parsed and re-compiled on every step (~1.5 ms each).
  - **The full trajectory export scales its cadence** to one rewrite per 10 % of new messages,
    and at least every 60 s. It is O(n): ~33 ms at 900 messages. The append-only journal stays
    the always-current copy, and the export still lands at the end of every run.
- **Keep-alive to the gateway.** `cliproxy/` · `rosetta/` · `xiaomi/` reuse one HTTP connection
  across steps, with a transparent reconnect if the gateway dropped it while idle. The TLS
  context is built once, which saves the TCP+TLS handshake on every step for remote HTTPS
  gateways such as Xiaomi.

## 0.7.0 — 2026-09-22

Fase 3 del plan de RAM: `mini` sin litellm para los gateways y una TUI más ligera en vivo.
Una sesión con claude-opus-5-5 vía cliproxy pasa de ~410–560 MB a ~215–250 MB (TUI + mini).

### Performance

- **`mini` without litellm for the gateways.** `cliproxy/`, `rosetta/` and `xiaomi/` models now
  call their OpenAI-compatible `/chat/completions` directly (stdlib HTTP, same trajectory
  shape). A real claude-opus-5-5 run: **peak RSS 214 → 40 MB** and the first answer **~2.3 s
  sooner** (litellm's import alone was 198 MB / 2.1 s). DeepSeek, OpenAI and OpenCode Go keep
  litellm (price tables, protocol adapters). Picking a model class no longer imports litellm.
- The gateway API key is no longer written into the trajectory's model config (`***`).
- **The TUI keeps only the slim conversation.** Once raw messages become UI events, their heavy
  extras (`extra.response`, `extra.raw_output`) are dropped from memory, both in the App and in
  the journal watcher. The trajectory files on disk stay complete, and `--resume` context is
  unchanged. A saved 817-message session shrinks from **5.7 to 3.1 MB**.
- **Fewer transcript saves.** A save happens when a turn ends and at most every 30 s while a run
  streams, instead of 2 s after every change (each save stringified MBs). Quitting and `/new`
  flush the pending save.
- **The spinner no longer re-renders the app.** The working indicator owns its 8 fps tick, so the
  transcript tree stays still. CPU at rest while "working" drops **1.8 → 0.5 %**.
- Live replay of a real 817-message session: CPU **−13 %**, peak RSS **229/241 → 199/211 MB**.

## 0.6.1 — 2026-09-22

An honest status chip and a quieter bottom stack.

### Fixed

- **"● done" while the agent was still working.** The agent keeps a run open at exit to take
  follow-ups, and its journal keeps that exit message. Any exit anywhere in the transcript
  showed "done" (green) through every later turn. The chip now reads the *last* event: an exit
  there means done (or error for a non-`Submitted` exit status), and anything after it is live
  work with the loader. Replaying a real claude-opus-5-5 session: 122 of 129 working snapshots
  showed "done" before, 0 now.
- A follow-up sent to a held-open run restarts the "working · Ns" timer.
- ctrl+c right after fast typing now clears the prompt too (it read a not-yet-synced copy).

### Changed

- **Nothing below the model row.** The hint line under the status line is gone (no
  "sent → …", "copied …", "theme → …", "interrupted — …"). The status line is the last row.
  The ctrl+c close prompt moves into the prompt placeholder, and the rare failures (unknown
  `$skill`, unreadable session) post a transcript notice instead.

## 0.6.0 — 2026-09-22

Skills, prompt memory and sessions without restarts.

### Added

- **Claude Opus 5.5 in `/model`**: `cliproxy/claude-opus-5-5` (Claude subscription through
  cli-proxy) heads the curated model list.
- **`/new`** starts a fresh session without restarting mini-tui: the current run (if any) is
  stopped, its transcript saved, and the view, cost, prompt history and conversation reset. The
  chosen model and settings carry over; the next prompt creates a new saved session.
- **Prompt history.** Every prompt sent in the session (commands and `$skill` calls too) is
  remembered: `↑` on the first line of the prompt recalls older ones, `↓` on the last line walks
  forward and restores the half-written draft. `/resume` seeds it with the session's prompts.
- **`$skill` prompts.** `$` opens a completion palette over `~/.claude/skills` (name +
  description); `$<skill> <request>` sends mini the skill's `SKILL.md` ahead of the request,
  and the transcript collapses it back to `$<skill> <request>`. Unknown skills keep the prompt
  and post a notice.

### Changed

- **ctrl+c: once clears, twice closes.** The first press clears the prompt (and shows
  "ctrl+c again to close"). A second press within 1.5 s closes the TUI, in the prompt and in
  navigation mode. The renderer no longer exits on the first ctrl+c.

### Fixed

- Filling the prompt from the palette parks the cursor at the end, so typing continues after
  `/model ` / `$skill ` instead of before it.

## 0.5.0 — 2026-09-22

Leaner blocks, leaner agent — fases 0–2 del plan de RAM ([docs/PLAN-ram-reduction.md](docs/PLAN-ram-reduction.md)).

### Performance

- **Plain text unless markdown is needed.** Measured per block: `<markdown>` 0.33 MB vs
  `<text>` 0.09 MB (syntax highlighting is free in RAM — 0.32 MB without it — so it stays).
  Task cards render the prompt verbatim as text; assistant/exit bodies only use the markdown
  renderable when they actually have structure. Standard 400-step repro: **279 → 205 MB**
  settled; a plain-prose workload sits at **152 MB** (≈ the app's base).
- **`prompt_toolkit` loads lazily** in the agent (only interactive prompts need it): the `mini`
  import drops **35 → 20 MB** and ~63 ms of startup on every invocation, `-y` runs included.
- The agent freezes interned state after imports (`gc.freeze()`) and collects per step, keeping
  hour-long runs flat.

### Added

- `MINITUI_PROFILE=1` (or `MINITUI_PROFILE=<path>`) samples the TUI's RSS/CPU every 5 s into
  `~/.config/mini-tui/profile.log` for capacity work on real sessions.

### Notes

- `mini`'s remaining ~200 MB during runs is `litellm` (measured: 198 MB retained at import) —
  all six providers route through it. Cutting that is Fase 3 of the plan and needs a decision
  on cost tracking.

## 0.4.0 — 2026-09-22

One repo, one install — mini-swe-agent now lives in `agent/`, and trajectory persistence got
55× lighter.

### Added

- **Vendored mini-swe-agent** (`agent/`, `git subtree --squash` on upstream v2.4.6) carrying the
  three TUI integration patches as real code (plain-text final answer · control file ·
  `--resume`) and the custom model providers (xiaomi, rosetta, cliproxy, deepseek, opencode_go,
  openai, with their `mini extra <provider>-models` listings). One `pip install -e ./agent` and
  `mini` runs it all; [docs/mini-swe-agent-patches.md](docs/mini-swe-agent-patches.md) remains
  as the upstreamable description of the patches.

### Performance

- **Append-only trajectory journal** (`<traj>.jsonl`): the agent appends one line per message
  plus a fresh info line on every save (O(1) per step, never torn), and mini-tui consumes only
  the new bytes per tick. The full `traj.json` export is now compact (no `indent=2`), atomic
  (tmp + rename) and throttled (every 20 messages / 10 s — always written at run end).
  Benchmark on a synthetic 300-step run: **55× less IO** (235 MB → 4.3 MB written) and **8×
  faster persistence** (0.99 s → 0.12 s).
- Trajectories from unpatched producers keep working: the TUI falls back to whole-file reads
  when no journal exists.

### Fixed

- Torn mid-write trajectory reads can no longer happen (atomic export; journal appends are
  single whole lines and partial tails are held back until complete).

## 0.3.0 — 2026-09-22

Lighter and faster. Identical 400-step repro run (200×50 terminal): **−30 % CPU** (18.6 s → 13.1 s)
and **−30 % memory** (peak 323 → 228 MB, settles at 280 → 198 MB).

### Performance

- Transcript cards are memoized with stable per-block callbacks (`StepCard`, `TaskCard`, the new
  `AssistantCard`, `NoticeLine`, `ExitBanner`): the 120 ms spinner tick now re-renders just the
  status line — before, every mounted card re-rendered and re-clipped its text 8×/s.
- Trajectory snapshots parse incrementally — messages are append-only per run, so only the delta
  is parsed and appended instead of rebuilding every event on each step. A replaced file
  (`view --follow` on another run's output) is detected at the message boundary and re-parsed whole.
- `messagesToEvents` scans the consumed prefix without allocating a slice per snapshot.
- Step numbering is O(1) per card (was a linear search per card — O(n²) per render).

## 0.2.0 — 2026-09-22

Memory: long runs no longer grow into the GBs. A transcript keeps every step mounted as native
text buffers (≈1 MB each in practice — every rendered line is a full terminal-width row of
cells), so an all-day run used to grow without bound (5+ GB observed).

### Fixed

- The transcript now mounts in a sliding window of 120 blocks: it follows the live tail, `g`
  pages older steps in (a top hint says how much is hidden) and `G` returns to the live bottom.
- Assistant markdown, task, notice and exit text is now clipped like tool outputs
  (`... N lines hidden ...` marker, plus a hard 40 KB clamp for single-line monsters).
- Expanded / `e` reveal is capped at 500 lines (was 5000 — one flipped-open block could
  allocate tens of MB on a wide terminal).
- Error banner reads only the last 64 KB of `mini.log` instead of the whole file.
- Tool-call pairing is O(n) and memoized (was O(n²) on every render — 8 renders/s while running).
- Session transcript saves are debounced 2 s (was 500 ms); each save stringifies the full
  transcript, so the old cadence churned tens of MB/s of garbage while a run streamed.
- The scrollbox `contentOptions` prop has a stable identity: no layout re-apply on every commit.

## 0.1.0 — 2026-09-22

Initial release.

### Added

- Terminal UI for mini-swe-agent: the harness runs untouched as a subprocess; the trajectory it
  rewrites after every step is parsed into cards (task · assistant markdown · one quiet card per
  bash step) that stream in live (`run`), or render an existing trajectory (`view [--follow]`).
- Claude-Code-style prompt bar with conversational follow-ups (Alt+Enter / Ctrl+J newline) and a
  `/` command palette.
- Output display modes (collapsed / trimmed / expanded) with per-block `e` toggle, and six themes
  with live preview in `/settings`.
- `/model` picker and `/connect` for BYOK providers, `/resume` for sessions saved in SQLite with
  AI-generated titles, and `--resume` conversation continuation.
- Single status line (loader · model · path · branch), double-Esc interrupt, half-screen PgUp/PgDn,
  burst-accelerated mouse wheel and select-to-copy.
