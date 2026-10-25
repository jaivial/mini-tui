#!/usr/bin/env bash
# mini-tui container entrypoint: refresh the runtime's STATE (it lives in the
# mounted home), then exec the command. The TOOLS live in the image and are
# never touched here.
set -euo pipefail

cd "${MINITUI_HOME:-/opt/mini-tui}"

# Skills are state in $HOME (bundled ones installed, ~/.claude/skills imported).
# Best effort on purpose: a broken skill sync must never keep the web service
# or the channel consumer down.
bun scripts/sync-skills.ts || echo "mini-tui entrypoint: skill sync failed (continuing)" >&2

# State directories the app assumes to exist (providers.json, sessions.db and
# friends are written under ~/.config/mini-tui; media under ~/.local/share).
mkdir -p "${HOME}/.config/mini-tui" "${HOME}/.local/share/mini-tui" "${HOME}/.claude/skills"

# gh credentials must be FILE-visible from the mounted home (hosts.yml with a
# plain oauth_token, or a GH_TOKEN env). The host desktop keyring (secret
# service) does not cross the container boundary — gh then looks logged-in on
# the host and broken in here. Static check, no network at startup; best
# effort: warn, never block.
if [ -z "${GH_TOKEN:-}" ] && ! grep -q oauth_token "${HOME}/.config/gh/hosts.yml" 2>/dev/null; then
  echo "mini-tui entrypoint: gh credentials not visible in the container. On the host run: gh auth login -h github.com --insecure-storage" >&2
fi

exec "$@"
