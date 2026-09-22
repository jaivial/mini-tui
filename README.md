# mini-tui

A pretty terminal UI for [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent), built with
[OpenTUI](https://opentui.com) (React + Bun).

It only **parses and reformats** what `mini` already produces — tool calls (bash commands) and their
outputs — into cards, badges and banners. The harness runs completely untouched: mini-tui spawns
`mini` as a subprocess and reads the trajectory JSON it rewrites after every step.

![mini-tui running a task](docs/screenshots/run.png)

## Features

- **Prompt bar, Claude-Code style.** A compact multi-line prompt pinned to the bottom of the
  screen — long lines wrap to the next row and the box grows with your text (up to 8 rows):
  type your task (`Alt+Enter` / `Ctrl+J` for a hard new line), hit Enter, and keep typing
  follow-ups while the agent works (or after it submits) — they continue the *same* conversation.

  ![prompt bar](docs/screenshots/prompt.png)

- **Command palette.** Typing `/` opens real-time completion over the available commands
  (`/model`, `/settings`, `/model <id>`): filter as you write, pick with `↑`/`↓` or a mouse click,
  fill into the prompt with `Enter`/`Tab` (it never sends for you).

  ![command palette](docs/screenshots/command-palette.png)

- **Only what you sent.** The transcript shows your prompt as typed — never the harness' task
  template wrapping — the **final answer is rendered as proper markdown** (bold, code, links), and
  the redundant `exit Submitted` echo of it is never shown.
- **One quiet card per bash step** (command + its output), shadcn-style: zinc neutrals, rounded
  surfaces, a single subtle accent and semantic colors used sparingly. A single status line
  under the prompt carries everything: the animated load state while the agent works
  (`⣾ ▓░░░░ working · 34s`), the selected model, the working path, the checked-out git branch,
  step count and cost.
- **Output display modes** — collapsed (just a `1 tool call` line), trimmed to 2 lines, or fully
  expanded. Pick one in the **settings panel** (`/settings`); it persists across runs. `e` still
  expands or collapses any block individually.

  ![settings panel](docs/screenshots/settings.png)

- **`/resume` — saved sessions in SQLite.** Every conversation is stored
  (`~/.config/mini-tui/sessions.db`) with an AI-generated title (falling back to your prompt,
  trimmed). `/resume` opens a modal listing the sessions **started in the current folder**,
  paged and searchable by title — pick one to restore its transcript, and your next prompt
  continues the *same conversation with full context* (`mini --resume`, companion patch 3).

  ![resume modal](docs/screenshots/resume.png)

- **`/connect` — BYOK providers.** The whole MiniMax Code catalog — **Xiaomi MiMo, DeepSeek,
  OpenCode Go, Z.AI (GLM coding), MiniMax** — plus OpenAI, Anthropic, Moonshot, Zhipu, Groq and
  OpenRouter. Pick a provider, paste your API key, choose a model and the connection is
  **tested for real** (a one-token query through mini's own litellm-based model layer) before
  being saved locally. Every catalog model of a connected provider joins the `/model` picker,
  and its key is injected into your runs. All providers go through **litellm**: native prefixes
  (`xiaomi/…`, `deepseek/…`, `anthropic/…`, …) or litellm's `openai/` provider with
  `OPENAI_API_BASE`/`OPENAI_API_KEY` for any OpenAI-compatible endpoint (Z.AI, MiniMax, …).

  ![connect wizard](docs/screenshots/connect.png)

- **Modals, not layout shifts.** `/model`, `/settings`, `/resume`, `/connect` and `/help` open as
  floating modals centered over the transcript — the prompt bar and the bottom stack never move,
  and panels clip to the available area on short terminals.

- **`/help`** lists every command and key in one panel.

  ![help panel](docs/screenshots/help.png)

- **Tool call cards** with syntax-highlighted bash commands and a quiet focus marker.
- **Output cards** with `rc=0` / `rc=N` badges, exception info, and collapsible bodies
  (`… 220 lines hidden · [e] expand`) so huge outputs never blow up the layout.- **Live header** with model, step count, running cost and a spinner while a step is in flight.
- **`/model` — switch models mid-conversation.** Type `/model` in the prompt to open the model
  picker (or `/model <id>` to jump straight to one). During a live run the agent picks the new
  model up from its next step — no restart, no lost context.

  ![model picker](docs/screenshots/model-picker.png)

- **Plain-text final answers** (with the companion patch below): the agent finishes by simply
  answering instead of shuttling its answer through a temporary markdown file. The answer lands in
  the green `exit` banner, and you can type a follow-up to keep going.

  ![final answer](docs/screenshots/final-answer.png)

- **`view` mode** renders any existing trajectory (including
  `~/.config/mini-swe-agent/last_mini_run.traj.json`) with the same renderer.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3 (OpenTUI ships a native Zig renderer; Node ≥ 26.4 also works)
- `mini` on your `PATH`, configured as usual (your `~/.config/mini-swe-agent/.env` is honored)

## Install

```bash
git clone https://github.com/jaivial/mini-tui && cd mini-tui
bun install

# optional: make `mini-tui` available everywhere
cp bin/mini-tui ~/.local/bin/mini-tui && chmod +x ~/.local/bin/mini-tui
```

## Usage

```bash
# Just start it: the prompt bar is ready (like `mini -y -m <model>`, but pretty)
mini-tui
mini-tui -m xiaomi/mimo-v2.6-flash

# Or start immediately with a task
mini-tui run "Fix the failing test in test_utils.py" -m xiaomi/mimo-v2.6-flash

# Render an existing trajectory (add --follow to keep watching it)
mini-tui view ~/.config/mini-swe-agent/last_mini_run.traj.json

# Include the system prompt in the transcript
mini-tui run ... --show-system
```

Run artifacts live under `~/.config/mini-tui/runs/<timestamp>-<slug>/`
(`traj.json`, `mini.log`, `pid`, `control`). mini-tui never touches
`~/.config/mini-swe-agent/last_mini_run.traj.json` — it always passes its own `-o`.

## Keys

| Key | Action |
| --- | --- |
| `Enter` | send the prompt (starts a task, or continues the running conversation) |
| `Alt+Enter` / `Ctrl+J` | insert a newline in the prompt (`Shift+Enter` too where the terminal reports it) |
| `/` | opens the command palette: `↑`/`↓` or click to select · `Enter`/`Tab` fills the prompt (never sends) |
| `Esc` | close the palette / leave the prompt · **double `Esc` closes** (interrupting the run) |
| `ctrl+c` | clear the prompt · on an empty prompt (twice) closes |
| `/quit` · `/exit` | close mini-tui |
| `/help` | commands and keys |
| `/model` | open the model picker (or `/model <id>` for a direct switch) |
| `/settings` | output display (collapsed / trimmed / expanded) |
| `/resume` | browse sessions saved in this folder (search + pages) |
| `/connect` | connect a BYOK provider (key → model → tested connection) |
| `j` / `k` (or ↓ / ↑) | (navigation mode) move between tool call blocks |
| `e` | expand / collapse the focused output block |
| `PgUp` / `PgDn` | scroll |
| `g` / `G` | top / bottom |

## How it works

```
mini-tui run
  ├─ src/mini/spawn.ts   spawns: mini -y --exit-immediately -o <session>/traj.json -m <model> -t <task>
  │                      raw stdout/stderr → <session>/mini.log
  ├─ src/traj/watch.ts   polls <session>/traj.json every 200 ms (rewritten by the harness per step)
  ├─ src/traj/parse.ts   pure parser: messages → RunEvent[] (tools, outputs, notices, exit)
  └─ src/ui/             OpenTUI + React renderer (cards, badges, banners, prompt, /model picker)
```

The parser tolerates mid-write reads (the harness rewrites the file non-atomically after every
step), unknown message shapes, and multimodal content in any of the message formats mini produces.

### Follow-ups and `/model` under the hood

mini-tui appends `MESSAGE <text>` / `MODEL <id>` lines to the run's control file
(`<session>/control`, exported to `mini` as `MSWEA_CONTROL_FILE`). The companion harness patch:

- injects `MESSAGE` lines as `UserNewTask` prompts — from the agent's next step mid-run, and after
  a submission via an *exit hold* (the run stays open so one conversation can span many turns);
- applies `MODEL` switches from the next step.

## Companion mini-swe-agent patches (optional)

Three small patches to your local mini-swe-agent unlock the nicest behaviors. Everything works
without them except live `/model` switching, conversational follow-ups and context-carrying
`/resume`. See [docs/mini-swe-agent-patches.md](docs/mini-swe-agent-patches.md) for the exact changes:

1. **Plain-text final answer** — a response with text and no tool calls is the submission
   (no more `cat > /tmp/final_answer.md` round-trips).
2. **Control file** — `MODEL <id>` switches the running agent's model from its next step;
   `MESSAGE <text>` continues the conversation mid-run or at the exit hold (both no-ops when
   `MSWEA_CONTROL_FILE` is unset).
3. **`--resume`** — reloads a previous conversation's message history as context and treats
   the new task as a follow-up (what `/resume` + prompt uses).

## Development

```bash
bun test          # parser fixtures + in-memory OpenTUI render tests (no TTY, no network)
bun run typecheck
bun run screenshots   # regenerates docs/screenshots/*.png from scripted scenes
```

## Notes and known limits

- Yolo only: runs use `mini -y --exit-immediately` — the UI visualizes and forwards prompts, it
  never confirms or rejects commands.
- No token streaming: the trajectory updates once per step, so the spinner covers model calls and
  command execution. Follow-ups sent mid-step are picked up at the next step.
- After a submission the run stays open ("type to continue") while the TUI is attached; quitting
  the TUI ends it.
- The code highlighter degrades to plain text when a tree-sitter grammar is unavailable.
- If the TUI is killed hard, the `mini` child may survive: check `<session>/pid` and
  `pgrep -af "mini -y --exit-immediately"`.
