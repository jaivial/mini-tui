# mini-tui web

A browser front end for mini-tui. Same sessions, same agent, same history as
the terminal UI — with a sidebar for running several at once and a remote mode
that keeps the agent headless on a server over SSH while the UI stays here.

## Run it

```bash
bun run web          # build the UI and serve everything on :4317
bun run web:serve    # API only (no build needed)
bun run web:dev      # Vite dev server on :4318, proxying /api to :4317
bun run web:check    # svelte-check
cd web && bun run build && bun run shots   # desktop/tablet/phone screenshots (mocked API) -> /tmp/minitui-shots
cd web && bun scripts/audit.mjs            # touch-target + overflow audit at the three sizes
cd web && bun run e2e                      # real browser + real server: sockets, model picker, reconnect
```

Open <http://127.0.0.1:4317>.

## How it fits together

```
web/            Svelte 5 + Tailwind v4 front end (this directory)
src/web/        the server: JSON + SSE API, session manager, SSH transport
src/traj/       the TUI's parser and journal watcher (shared, not reimplemented)
src/sessions.ts the SQLite history the terminal UI's /resume reads
```

A session started in the browser is written to the same
`~/.config/mini-tui/sessions.db` the terminal UI reads, so `/resume` sees it and
vice versa.

### Local sessions

