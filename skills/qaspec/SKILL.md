---
name: qaspec
description: >
  Write and run agentic browser QA specs with qaspec: declaration-style TypeScript specs,
  deterministic expectations, browser-agent goals, console/network/state checks, and safe
  authentication state. Use when asked to QA a web app with qaspec or to create *.qa.ts specs.
metadata:
  short-description: "Agentic browser QA with qaspec"
  bundled-with: mini-tui
---

# qaspec: agentic browser QA

`qaspec` reads TypeScript-like declaration files; it does not execute TypeScript. A Rust binary
drives one Chromium session through agent-browser. Specs describe QA intent (`goal`) and evidence
(`expect`), including console, network, URL, browser state, and storage signals.

## 0. Find the binary

For this installation, use:

```bash
QASPEC=~/qaspec/target/release/qaspec
test -x "$QASPEC" || { echo "qaspec binary not found"; exit 1; }
"$QASPEC" --version
```

If working in another checkout, use that checkout's release binary. Do not rebuild or install a
different binary unless the user asks.

## 1. Initialize and configure a project

Run once from the project root; `init` creates `qaspec.toml`, `specs/home.qa.ts`, and adds
`.qaspec/` to `.gitignore` without overwriting existing config.

```bash
cd <project-root>
"$QASPEC" init
```

Set the deployed URL in `qaspec.toml`:

```toml
default_env = "dev"

[projects.app]
specs = "specs/**/*.qa.ts"
[projects.app.env.dev]
base_url = "https://example.com"
```

An optional `[llm]` section needs an OpenAI-compatible `base_url`, API-key reference, and actor;
the key must be referenced as `{ env = "NAME" }`, never written inline.

## 2. Write specs

```ts
import { suite, step, goal, expect, capture } from 'qaspec';

suite('builder smoke', { project: 'app', start: '/dashboard#text-to-image' }, () => {
  step('builder opens', () => {
    goal('open the builder and show the text-to-image workspace');
    expect('the builder workspace is visible');
    expect.url().toContain('/dashboard');
    expect.errors.none();
  });
  step('request is healthy', () => {
    expect.network.noFailures();
    expect.console.noErrors();
  });
});
```

Useful calls:

- `suite(name, { project, as, start, device, viewport }, body)` defines a journey. Steps share
  browser state; a step with `start` is independent.
- `step(name, { start, onFail, needs }, body)` defines one verdict.
- `goal('...')` lets the browser agent act. Keep one user-level goal per step and follow it with
  an `expect` or deterministic assertion.
- `expect('...')` asks the judge to assess the screen and collected signals.
- Exact checks include `expect.url().toContain/toBe`, `expect.visible`,
  `expect.network(pattern).status/ok/called`, `expect.network.noFailures()`,
  `expect.console.noErrors()`, `expect.errors.none()`, `expect.state(js)`, and
  `expect.storage.local(key)`.
- `capture(name, description)`, `capture.state`, and `capture.url` make safe values available as
  `${name}` in later steps. Do not capture secrets.

Read the app's route and visible-label source before writing goals. Prefer stable user-facing
descriptions over guessed selectors. Keep tests independent, avoid destructive production actions,
and use `read_only` environments for production-like sites.

## 3. Credentials and auth state

Never print, paste, commit, interpolate, or store passwords, tokens, cookies, or their values.
Config may contain references only:

```toml
[projects.app.identities.qa]
username = "qa@example.com"
password = { env = "APP_PASSWORD" }
# or password = { file = "~/.config/qaspec/app-password" }
valid_if = { url_not = "/login" }
login = "specs/_login.qa.ts"
```

Do not `cat` a secrets file or put a secret on a command line. If a secret is missing, report the
missing reference and ask the user to provision it locally. qaspec types secrets through the
browser driver and redacts them from reports. A login spec is optional; without one, the agent can
sign in using the configured identity. Saved state is under `.qaspec/state/` with restricted mode.

```bash
"$QASPEC" state list
"$QASPEC" state clear                 # clear all saved auth state
"$QASPEC" state clear app.qa          # clear one project/identity state
```

Run logged-out coverage with no `as` identity; it must not require credentials.

## 4. Check and run

Always parse and validate first; `check` opens no browser:

```bash
"$QASPEC" check
"$QASPEC" check -c path/to/qaspec.toml
```

Run all or selected specs:

```bash
"$QASPEC" run
"$QASPEC" run specs/builder.qa.ts --env dev
"$QASPEC" run --json .qaspec/report.json --junit .qaspec/report.xml
```

Runs are headless by default (`browser.headed = false`); keep it that way. agent-browser is
configured (`~/.agent-browser/config.json`) to use chrome-headless-shell, which renders pages
fully (screenshots, `--annotate`, `diff screenshot`) at about half the memory of full Chrome.
Do not pass `--headed`: it does not apply to headless-shell, and there is no X server for a
visible window. For visual checks, take screenshots instead (`agent-browser --session <s>
screenshot [--full|--annotate] out.png`, `agent-browser --session <s> diff screenshot --baseline base.png`).

Use `--jobs N` only when parallel browser sessions are safe. Use `--cache strict` in CI when
missing recordings must fail instead of invoking the model. Reports go to `.qaspec/report.json`
by default; `.qaspec/` is ignored. Exit codes: `0` passed, `1` step failure, `2` blocked by
environment/credentials/LLM, `3` usage or config error.

Interpret a failed deterministic check as an app/spec problem, a failed goal as an unclear goal or
UI mismatch, and exit code 2 as a blocked environment or missing credential/model. Report the base
URL, exact spec/test result, report path, and blocker without including secrets.
