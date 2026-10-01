---
title: Install mini-tui
description: Install mini-tui with Bun in about a minute, with the Rust agent (one binary, no Python) or the bundled Python agent, then start the terminal UI or the web app.
section: Start
order: 1
---

## Requirements

- **[Bun](https://bun.sh) 1.3 or newer.** OpenTUI ships a native renderer; Node 26.4 or newer also works.
- **An agent**, one of:
  - **the Rust agent** (recommended): one static binary, no Python. It starts in under a millisecond and
    holds about 4.5 MB per waiting session.
  - **Python 3.10 or newer** with the bundled agent installed, or any `mini` on your `PATH`.

  Your `~/.config/mini-swe-agent/.env` is honored either way. See
  [Python or Rust agent](/docs/rust-agent/) for the comparison.
- A model key for at least one provider, or a running gateway. You add keys later, inside the app.

## Install

```bash
git clone https://github.com/jaivial/mini-tui && cd mini-tui
bun install
```

Then the agent. **With Rust** (recommended), download the static binary where mini-tui looks for it:

```bash
mkdir -p ~/.local/lib/mini-tui
curl -fLo ~/.local/lib/mini-tui/mini-agent-rs \
  https://github.com/jaivial/mini-tui/releases/latest/download/mini-agent-rs-x86_64-linux-musl
chmod +x ~/.local/lib/mini-tui/mini-agent-rs
```

**Or with Python**, the bundled mini-swe-agent:

```bash
python3 -m pip install -e ./agent   # `mini` and `mini-swe-agent-tui`
```

With both installed, mini-tui uses Rust. `MINITUI_AGENT=python` picks Python.

Optionally, make `mini-tui` available everywhere:

```bash
cp bin/mini-tui ~/.local/bin/mini-tui && chmod +x ~/.local/bin/mini-tui
```

## Start it

```bash
mini-tui                      # the terminal UI, prompt bar ready
bun run web                   # the web app on http://127.0.0.1:4317
```

The web app builds its interface first, then serves everything from one process. To work on it with hot
reload, use `bun run web:dev`.

## Connect a model

Open `/connect` in the terminal UI, or **Settings, Providers** in the web app. Paste a key and mini-tui
sends one real request to check it before saving anything. Keys are stored in
`~/.config/mini-tui/providers.json` with `0600` permissions and are never sent back out by the web API.

## Update

```bash
git pull && bun install
# Rust agent: download the latest binary again (same command as above)
curl -fLo ~/.local/lib/mini-tui/mini-agent-rs \
  https://github.com/jaivial/mini-tui/releases/latest/download/mini-agent-rs-x86_64-linux-musl
# Python agent:
python3 -m pip install -e ./agent
```

Release notes are in the [changelog](https://github.com/jaivial/mini-tui/blob/main/CHANGELOG.md).