`spawnMini` (the TUI's own runner) with the control channel left on, so
follow-ups continue the same conversation mid-run. The trajectory journal is
watched and parsed with the TUI's incremental parser — the web UI renders
exactly the events the terminal UI would.

### Remote sessions (SSH)

The agent runs **headless on the server**; the UI never leaves this machine.

```
ssh -T <host> bash -s   ← the script, over stdin
  mini-tui -p "$MINITUI_PROMPT" -o stream-json -v --no-session
```

- The prompt is substituted into the script as a **single-quoted literal**, so a
  prompt full of quotes, newlines or `;` stays one argument and can never
  execute on the server.
- `BatchMode=yes`, so a missing key fails immediately instead of hanging on a
  password prompt.
- Progress comes back as the agent's own `stream-json` lines on stdout, mapped
  onto the shared `RunEvent` contract — one channel, no polling.

Requires `mini-tui` (or `mini`) on the server's `PATH`; the script adds
`~/.local/bin` because a non-interactive ssh gets a bare `PATH`. Use **Test** in
the hosts panel to check reachability and agent presence.

## Live streaming: one socket per session

```
GET /api/stream                     SSE, shared. Metadata only: title, status, cost, model.
GET /api/sessions/:id/socket        WebSocket, one per session. That session's transcript.
```

The sidebar needs to know that *something* changed in every session; it does not need their
transcripts. So the shared SSE stream carries no events, and each open transcript arrives on its
own socket: a `snapshot` on connect, then `delta` frames holding only the events appended since
the last frame (`{t:"delta", from, events, meta, partial}`). A busy session never spends another
session's bandwidth, and a session's socket only ever sees that session (`src/web/feed.ts`).

The browser holds a socket for the active session and for every running one
(`web/src/lib/stores/sessions.svelte.ts`), so switching to a session that has been working in the
background shows a transcript that is already current. `web/src/lib/session-socket.ts` owns the
connection: jittered exponential backoff, an immediate retry when the tab becomes visible or the
network returns, a 20s heartbeat (a half-open TCP connection on a phone never fires `close`), and
a stop on `gone` / close code 4404. A `from` that does not line up with what the client holds
triggers a `resync`, never a guess. The handshake refuses cross-site origins, and `messages` (raw
model I/O) never leaves the server.

nginx must forward the upgrade on `/api/sessions/<id>/socket` (`Upgrade` + `Connection` headers,
`proxy_buffering off`, a long `proxy_read_timeout`); the plain proxy block does not.

## New chat, commands, skills and settings

**A new chat is a draft.** `/new`, the sidebar's *New chat* and Ctrl/Cmd+K clear the active session and show
an empty chat; nothing is created on the server. The first message creates the session, on the target and
model chosen in the draft (`web/src/lib/stores/chat.svelte.ts`). Abandoning a draft costs nothing.

**Prompt bar height.** One line (44px, also the touch target) when empty; it grows a whole line at a time up to five, then scrolls (`lib/grow.ts`, `Composer.svelte`). The height is measured on a hidden mirror of the field rather than on the field itself, so the visible box is never collapsed and re-expanded per keystroke, and each step is eased with the motion token (a paste eases up to the cap instead of snapping to it; reduced motion turns the easing off). A long placeholder is clipped to one line so it cannot make an empty bar taller, an unbroken 600-character token wraps instead of widening the page, and a width change (rotation, the sessions drawer) re-fits the height without typing.

**Chips.** Picking a command or skill from the menu lifts it out of the text into a chip above the field (`lib/chips.ts`, `components/Chip.svelte`). The field stays a plain textarea, so IME, autocorrect, paste and screen readers keep working; the chips are joined to the text (`$skill ... typed text`, or `/command arg`) only when the message is sent. One command at most, and never beside skills; a skill once. Backspace at the start of an empty bar removes the last chip, and each chip has a remove button (44px hit area on touch). The Commands and Skills buttons on a phone use the same square-slash and sparkles icons as the chips.

**Prompt bar completion** (`lib/completion.ts`, pure and tested): `/` at the start of a message lists commands;
`$` anywhere lists skills, matched and ranked by the terminal UI's own code (`src/skillMatch.ts`). Enter or Tab
*fills* the pick and never runs it, so a stray Enter cannot fire `/new`. A path (`/etc/hosts`) or prose that
starts with a slash goes to the agent unchanged; a bare unknown word (`/modle`) is reported and kept.
On touch there are `/` and `$` buttons, since a phone keyboard buries both characters.

**Settings** (Ctrl/Cmd+comma, `/settings`, `/connect`, `/skills`): General (colour mode, accent, command output
mode, shared with the terminal), Providers (connect / disconnect a BYOK key), Skills (what `$name` can find).

**API keys never come back out.** They go in through `POST /api/providers/connect`, are validated with a real
one-token completion, and are only saved if it passes (a typo never replaces a working connection). They are
stored in `providers.json` (0600), exactly as the terminal's `/connect` does. Every read returns a masked hint
(`sk-...a1b2`). A connected provider's key is injected into a run only for a model that belongs to it.

Every state-changing request must come from this app's own origin (403 otherwise), so a page on another
site cannot start agents or write keys through your browser.

## API

| Method | Path | Meaning |
| --- | --- | --- |
| `GET` | `/api/stream` | SSE: every session and host change |
| `GET` | `/api/sessions` | live sessions (metadata, no transcript) |
| `GET` | `/api/sessions/:id/socket` | WebSocket: that session's transcript |
| `POST` | `/api/sessions` | start one (`target: local \| remote`, `hostId`) |
| `POST` | `/api/sessions/:id/prompt` | follow-up in the same conversation |
| `POST` | `/api/sessions/:id/interrupt` | stop the run |
| `DELETE` | `/api/sessions/:id` | close and drop it |
| `GET` | `/api/hosts` · `PUT` · `DELETE` | remote host settings |
| `POST` | `/api/hosts/probe` | test a host (`{ok, agent, version}`) |
| `GET` | `/api/history` | the shared `/resume` history |
| `GET` | `/api/commands` · `/api/skills` | prompt-bar completion data |
| `GET` `PATCH` | `/api/settings` | display settings (shared with the TUI) |
| `GET` | `/api/providers` | connected (masked) + the catalogue |
| `POST` | `/api/providers/connect` | test and save a key |
| `DELETE` | `/api/providers/:id` | forget a connection |
| `POST` | `/api/sessions/:id/compact` | `/compact` (live local run only) |

Hosts are stored in `~/.config/mini-tui/web-hosts.json`; override the folder with
`MINITUI_CONFIG_DIR`.

## Keys

| Key | Action |
| --- | --- |
| `Ctrl/Cmd+K` | new session |
| `Ctrl/Cmd+B` | toggle the sidebar |
| `Enter` | send · `Shift+Enter` newline |
| `Esc` | close a modal |
