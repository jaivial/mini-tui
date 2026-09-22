# Changelog

All notable changes to mini-tui, newest first. Versions follow [semver](https://semver.org/).

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
