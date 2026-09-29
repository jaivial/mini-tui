---
title: The web app
description: Run mini-tui in a browser: several sessions at once, one WebSocket per session, draft chats, command and skill chips, a model switcher, and phone support.
section: Web app
order: 2
---

The web app is the same agent as the terminal UI, in a browser. Sessions started in either front end land
in the same `~/.config/mini-tui/sessions.db`, so `/resume` in the terminal sees what you started on the web,
and the reverse.

## Run it

```bash
bun run web        # build the UI and serve everything on http://127.0.0.1:4317
bun run web:dev    # Vite dev server with hot reload
```

To reach it from another device, put it behind a reverse proxy with authentication. The API starts agents and
stores provider keys, so it must never be exposed without a login in front of it.

## Several sessions at once

The sidebar lists every session. A running session keeps streaming in the background, so switching to it
shows a transcript that is already current.

Each open session streams over **its own WebSocket** (`/api/sessions/:id/socket`): a snapshot when it
connects, then small deltas holding only the events added since the last frame. The shared event stream only
carries what the sidebar needs (title, status, cost), so a busy session never spends another session's
bandwidth. The browser reconnects with jittered backoff and a heartbeat, retries at once when a phone wakes,
and asks for a fresh snapshot if a frame does not line up.

## A new chat is a draft

`/new` (or **New chat**, or Ctrl/Cmd+K) shows an empty chat and creates nothing on the server. The first
message creates the session, on the model and host you picked. Abandoning a draft costs nothing.

## The prompt bar

- One line when empty. It grows a line at a time up to five, then scrolls.
- **`/`** at the start opens commands. **`$`** anywhere opens skills, matched by the same code as the terminal UI.
- A pick becomes a **chip** above the field and is joined to your text only when you send. The field stays a
  plain textarea, so IME, autocorrect, paste and screen readers keep working.
- **Enter** sends, **Shift+Enter** adds a line.

## Model switcher

Opens from the prompt bar. Searchable, grouped by provider and driven by the keyboard: type to filter, arrow
keys to move, Enter to pick, Escape to close. A model that is not in the list can be typed.

## Settings and providers

Appearance, command-output mode (shared with the terminal), skills, and providers. A key is tested with a real
request before it is saved.

## On a phone

44px touch targets, dialogs that rise as bottom sheets, safe-area insets, `dvh` layout and a keyboard-aware
prompt bar. Light and dark, six accent palettes.
