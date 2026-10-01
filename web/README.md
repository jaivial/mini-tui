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
cd web && bun scripts/e2e-windows.mjs      # windows: move a pane, switch, reload, rename, close
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

**As a systemd service**: `deploy/mini-tui-web.service` (edit `User=`, `WorkingDirectory=` and the bun
path, then `sudo cp` it to `/etc/systemd/system/` and `systemctl enable --now` it). It leaves
`NoNewPrivileges` off on purpose. With it on, the kernel ignores the setuid bit, so every `sudo` run by
an agent or typed in the terminal fails with *the "no new privileges" flag is set*. What `sudo` may do
is then up to the account's sudoers rules, as in the terminal UI. `tests/deploy-unit.test.ts` keeps it
that way.

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

**Windows** (tmux style). The screen shows one window at a time; each holds its own panes. The sidebar lists
them with a pane count and a status dot per pane (live while it works; done when a turn it was
running finishes, until you click that pane; idle otherwise), and has a **New window** button, a pencil renames one (nothing goes back to "Window 3"),
and any pane can move to another window or to a new one from its pane menu — its session, its tab and its
notes go with it, the window it leaves folds if that was its last pane, and the app follows the pane. A new
window starts empty. Switching window swaps the panes over, a half-typed prompt included, and the sessions of
every window keep streaming while another is on screen.

