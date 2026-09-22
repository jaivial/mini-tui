# mini-tui

A pretty terminal UI for [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent), built with
[OpenTUI](https://opentui.com) (React + Bun).

It only **parses and reformats** what `mini` already produces — tool calls (bash commands) and their
outputs — into cards, badges and banners. The harness runs completely untouched: mini-tui spawns
`mini` as a subprocess and reads the trajectory JSON it rewrites after every step.

![mini-tui running a task](docs/screenshots/run.png)

## Features

- **Prompt bar, Claude-Code style.** A prompt input pinned to the bottom of the screen: type your
  task, hit Enter, and keep typing follow-ups while the agent works (or after it submits) — they
  continue the *same* conversation.

  ![prompt bar](docs/screenshots/prompt.png)

- **Tool call cards** with syntax-highlighted bash commands and a focused-block indicator.
- **Output cards** with `rc=0` / `rc=N` badges, exception info, and collapsible bodies
  (`… 220 lines hidden · [e] expand`) so huge outputs never blow up the layout.
- **Live header** with model, step count, running cost and a spinner while a step is in flight.
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
# Open the prompt and go (like `mini -y -m <model>`, but pretty)
mini-tui run
mini-tui run -m xiaomi/mimo-v2.6-flash

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
| `Esc` | leave the prompt and navigate the transcript |
| `i` / `Enter` | (navigation mode) jump back to the prompt |
| `/model` | typed in the prompt: open the model picker (or `/model <id>`) |
| `j` / `k` (or ↓ / ↑) | (navigation mode) move between tool call blocks |
| `e` | expand / collapse the focused output block |
| `PgUp` / `PgDn` | scroll |
| `g` / `G` | top / bottom |
| `q` | (navigation mode) quit — `ctrl+c` also quits while typing |

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

Two small patches to your local mini-swe-agent unlock the nicest behaviors. Everything works
without them except live `/model` switching and conversational follow-ups. See
[docs/mini-swe-agent-patches.md](docs/mini-swe-agent-patches.md) for the exact changes:

1. **Plain-text final answer** — a response with text and no tool calls is the submission
   (no more `cat > /tmp/final_answer.md` round-trips).
2. **Control file** — `MODEL <id>` switches the running agent's model from its next step;
   `MESSAGE <text>` continues the conversation mid-run or at the exit hold (both no-ops when
   `MSWEA_CONTROL_FILE` is unset).

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
