# `mini-agent-rs e2e`: AI end-to-end tests

Plain-language goals (`act`), plain-language checks (`assert`) and exact checks (`expect`) for
any web app, run in a real headless Chrome. The coordinator is this binary; every `act` or
`assert` step is handed to a **worker subagent**: an ordinary `mini-agent-rs` run, with the
models of the harness (cliproxy, xiaomi, deepseek, opencode-go, rosetta, openai, ...).
Actions a later check confirms are cached and replayed with no model calls until the app changes.

```sh
cd ~/my-project
mini-agent-rs e2e init                      # e2e.yaml + e2e/smoke.e2e.yaml (base URL from nginx)
mini-agent-rs e2e check-url                 # reachability, TLS, HTTP auth (no model)
mini-agent-rs e2e                           # run every e2e/*.e2e.yaml
mini-agent-rs e2e e2e/billing.e2e.yaml -j 3 --env staging -m xiaomi/mimo-v2.6-flash
```

Exit code: 0 when every test passed, 1 when one failed, 2 on a usage or config error.

## Per project: `e2e.yaml`

Searched upward from the working directory (like `.git`), or `-C path`. Everything is relative
to it: tests, `.e2e-cache/` (cached actions, saved logins, detected URL) and `.e2e-runs/`.
Both directories get a `*` `.gitignore`. Projects never share caches or logins.

```yaml
base_url: auto                 # or https://app.example.com; auto = the nginx vhost serving this dir
# server_name: app.example.com # with auto: pick this vhost
tests: [e2e]                   # files or directories of *.e2e.yaml
secrets_file: ~/.config/mini-tui/e2e-secrets.env   # chmod 600 (the default when it exists)
allowed_origins: []            # other origins the browser may navigate to (all others are blocked)
models:
  worker: deepseek/deepseek-flash        # act steps            (CLI: -m)
  judge: cliproxy/claude-sonnet-5-5      # assert steps         (CLI: --judge-model)
  escalate: cliproxy/claude-opus-5-5     # a failed act is retried once with this model
auth:
  http_basic: { user: env:APP_BASIC_USER, password: env:APP_BASIC_PASS }   # nginx auth_basic gate
  default_profile: admin
  profiles:
    admin:
      form:
        url: /login
        user_field: label=Email
        password_field: label=Password
        submit: role=button[name=Sign in]
        success: { url_not_contains: /login }    # or url_contains / visible: <locator>
        user: env:APP_ADMIN_USER
        password: env:APP_ADMIN_PASS
        totp: env:APP_ADMIN_TOTP                 # optional base32 secret or otpauth:// URI
        # totp_field: label=One-time code
      secrets: { API_TOKEN: env:APP_API_TOKEN }  # workers may type these by name
    member: { form: { ... } }
environments:
  local:      { base_url: http://127.0.0.1:5173 }
  staging:    { base_url: auto, server_name: staging.example.com }
  production: { base_url: https://example.com, read_only: true }   # act/click/type refused
default_environment: local
```

Precedence: CLI flags > environment variables (`E2E_BASE_URL`, `E2E_ENV`) > the test file >
the selected environment > the top level > auto-detection.

## Tests: `*.e2e.yaml`

```yaml
defaults: { profile: admin, timeout: 600 }
tests:
  - name: a member upgrades to Pro
    profile: member              # `none` = logged out (site-wide http_basic still applies)
    start: /settings/billing     # relative to base_url (its path kept)
    steps:
      - act: upgrade the workspace to the Pro plan
      - assert: the invoice preview shows a prorated amount
      - expect: { locator: "role=status", to_contain_text: Pro }
```

| Step | Who | |
| --- | --- | --- |
| `act: <goal>` | worker subagent | reaches a goal; its actions are recorded |
| `assert: <claim>` | worker subagent (read-only) | `pass`/`fail` verdict; clicks/typing are refused |
| `expect: {…}` | coordinator, exact | `url`, `url_contains`, `url_not_contains`, `title_contains`, `page_contains`, `locator` + `count` / `to_contain_text` / `to_have_text`, `hidden`, `timeout` |
| `open`, `click`, `type`, `select`, `press`, `fill-secret`, `wait`, `screenshot`, `login` | coordinator, exact | no model |

