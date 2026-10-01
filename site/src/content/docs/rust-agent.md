---
title: Python or Rust agent
description: The bundled Python mini-swe-agent or its Rust port, one static binary: how they compare, how to install the Rust agent with one command, and how to choose.
section: Start
order: 2
---

mini-tui drives a coding agent: the loop that asks the model, runs its commands and reports back. It
ships two interchangeable ones:

- **The Python agent:** the bundled [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent), installed with `pip`.
- **The Rust agent:** `mini-agent-rs`, a port of the same runner, as one self-contained binary.

Both read the same configs and `~/.config/mini-swe-agent/.env`, take the same command line, and write the
same trajectory and journal. They read the same control file, so `/model` and follow-ups work the same.
The terminal UI, `mini-tui -p` and the web app work with either one. A session started on one can be
resumed on the other.

## How they compare

Measured on one Linux box with the same scripted task (the parity suite's `basic` scenario), median of
five runs:

| | Python agent | Rust agent |
| --- | --- | --- |
| Start the runner | 65 ms | 0.7 ms |
| One scripted turn, start to finish | 661 ms | 51 ms |
| A session waiting for your next message | 35.7 MB | 4.5 MB |
| Needs | Python 3.10+ and the agent's packages | nothing: one 6.7 MB static binary |
| Install | `pip install -e ./agent` | download one file |
| Session titles and key tests | a Python helper each | built in (`title`, `test-model`) |

The memory line matters most in the web app. Every open session keeps an agent waiting for your next
message: ten idle sessions hold about 45 MB on Rust and about 357 MB on Python.

Model calls take the same time with both: the model is the slow part of a real turn. The Rust agent
saves the start-up, the time between steps, and the memory.

## Install the Rust agent

The static build runs on any x86-64 Linux, with no Python needed. Put it where mini-tui looks for it:

```bash
mkdir -p ~/.local/lib/mini-tui
curl -fLo ~/.local/lib/mini-tui/mini-agent-rs \
  https://github.com/jaivial/mini-tui/releases/latest/download/mini-agent-rs-x86_64-linux-musl
chmod +x ~/.local/lib/mini-tui/mini-agent-rs
```

That is all: the next `mini-tui` uses it. To check the download first, compare it with the release's
checksums:

```bash
cd ~/.local/lib/mini-tui
curl -fsSLO https://github.com/jaivial/mini-tui/releases/latest/download/SHA256SUMS
grep linux-musl SHA256SUMS | sed 's/mini-agent-rs-x86_64-linux-musl/mini-agent-rs/' | sha256sum -c -
```

### Or build it from source

With a Rust toolchain, from the mini-tui checkout:

```bash
cd agent-rs && cargo build --release        # target/release/mini-agent-rs, found automatically
cargo build --release --target x86_64-unknown-linux-musl   # a static binary to copy to other boxes
```

## Which one runs

When mini-tui finds a Rust binary it uses it, and otherwise it uses Python. It looks, in order, at:

1. `MINITUI_AGENT_BIN`, a path you set;
2. `agent-rs/target/release/mini-agent-rs` in the checkout;
3. `~/.local/lib/mini-tui/mini-agent-rs`;
4. `mini-agent-rs` on your `PATH`.

```bash
mini-tui                          # Rust if a binary is found, else Python
MINITUI_AGENT=python mini-tui     # the Python agent, on purpose
MINITUI_AGENT=rust mini-tui       # Rust, and a warning if no binary is found
```

`mini-tui -p -o stream-json` names the agent it used in its first line (`"runner": "rust"`).

For the web app as a service, set the same variables in the unit:

```ini
[Service]
Environment=MINITUI_AGENT_BIN=/home/you/.local/lib/mini-tui/mini-agent-rs
```

## What the Rust agent covers

Everything mini-tui uses:

- **The loop:** step and cost limits, follow-ups, live `/model`, `/compact` and automatic compaction,
  `--resume`, and interrupts.
- **Models:** cli-proxy, Rosetta, DeepSeek, Xiaomi, OpenAI, Anthropic, the provider registry, and
  OpenCode Go.
- **Environments:** local and Docker.

A few things are deliberately not ported, because mini-tui never uses them: the litellm, portkey,
requesty and OpenRouter-SDK model classes, the singularity, bubblewrap, contree and swerex environments,
the interactive confirm mode, and `mini-extra`. Asking for one of them is an error that names what is
supported.

## How it is kept identical

`agent-rs/tests/parity/run_all.sh` runs both agents on the same scripted tasks against the same scripted
HTTP servers: 26 scenarios plus 8 helper cases. For each one it checks that both agents:

- write identical trajectories and journals;
- exit the same way;
- send byte-identical requests to the model.

```bash
cd agent-rs && cargo test --release && sh tests/parity/run_all.sh   # ends with "ALL IDENTICAL"
```