**Panes.** Up to **12** in a window. Split the focused pane right with `Ctrl+\` (or `/split`) or down with
`Ctrl+Shift+\` (`/split down`), or use the pane menu in the header. Each new pane is a new chat, so its first
message starts its own session, and every pane streams its session over its own socket while the others run.
Drag a divider to resize it, or focus it and use the arrow keys (Home/End go to the limits, Enter evens it
out). `Alt+1`…`Alt+9` and `Alt+0` jump to a pane, `Ctrl/⌘+Alt+arrows` cycle, and `Alt+X` closes one (its
session keeps running). A session is shown in one pane at a time: picking one that another pane shows goes to
that pane, or to the window holding it. A split that would leave a pane too small to use is refused with the
reason. The layout, each pane's session and the windows are remembered in the browser. Below 760px (a phone,
or a small tablet) the same panes show as tabs, one on screen at a time. The layout logic is `lib/panes.ts`,
pure and tested; the windows are `lib/stores/windows.svelte.ts`.

**One workspace everywhere.** The windows, panes, which session each pane shows, the status dots and the
sidebar's view and folders are kept on the server (`~/.config/mini-tui/web-workspace.json`), not in the
browser. Every device, browser and tab shows the same thing, and a change on one shows on the others at once.
It travels over the hub socket like notes (`ws.watch` / `ws.save`, versioned, so two devices changing it
together end on one layout; `src/web/workspace.ts`, `web/src/lib/workspaceClient.ts`). A half-typed prompt,
its chips and the ↑/↓ memory stay in their tab, and so do the interface and text sizes and the theme.

**Notes** (the notebook button in a pane's header, `/notes`, or `Ctrl/⌘+Shift+.`): a sidebar on the pane's
right with a plain text area for that session. It saves 600 ms after you stop typing, and also when the panel
closes, on blur, on `Ctrl/⌘+S`, and when the page hides. Notes are stored in the shared database (a `notes`
table, so a history listing never reads them) and deleted with their session. In a narrow pane the notes cover
the chat instead of squeezing both.

**Terminal** (the terminal button in a pane's header, the **Terminal** tab beside Notes, `/terminal`, or
`Ctrl+\``): an interactive shell for that session. It is a real PTY on the server (`src/web/terminals.ts`),
started in the session's folder, or an `ssh -tt` login shell on the session's remote host, in its folder.
xterm.js draws it, loaded only when the first terminal opens. It streams over the hub socket like notes:
keys go up as `term.input`, output comes down as `term.data` (coalesced, and a flood is cut to its tail).
Hiding the panel, switching to Notes or reloading the page keeps the shell running, and coming back replays
its recent output. **Restart** ends it and starts a fresh one; a shell nobody watches ends after 10 minutes,
and all of them end with the server. Inside the terminal the shell owns Ctrl+letters (Ctrl+C, Ctrl+K,
Ctrl+B...); only pane shortcuts (Ctrl+\`, Alt+1…6, Ctrl/⌘+Alt+arrows) reach the app. **It is a shell as the
user the server runs as**, so the server must stay behind authentication (the nginx login here), and
`MINITUI_WEB_TERMINAL=0` turns it off.

**The right sidebar goes through one socket, never REST and never polling.** A tab opens a single hub socket,
`/api/hub`, the first time a notes panel appears, and every pane shares it. A note is *watched*: the hub answers
with its current value at once, then pushes every change made anywhere. An edit on another device shows up live.
If you are typing, the edit is held back and you get **Keep mine** / **Use theirs** (which copies your text to the
clipboard first). A save is a message on the same socket naming the version it started from. The sender gets
`note.saved` or `note.conflict`, and the other watchers get the new value. The socket reconnects like the
session sockets (backoff, immediately on "online" or when the tab is shown, a heartbeat for half-open
connections), and re-watches everything, so what changed while it was down arrives on reconnect. There is no
`/api/notes` endpoint. The protocol lives in `src/web/hub.ts` (tested without a network) and
`web/src/lib/hub.ts` + `notesClient.ts` (tested against a fake socket).

| Client → hub | Hub → client |
| --- | --- |
| `{t:"note.watch", id}` / `{t:"note.unwatch", id}` | `{t:"hello", limits:{noteMax}}` on connect |
| `{t:"note.save", id, body, base, req}` | `{t:"note", note}` on watch and on every change elsewhere |
| `{t:"term.open", id, session?, cols, rows}` · `{t:"term.input", id, data}` · `{t:"term.resize", id, cols, rows}` · `{t:"term.detach", id}` · `{t:"term.close", id}` | `{t:"term.opened", id, cwd, title, replay, alive}` · `{t:"term.data", id, data}` · `{t:"term.exit", id, code}` |
| `{t:"ping"}` | `{t:"note.saved", req, note}` / `{t:"note.conflict", req, current}` / `{t:"error", req?, error}` / `{t:"pong"}` |

**Size** (Settings › General › Size): **Interface size** (85-140%) zooms everything, like page zoom kept to
this app. **Text size** (90-150%) grows only what you read and write: the transcript, command output, the
prompt and notes. Shortcuts: `Ctrl/⌘ +`/`−` for the interface, the same with Shift for text, and `0` to
reset. On a touch screen the interface never goes below 100%, so taps stay 44px. Both are remembered in
the browser.

**By folder.** The sidebar's **Recent / By folder** switch groups every session by the folder it ran in. Each
folder shows its name, where it lives, its count, a dot while something in it runs, and its open and saved
sessions, 20 at a time. A folder with open sessions (or pinned) starts expanded; what you open or close,
what you pin and which view you use are remembered in the browser. The **+** on a folder starts a new chat
there (on the same host, for a remote folder). `lib/sessionFolders.ts` holds the grouping rules (tested).
The folder list is `GET /api/history/folders` (index only, instant), and a folder's sessions are
`GET /api/history?cwd=`, loaded when the folder is opened and re-read only when a session in it changes.

**Sidebar history.** Below the open sessions, **History** lists every session saved in the shared database
(terminal ones too), grouped by day, 50 at a time with **Show more**. The search box searches the whole
database on the server. Opening one shows its transcript in the focused pane. **All** opens the Resume panel,
where saved sessions can also be deleted.

**Folder picker.** A new chat's prompt bar has a **Folder** button: a browser for the folders of the machine the
chat will run on. That is this server for **Local**, or the selected host for a remote target, where it lists
over the same ssh the run will use. Type or paste a path and press Enter to go there. Click a folder to open it,
Backspace in an empty field goes up, and **Use this folder** picks it. It lists names only, directories only,
at most 500 per folder. The folder is checked when the session is created: a local one must exist on this
machine. A remote chat, and every follow-up turn, starts in the folder (the host's default workdir if none was
picked). `lib/folderPath.ts` and `src/web/folders.ts` hold the pure parts, both tested. The remote listing script
is tested by running it through `bash -s`, as ssh does.

**Prompt memory.** Press `↑` on the first line of the prompt bar to recall this chat's earlier prompts, and `↓`
on the last line to go forward and back to the draft you were writing. Inside a multi-line message the arrows
move the cursor. Commands and skills come back as chips. The memory is seeded from the transcript, so a reload
or `/resume` keeps it (`lib/promptMemory.ts`, the same rules as the TUI's `src/history.ts`).

**Finish toasts.** When a session you are not looking at finishes or fails, a toast says so, with **View**
to open it (in the pane already showing it, else the focused one) and focus its prompt bar. It is announced
once per turn (`lib/finish.ts`). A session you are watching, or one you stopped yourself, is not announced.

**Changing the model never starts work.** During a run it applies from the agent's next step. After a finished
or interrupted turn it only changes the model: the status stays, and your next message runs on it.

**Resume** (`/resume`, or "Resume a session" on the empty chat page): opens every session saved in the shared
database, including ones started in the terminal and ones this browser never opened, so it works from a new
chat with nothing running. Type to search the title, the first message and the folder; arrows and Enter open
one. Opening shows the old transcript at once and sending continues it: the agent is started with the saved
conversation (`--resume`), in the session's own folder and on its own model. A session that never reached a
model call has nothing to continue from: it can be read, it says so, and sending to it is refused with the
reason instead of starting an agent with no context. **Closing a session keeps it in the history**; deleting is
a separate, confirmed action in this panel.

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
| `POST` | `/api/sessions/:id/prompt` | follow-up in the same conversation (409 with the reason if there is nothing to continue from) |
| `POST` | `/api/sessions/:id/interrupt` | stop the run |
| `DELETE` | `/api/sessions/:id` | close it (stops it, keeps it in the history) |
| `GET` | `/api/hosts` · `PUT` · `DELETE` | remote host settings |
| `POST` | `/api/hosts/probe` | test a host (`{ok, agent, version}`) |
| `GET` | `/api/history?q=&limit=&cwd=` | the shared `/resume` history, newest first, metadata only. `q` searches title, task and folder (`%` and `_` are literal); `cwd` keeps one exact folder; `limit` is 1-500, default 50. Each row has `resumable` and `open` |
| `POST` | `/api/history/:id` | open a saved session (404 if unknown; returns the copy already held if open) |
| `DELETE` | `/api/history/:id` | delete a saved session for good, notes included (404 if unknown) |
| `GET` | `/api/history/folders` | every folder with saved sessions: `[{cwd, count, updatedAt}]`, most recent first |
| `GET` | `/api/folders?path=&hostId=` | subfolders of `path` on this machine, or on a saved remote host over ssh: `{path, parent, home, entries: [{name, path, hidden, git}], truncated}`. 404 missing, 400 not a folder, 403 no permission, 502 host unreachable, 504 timeout |
| `GET` | `/api/hub` | WebSocket: the tab's one hub socket for the right sidebar (notes). See below |
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
