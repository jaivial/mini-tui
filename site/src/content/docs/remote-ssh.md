---
title: Run the agent over SSH
description: Keep the coding agent headless on a server while the mini-tui web UI stays on your machine. How remote hosts work and how the prompt travels safely over ssh.
section: Web app
order: 3
---

Remote mode keeps the **agent headless on a server** while the UI stays on your machine. Use it to run on a
beefier box, close to the code, or somewhere your laptop is not.

## Add a host

Open **Remote hosts** in the sidebar, add the host, user, port and working folder, and press **Test**. Test
reports whether the server is reachable and whether `mini-tui` is on its `PATH`.

You need `mini-tui` (or `mini`) installed on the server. Authentication uses your own `~/.ssh/config` keys.

## What runs where

```
ssh -T <host> bash -s        the script travels over stdin
  mini-tui -p "$PROMPT" -o stream-json -v --no-session
```

Progress comes back as the agent's own `stream-json` lines on stdout, mapped onto the same events the local
transcript uses. There is one channel and no polling.

## Why the prompt cannot run as a command

The prompt is substituted into the script as a **single-quoted literal**, so a prompt full of quotes,
newlines or `;` stays one argument and can never execute on the server. `BatchMode=yes` makes a missing key
fail immediately instead of hanging on a password prompt.

## Limits

A remote run is one process per turn, so there is no control channel: a model change applies from the next
turn, and `/compact` needs a live local run.