Locators: `e12` (a snapshot ref), `role=button[name=Save]`, `role=link[name~=pric]` (contains),
`label=Email`, `placeholder=…`, `text=…`, `testid=…`, `css=…`.

## Coordinator ↔ subagent wiring

| Direction | Mechanism |
| --- | --- |
| start | `mini-agent-rs -y --exit-immediately -o <run>/<test>/<NN-kind>.traj.json -c worker.yaml -m <model> -l <remaining budget> -t <goal + page snapshot>` in its own process group |
| browser | `E2E_BROWSER_SOCKET` (a Unix socket in a 0700 dir) + a `browser` wrapper on `PATH`: the worker runs `browser snapshot`, `browser click …` with its bash tool |
| progress | the coordinator tails the worker's `.jsonl` journal (commands, cost, exit message) |
| steer | the worker's `MSWEA_CONTROL_FILE`: `MESSAGE` (fix a missing verdict, retry), `MODEL` (escalate) |
| result | the final answer's JSON verdict `{"status","reason","evidence"}` |
| stop | SIGINT (the worker saves), SIGKILL of its group after 8 s; SIGTERM to the coordinator kills every worker group |
| budget | `-l` total, split as "what is left"; every worker's `model_stats` is added up |

The coordinator writes its own `coordinator.traj.json` / `.jsonl` (format `mini-swe-agent-1.1`):
one entry per subagent with `extra.subagent = {name, trajectory, model, status, cost, …}`, so
mini-tui's readers can show it. Reports: `report.md` (PR comment: `gh pr comment -F report.md`),
`junit.xml`, `report.json`, screenshots per test.

## Credentials

- Config files hold **references** only: `env:NAME` (falls back to `secrets_file`), `file:PATH#KEY`
  (0600 required), `cmd:pass show app/admin`.
- Values go to the browser only: HTTP Basic is answered through DevTools `Fetch.authRequired`,
  only for the base URL's origin; login forms are filled by the coordinator.
- Workers never see them: their environment drops `E2E_*` and every referenced variable; they
  type secrets by name (`browser fill-secret <locator> NAME`); password fields show as `••••`.
- Everything written (journals, worker trajectories, cache, reports) is scrubbed to `«secret:NAME»`;
  a worker trajectory that needed scrubbing is flagged in the coordinator's trajectory.
- Saved logins: `.e2e-cache/auth/<profile>@<origin>.json`, 0600, re-checked with `success`
  before use; `--fresh-login` ignores them.

## `base_url: auto` (nginx)

`mini-agent-rs e2e detect-url [--project DIR] [--server-name NAME]` parses
`/etc/nginx/sites-enabled/*` (override: `E2E_NGINX_DIR`), follows `include`s and `upstream`s,
and matches a vhost whose `root`/`alias` is inside the project, or whose `proxy_pass` port is
served by a process running from inside it (`/proc/net/tcp` → `/proc/<pid>/fd` → `/proc/<pid>/cwd`).
It prefers the https block, keeps a sub-path mount (`location /app/`), reports whether nginx
asks for Basic Auth, lists files it could not read, and refuses to guess when several or no
vhosts match. Ports owned by other users/root/Docker cannot be traced: set `base_url` or
`server_name` for those.

## Models

- Screenshots go to workers whose model takes images (by name: claude, gpt-5/6, vision, mimo-v2.6,
  …; force with `--vision` / `--no-vision`); others work from text snapshots.
- Without `models:` or `-m`, workers use `MSWEA_MODEL_NAME`.

## The `$e2e` skill

`skills/e2e/SKILL.md` (bundled with mini-tui, installed into `~/.config/mini-tui/skills/` at every
startup) teaches agents to use all of this: reference it with `$e2e` in a prompt. The binary
embeds the same file: `mini-agent-rs e2e skill`. `mini-agent-rs e2e last` is the polling command
it relies on (latest run: running or finished, recent progress, the report; exit 3 while running).

## Tests of the runner itself

`cargo test` covers the TOTP vectors, scrubbing, the nginx parser (proxy/upstream/sub-path/root,
auth), locator origins, cache keys and verdict parsing. A scripted (deterministic) model can drive
the workers: `E2E_TEST_WORKER_CONFIGS=<dir>` layers `<dir>/act.yaml` / `assert.yaml` / `any.yaml`
over the worker config.
