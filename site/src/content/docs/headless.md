---
title: Headless mode and the CLI
description: Run mini-tui with no UI using mini-tui -p, like claude -p. Text, JSON and stream-json output, sessions, guard rails and exit codes for scripts, CI and cron.
section: Use it
order: 5
---

`-p` (or `--print`) runs one turn with no UI. The answer goes to stdout and the process exits with the run's
status, so scripts, CI jobs, cron and other agents can drive it.

```bash
mini-tui -p "Fix the failing test in test_utils.py" -m xiaomi/mimo-v2.6-flash
mini-tui -p "why is the build red?" -v                  # every step to stderr, the answer to stdout
mini-tui -p "list the TODOs" --json | jq -r .result     # one JSON result
mini-tui -p "refactor utils.py" -o stream-json          # JSON lines as the run happens
git diff | mini-tui -p "review this diff"               # stdin is appended to the prompt
```

## Sessions

```bash
mini-tui -p "now add tests" --continue        # latest session of this folder
mini-tui -p "and the docs" --resume s-mugx    # any session, by id or unique prefix
mini-tui -p --compact --continue              # /compact from the shell
```

## Guard rails for unattended runs

```bash
mini-tui -p "..." --max-steps 30 --cost-limit 1 --timeout 900 --cwd ~/repo --no-session
```

| Option | Meaning |
| --- | --- |
| `-o, --output-format` | `text` (default), `json` or `stream-json` |
| `-v, --verbose` / `-q, --quiet` | stream every step, or the answer only |
| `-C, --continue` / `-r, --resume <id>` | follow up in a saved session |
| `--no-session` | do not save the run to the `/resume` history |
| `--max-steps`, `--cost-limit`, `--timeout` | stop a run that goes too far |

## Exit codes

`0` submitted, `1` the run failed or hit a limit, `2` usage error, `130` interrupted.

## Scripting commands

```bash
mini-tui sessions [--all] [-n 20] [-s text]
mini-tui models
mini-tui model [<id>]
mini-tui skills
mini-tui settings [output-mode|theme <value>]
```
