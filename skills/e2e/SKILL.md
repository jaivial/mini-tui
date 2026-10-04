---
name: e2e
description: >
  Write and run AI end-to-end tests of a web app with mini-agent-rs e2e: plain-language goals
  (act) and checks (assert) done by browser subagents, exact checks (expect), cached replays,
  logins (nginx HTTP Basic Auth, login forms, 2FA) and the project's nginx URL as base URL. Use
  when asked to e2e/QA/smoke-test a site or flow, verify a deploy or a fix in the browser, write
  *.e2e.yaml tests or an e2e.yaml, or says $e2e.
metadata:
  short-description: "AI e2e tests for any project: e2e.yaml + *.e2e.yaml, run with mini-agent-rs e2e"
  bundled-with: mini-tui
---

# e2e: AI end-to-end tests with `mini-agent-rs e2e`

`mini-agent-rs e2e` runs tests in a real headless Chrome. You (the coordinator's user) write the
tests; the runner does exact steps itself and hands every `act`/`assert` step to a **worker
subagent** that drives the browser. Passing runs are cached, so reruns cost no model calls until
the app changes. One `e2e.yaml` per project; any project, any URL.

## 0. Find the binary (do this first, every time)

```bash
E2E=$(for c in "$MINITUI_AGENT_BIN" "$(command -v mini-agent-rs)" ~/mini-tui/agent-rs/target/release/mini-agent-rs ~/.local/lib/mini-tui/mini-agent-rs; do [ -x "$c" ] && "$c" e2e skill 2>/dev/null | grep -q "^name: e2e" && echo "$c" && break; done); echo "${E2E:-NOT FOUND}"
```

`NOT FOUND` means no installed `mini-agent-rs` has the e2e feature yet: say so and stop (it is
built with `cd ~/mini-tui/agent-rs && ~/.cargo/bin/cargo build --release`; do not rebuild or
redeploy yourself unless the user asked — running sessions use that binary).
`$E2E e2e --help` lists every option; `$E2E e2e skill` prints this skill.

## 1. Set up a project (once)

```bash
cd <project root>                  # e2e.yaml is searched upward from the working directory
$E2E e2e detect-url                # the nginx vhost serving this directory (if any)
$E2E e2e init                      # writes e2e.yaml + e2e/smoke.e2e.yaml; never overwrites (--force)
$E2E e2e check-url                 # reachability, TLS, HTTP auth: no model, run it before tests
```

`e2e.yaml` (edit what `init` wrote; keep it small):

```yaml
base_url: auto                     # nginx detection, or https://app.example.com, or http://127.0.0.1:5173
# server_name: app.example.com     # with auto, when several vhosts match / for a named vhost
tests: [e2e]                       # files or directories of *.e2e.yaml
models:
  worker: <act model>              # cheap and fast is fine: xiaomi/mimo-v2.6-flash, opencode-go/glm-5.3-flash
  judge: <assert model>            # a model that sees images: cliproxy/claude-sonnet-5-5, openai/gpt-6-astra
  # escalate: cliproxy/claude-opus-5-5   # a failed act is retried once with it
auth:
  http_basic: { user: env:APP_BASIC_USER, password: env:APP_BASIC_PASS }   # only if nginx has auth_basic
  default_profile: user
  profiles:
    user:
      form:                        # only if the app has its own login page
        url: /login
        user_field: label=Email
        password_field: label=Password
        submit: role=button[name=Sign in]
        success: { url_not_contains: /login }   # or url_contains: / visible: <locator>
        user: env:APP_USER
        password: env:APP_PASS
        # totp: env:APP_TOTP       # base32 2FA secret; totp_field: label=One-time code
environments:                      # optional: --env NAME (or E2E_ENV)
  local: { base_url: http://127.0.0.1:3000 }
  production: { base_url: https://example.com, read_only: true }   # refuses act/click/type steps
```

Pick the base URL deliberately:
- `auto` / the nginx URL tests the deployed site end to end (TLS, nginx auth, proxying).
- `http://127.0.0.1:<port>` tests the app directly and skips the nginx password; prefer it when
  the nginx gate protects something powerful (a site that runs agents or a terminal).
- `auto` cannot trace ports owned by root, other users or Docker: set `base_url` or `server_name`.

## 2. Credentials: the rules

- **Never write a password, token or cookie into any file, command line or message.** Config holds
  references only: `env:NAME`, `file:~/path#KEY` (file must be `chmod 600`), `cmd:pass show x`.
- `env:NAME` falls back to the secrets file: `~/.config/mini-tui/e2e-secrets.env` (`chmod 600`,
  `NAME=value` lines) or `secrets_file:` in e2e.yaml. If a needed secret is missing, **ask the user
  to add it there**; do not ask them to paste it to you, and do not `cat` that file.
- Workers never see secret values; they type them by name (`fill-secret`). Every file the run
  writes is scrubbed to `«secret:NAME»`.
- A test with `profile: none` runs logged out (site-wide `http_basic` still applies).

## 3. Write tests: `e2e/<area>.e2e.yaml`

```yaml
defaults: { profile: user, timeout: 600 }
tests:
  - name: a member upgrades to Pro
    start: /settings/billing                       # relative to base_url
    steps:
      - act: upgrade the workspace to the Pro plan  # a subagent reaches the goal
      - assert: the page confirms the Pro plan      # a read-only subagent judges a claim
      - expect: { locator: testid=plan, to_contain_text: Pro }   # exact, no model
  - name: logged-out visitors are sent to sign in
    profile: none
    steps:
      - open: /settings/billing
      - expect: { url_contains: /login }
```

| Step | Who | Notes |
| --- | --- | --- |
| `act: <goal>` | subagent | one user-level goal per step; recorded and cached when a later check passes |
| `assert: <claim>` | subagent, read-only | a claim that is true or false *now*; it cannot click or type |
| `expect: {…}` | exact | `url`, `url_contains`, `url_not_contains`, `title_contains`, `page_contains`, `locator` + `count` / `to_contain_text` / `to_have_text`, `hidden`, `timeout` (s) |
| `open`, `click`, `type {target,value}`, `select {target,value}`, `press`, `fill-secret {target,secret}`, `wait`, `screenshot`, `login [profile]` | exact | no model |

Locators: `role=button[name=Save]`, `role=link[name~=pric]` (contains), `label=Email`,
`placeholder=Search`, `text=Welcome back`, `testid=save`, `css=#main .card`.

Write good tests:
- **Prefer exact steps** for what is fixed (navigation, a known button, a value) and keep `act`
  for what needs judgment. Follow every `act` with an `assert` or `expect`: that is what makes
  it cacheable and what makes the test mean something.
- One behaviour per test, independent of the others (tests can run in parallel, each in its own
  browser, but they share the app's data: do not let one test depend on another's changes).
- Never point `act` steps at production data; use a test account or `read_only: true`.
- Read the app (routes, labels, `data-testid`s) before writing locators; do not guess them.

## 4. Run: in the background, then poll

A run takes minutes (a subagent model call can take ~30 s) and your bash commands time out
long before that. **Never run it in the foreground.**

```bash
cd <project root>
nohup $E2E e2e run -j 2 -l 2 > /tmp/e2e-$$.log 2>&1 &     # add file paths, --grep NAME, --env NAME
sleep 20; $E2E e2e last                                 # repeat until it says finished
```

`$E2E e2e last` prints the latest run's state (running/finished), its recent progress, and when
finished the report. Useful options: `-m/--judge-model/--escalate-model`, `-j N` (parallel tests),
`-l USD` (total budget, default 5), `--step-limit N` (per subagent, default 40), `--no-cache`,
`--update-cache`, `--fresh-login`, `--vision`/`--no-vision`. Start with one test (`--grep`)
before running everything. To stop a run: `kill -INT <pid>` (workers save and exit).

## 5. Read the results

Each run lives in `.e2e-runs/<time>-<id>/`:
- `report.md` (also a PR comment: `gh pr comment <n> -F report.md`), `junit.xml`, `report.json`;
- `<NN-test>/screenshots/` (a `fail-step-N` shot for every failure) and each subagent's
  `NN-act.traj.json` / `NN-assert.traj.json` (what it saw and did);
- `coordinator.traj.json`: the whole run, one entry per subagent.

Exit code: 0 all passed, 1 a test failed, 2 a config/usage error.

Interpret failures before acting on them:
- `expect`/`assert` failed → the app (or the test's expectation) is wrong: look at the
  screenshot and the subagent trajectory, then fix the app or the test, not the runner.
- `act` failed or `the subagent gave no verdict` → the goal was unclear or too big; split it,
  name the screen, or add exact steps first. `error: … HTTP 402/401` → the model's provider
  (balance or key): switch models with `-m`.
- `left the app: navigation to … is outside the allowed origins` → add the origin to
  `allowed_origins:` only if leaving is intended.
- `asks for HTTP Basic Auth and no credentials are configured` / `rejected the HTTP Basic Auth
  credentials` → `auth.http_basic` is missing or wrong. `login as X failed` → the form locators
  or `success` check do not match the page, or the password is wrong (`--fresh-login` to retry).
- `cached actions … no longer replay` is normal after UI changes: a subagent redoes the step and
  the cache is re-recorded when the next check passes.

When you report back, give: what ran (base URL, environment, tests), pass/fail per test with the
reason, the report path, cost, and what you changed. Never paste secrets or cookies.

## 6. Housekeeping

- `.e2e-cache/` (cached actions, saved logins, detected URL) and `.e2e-runs/` get their own `*`
  `.gitignore`; also add them to the project's `.gitignore`. Commit `e2e.yaml` and `e2e/`.
- `$E2E e2e clear-cache` drops cached actions; `--auth` also drops saved logins.
