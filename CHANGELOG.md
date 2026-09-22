# Changelog

All notable changes to mini-tui, newest first. Versions follow [semver](https://semver.org/).

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
