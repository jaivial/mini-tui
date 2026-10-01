---
title: Install mini-tui
description: Install mini-tui from source with Bun and Python in about a minute, then start the terminal UI or the web app. Requirements, the bundled agent, and updating.
section: Start
order: 1
---

## Requirements

- **[Bun](https://bun.sh) 1.3 or newer.** OpenTUI ships a native renderer; Node 26.4 or newer also works.
- **Python 3.10 or newer** with the bundled agent installed, or any `mini` on your `PATH`. Your
  `~/.config/mini-swe-agent/.env` is honored either way.
- A model key for at least one provider, or a running gateway. You add keys later, inside the app.

## Install

```bash
git clone https://github.com/jaivial/mini-tui && cd mini-tui
bun install
python3 -m pip install -e ./agent   # the bundled mini-swe-agent: `mini` and `mini-swe-agent-tui`
```

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
git pull && bun install && python3 -m pip install -e ./agent
```

Release notes are in the [changelog](https://github.com/jaivial/mini-tui/blob/main/CHANGELOG.md).
