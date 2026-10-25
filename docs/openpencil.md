# OpenPencil (self-hosted) in mini-tui

[OpenPencil](https://openpencil.dev) is an open-source design editor. Its MCP server drives the
desktop app: render JSX into layers, edit them, lint, and export. mini-tui runs both on this
machine, headless, and gives its agents the tools as `mcp__openpencil__<tool>`.

```
mini-tui agent ──HTTP + Bearer──▶ openpencil-mcp-http :7600 ◀──WebSocket── OpenPencil desktop (Xvfb :97)
                                   token: ~/.openpencil/token        discovery: ~/.openpencil/mcp.json
```

## Install (once)

```bash
# the MCP server (the app looks for it on PATH: ~/.npm-global/bin)
npm i -g @open-pencil/mcp@0.16.0
# the desktop app, extracted (no FUSE needed) and a virtual screen
mkdir -p ~/.local/opt/openpencil && cd ~/.local/opt/openpencil
~/Downloads/OpenPencil_0.16.0_amd64.AppImage --appimage-extract && mv squashfs-root 0.16.0 && ln -sfn 0.16.0 current
sudo dnf install -y xorg-x11-server-Xvfb          # apt: xvfb
# the service
cp ~/mini-tui/deploy/openpencil-mcp.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now openpencil-mcp
loginctl enable-linger "$USER"
```

Then install it in mini-tui: **Settings → MCP → OpenPencil** (web) or `/mcp` → OpenPencil
(terminal). Nothing to log in to: the token is read from `~/.openpencil/token` on every run, never
copied into `mcp.json`.

## Why it is set up this way

- **The server is started by the unit, not by the app.** The app spawns `openpencil-mcp-http`
  itself only when it is on PATH, and gives it a fresh random token each launch, so every client
  would need re-configuring after a restart. Started outside with `OPENPENCIL_MCP_AUTH_TOKEN` and
  `OPENPENCIL_MCP_DISCOVERY_PATH=~/.openpencil/mcp.json` (the file the app reads first), the server
  keeps a stable token and the app attaches to it instead of spawning its own.
- **The app is needed.** Without it every document tool answers "OpenPencil app is not connected";
  the server alone only lists tools. The unit starts Xvfb, the server, and the app on
  `~/openpencil-designs/workspace.fig` (if present; the app otherwise restores its last session).
- **51 of 132 tools.** All of them are ~31k tokens of schemas in every prompt. The preset keeps
  documents, tree reads, `render`, the common edits, export, lint, icons and tokens (~13.5k). `eval`
  (arbitrary code in the app) is left out. Edit `tools` in `~/.config/mini-tui/mcp.json` to change it.
- **`render` gets a hint.** OpenPencil's JSX is not React's or Figma's (`flex="row"`, `w="hug"`,
  `bg`, `rounded`). Without the hint appended to its description a model wrote `layoutMode` and the
  400×240 card collapsed to 209×24; with it the same prompt came out right the first time.
- **Sessions are closed.** The server allows 10 live MCP sessions (idle ones expire after 15
  minutes). The agent and mini-tui's probe now `DELETE` their session when done, so parallel
  workers do not run the server out of slots.

## Check

```bash
systemctl --user status openpencil-mcp
curl -s 127.0.0.1:7600/health                     # {"status":"ok",...}  ("no_app" = the app is not attached)
openpencil documents list                         # through the CLI, with the same discovery file
```

`openpencil` (the CLI) finds the server through `~/.openpencil/mcp.json` too.
