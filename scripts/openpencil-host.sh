#!/usr/bin/env bash
# The self-hosted OpenPencil MCP for mini-tui: the MCP server plus the desktop app it drives,
# headless (Xvfb), as one supervised unit (deploy/openpencil-mcp.service).
#
# Why the server is started HERE and not by the app: the app spawns `openpencil-mcp-http` itself
# only when it finds the binary, and it gives that child a fresh random token on every launch.
# Started outside, the server owns a STABLE token (~/.openpencil/token) and the app adopts it
# through the discovery file the app reads (~/.openpencil/mcp.json). A stable token is what lets
# mini-tui (and pi) keep one MCP entry that survives restarts.
#
# Environment (all optional):
#   OPENPENCIL_APPDIR   extracted AppImage   (default ~/.local/opt/openpencil/current)
#   OPENPENCIL_PORT     MCP port              (default 7600 — the port the app expects)
#   OPENPENCIL_DISPLAY  Xvfb display          (default :97)
#   OPENPENCIL_DOCUMENT file opened at start  (default ~/openpencil-designs/workspace.fig)
set -euo pipefail

APPDIR="${OPENPENCIL_APPDIR:-$HOME/.local/opt/openpencil/current}"
PORT="${OPENPENCIL_PORT:-7600}"
DISPLAY_NUM="${OPENPENCIL_DISPLAY:-:97}"
STATE="$HOME/.openpencil"
DOC="${OPENPENCIL_DOCUMENT:-$HOME/openpencil-designs/workspace.fig}"
MCP_BIN="$(command -v openpencil-mcp-http || echo "$HOME/.npm-global/bin/openpencil-mcp-http")"

mkdir -p "$STATE" "$(dirname "$DOC")"
chmod 700 "$STATE"
if [ ! -s "$STATE/token" ]; then
  umask 077
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$STATE/token"
fi
[ -x "$MCP_BIN" ] || { echo "openpencil-mcp-http not found: npm i -g @open-pencil/mcp" >&2; exit 1; }
[ -x "$APPDIR/AppRun" ] || { echo "OpenPencil app not found at $APPDIR (extract the AppImage there)" >&2; exit 1; }

pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 1. The MCP server, with the stable token, writing the discovery file the app reads.
PORT="$PORT" \
OPENPENCIL_MCP_AUTH_TOKEN="$(cat "$STATE/token")" \
OPENPENCIL_MCP_DISCOVERY_PATH="$STATE/mcp.json" \
OPENPENCIL_MCP_ROOT="$HOME" \
OPENPENCIL_MCP_CORS_ORIGIN="tauri://localhost" \
  "$MCP_BIN" &
pids+=($!)

for _ in $(seq 1 50); do
  curl -fsS -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.2
done

# 2. A virtual screen for the app (no GPU, no session on a server).
Xvfb "$DISPLAY_NUM" -screen 0 1600x1000x24 -nolisten tcp &
pids+=($!)
sleep 1

# 3. The desktop app, on a document, so the MCP tools have something to act on. A missing
#    document is created empty by the app on first save (`new_document` + `save_file`).
args=()
[ -f "$DOC" ] && args+=("$DOC")
DISPLAY="$DISPLAY_NUM" \
WEBKIT_DISABLE_DMABUF_RENDERER=1 \
LIBGL_ALWAYS_SOFTWARE=1 \
PATH="$(dirname "$MCP_BIN"):$PATH" \
  "$APPDIR/AppRun" "${args[@]}" &
pids+=($!)

# One of the three dying takes the unit down; systemd restarts all of them together.
wait -n "${pids[@]}"
exit 1
