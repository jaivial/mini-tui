---
name: e2e-army
description: >
  Write and run agentic end-to-end tests with TesterArmy's open-source `e2e` framework
  (https://e2e.tester.army/docs): TypeScript tests (`tests/*.e2e.ts`) mixing agent goals
  (agent.act / assert / waitFor / extract) with exact locators and expect, a replay cache, web
  (Playwright) and mobile targets, `e2e explore` and bug bashes. Agent steps run on MiniMax
  `MiniMax-M3.1-Flash-Preview` with the API key from ~/.env. Use when asked to add, write, run or
  debug e2e / QA / smoke tests with `npx e2e`, an `e2e.config.ts`, TesterArmy, or says $e2e-army.
metadata:
  short-description: "TesterArmy e2e (npx e2e) tests driven by MiniMax-M3.1-Flash-Preview agents"
  bundled-with: mini-tui
---

# e2e-army: agentic e2e tests with TesterArmy `e2e` + MiniMax

[`e2e`](https://e2e.tester.army/docs) (npm package `e2e`, by TesterArmy) runs TypeScript tests in a
real browser (or iOS/Android). `agent.*` steps hand a goal to a model that reads the screen and acts;
`screen` / `expect` do exact steps and checks. Passing agent steps are cached and replayed without
model calls until the app changes.

This skill is not mini-tui's own `$e2e` (`mini-agent-rs e2e`, YAML tests). Use `$e2e-army` when the
project uses, or the user asks for, `npx e2e` / `e2e.config.ts` / TesterArmy.

**Model (always, unless the user names another):** MiniMax `MiniMax-M3.1-Flash-Preview` through
`@ai-sdk/minimax` (MiniMax's Anthropic-compatible API; the model supports the tool calls and images
e2e requires). **Key:** `MINIMAX_TOKEN_PLAN_API_KEY` in `~/.env` (`MINIMAX_API_KEY` also works).

## 0. Check the key, never read it

```bash
grep -c '^MINIMAX_TOKEN_PLAN_API_KEY=\|^MINIMAX_API_KEY=' ~/.env   # 1 or more = present
```

Never `cat`, `echo`, print or copy the key into a file, command line, test or message. If it is
missing, ask the user to add `MINIMAX_TOKEN_PLAN_API_KEY=...` to `~/.env` themselves. To check the key works
without printing it:

```bash
( set -a; . ~/.env; set +a; curl -s -o /dev/null -w '%{http_code}\n' https://api.minimax.io/anthropic/v1/messages \
  -H "x-api-key: ${MINIMAX_TOKEN_PLAN_API_KEY:-$MINIMAX_API_KEY}" -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d '{"model":"MiniMax-M3.1-Flash-Preview","max_tokens":16,"messages":[{"role":"user","content":"OK"}]}' )
# 200 = good; 401 = bad key; 402/429 = balance or rate limit
```

## 1. Set up a project (once)

Needs Node.js >= 24.8 (or >= 22.22.3 on 22). In the app's directory:

1. Look first: `e2e.config.ts`/`.mts`, `tests/**/*.e2e.ts`, `e2e` in `package.json`. If they exist,
   only switch the model to the block below (keep everything else).
2. Otherwise scaffold, then add the provider:

```bash
npx e2e init                 # pick Web (Playwright) or Mobile; any provider (the config is replaced below)
npm i -D @ai-sdk/minimax ai zod     # pnpm add -D / bun add -d, matching the project's package manager
```

`init` also installs TesterArmy's own skill under `.agents/skills/e2e/` and registers the
`e2e mcp` server. Read it for detail: `npx e2e guide [setup|writing-tests|agent|running|explore|debugging|mcp|bug-bash]`,
or the offline docs in `node_modules/e2e/docs/` (`/reference/cli` = `docs/reference/cli.mdx`).

3. `e2e.config.ts`: e2e loads **no** `.env` file itself, so the config loads `~/.env`:

```ts
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { createMiniMax } from '@ai-sdk/minimax';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// e2e loads no .env files: read the MiniMax key from ~/.env (every worker re-imports this file).
const envFile = join(homedir(), '.env');
if (!process.env.MINIMAX_TOKEN_PLAN_API_KEY && existsSync(envFile)) process.loadEnvFile(envFile);

const minimax = createMiniMax({
  apiKey: process.env.MINIMAX_TOKEN_PLAN_API_KEY ?? process.env.MINIMAX_API_KEY,
  baseURL: 'https://api.minimax.io/anthropic/v1',
});

// The AI SDK does not know this model id yet and would cap output at 4096 tokens with a warning.
const model = wrapLanguageModel({
  model: minimax('MiniMax-M3.1-Flash-Preview'),
  middleware: defaultSettingsMiddleware({ settings: { maxOutputTokens: 16384 } }),
});

export default {
  targets: [{
    engine: web(),
    app: {
      url: 'http://127.0.0.1:3000',
      // optional: let e2e start the app for the run
      // command: { executable: 'npm', args: ['run', 'dev'], log: '.e2e/logs/app.log' },
    },
  }],
  agents: {
    default: {
      model,
      // system: 'You are a thorough QA agent. Verify every outcome on screen.',
      // context: 'vocabulary the app uses',
    },
  },
} satisfies E2EConfig;
```

Point `app.url` at the running app (dev server, `127.0.0.1:<port>`, or the deployed URL), or use
`command` so e2e starts it. In CI, export `MINIMAX_TOKEN_PLAN_API_KEY` as a secret; the `existsSync`
guard skips the missing `~/.env`. Add `.e2e/` to `.gitignore` if `init` did not.

## 2. Write tests: `tests/<feature>.e2e.ts`

```ts
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('a member upgrades to Pro', async ({ app, agent, screen, browser }) => {
  await app.open('/settings/billing');
  await agent.act('Upgrade the workspace to the Pro plan');          // one goal per act
  await expect(screen.getByRole('status')).toContainText('Pro');      // pin the outcome right after
  await agent.assert('The billing page shows the Pro plan as active'); // model judges the screen
  await expect(browser).toHaveURL('/settings/billing');
});
```

Rules (from TesterArmy's skill):
- Learn the screens first: read the components, run `--headed`, or use the `e2e mcp` tools
  (`open_session`, `observe`, `locate`) to get exact roles and labels before writing locators.
- One goal per `agent.act`, worded like the screen, real values in params, then an `expect` or
  `agent.assert`. The check makes the step cacheable and is what fails when the agent went wrong.
- Exact values through `screen` (`getByRole`, `getByLabel`, `getByText`, `.fill`, `.click`); judge
  meaning, not a sentence a model produced (`toContainText('Pro')`).
- No sleeps: locators poll and `expect` retries.
- Secrets via `credentials.user(name)` declared in the config, never literal in a test.
- `agent.extract` returns structured data; `agent.waitFor` waits for a condition.

## 3. Run and read results

```bash
npx e2e run tests/<feature>.e2e.ts --reporter list,markdown   # one file while iterating
npx e2e run                                                   # all tests
npx e2e run --headed | --no-cache | --last-failed | --grep '<title>' | --ai-trace
npx e2e explore 'Explore checkout like a first-time buyer and find bugs'   # no test file
```

- Results: `.e2e/report.json`, `.e2e/summary.md`, and `.e2e/failures/<test>.md` (failing line,
  steps, recent model turns, the screen at failure). Read the failure page first; never edit `.e2e/`.
- The list output shows the model as `minimax.messages/MiniMax-M3.1-Flash-Preview`, plus tokens and model calls.
- To be sure a test fails when it should, break the expectation once and confirm it fails.

## 4. When it fails

- `MODEL_PROVIDER_FAILED`: the key is missing or wrong, or MiniMax returned 401/402/429. Run the check
  in step 0. `CONFIG_LOAD_FAILED`: a config import failed (`npm i -D @ai-sdk/minimax ai zod`).
- A failing `expect` or `agent.assert` means the app or the test's expectation is wrong. Read the
  failure page and screenshot, then fix the app or the test.
- An `act` that wanders or runs out of steps has a goal that is too big or vague. Split it, name the
  screen, or add exact `screen` steps first; then add `context`/`system` to the agent.
- `REPLAY_STALE` / cache misses after UI changes are normal: the agent redoes the step and the cache
  is re-recorded.

When you report back, give the app URL, the tests run, pass or fail for each test with the reason,
the report path, model calls and tokens, and what you changed. Never include the API key.
