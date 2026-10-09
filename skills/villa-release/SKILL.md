---
name: villa-release
description: >
  Villa Carmen release workflow (/var/www/newvillacarmen): promote dev to main
  in every repo with a release branch and a PR built with $pr-body, clean it
  with $pr-fix-loop, merge it with a real merge commit (never squash), resolve
  any conflict yourself, then check out main everywhere, fetch, pull and
  redeploy the prod docker stack. Use when the user asks to release, promote
  dev to main, deploy to production, cut a release, or says
  /villa-release or $villa-release.
metadata:
  short-description: "Villa Carmen: PR dev→main with $pr-body + $pr-fix-loop, merge commit, redeploy prod"
  bundled-with: mini-tui
---

# Villa Release

The workflow in one sentence: **in every repo of `/var/www/newvillacarmen`,
open a release PR that promotes `dev` to `main` (body from `$pr-body`, cleaned
by `$pr-fix-loop`), merge it with a merge commit (never squash), resolving any
conflict yourself, then check out `main` everywhere, fetch, pull and redeploy
the prod docker stack.**

Always use the `gh` CLI. Work through the steps in order. Never skip one.

## Context

Root: `/var/www/newvillacarmen` (not a git repo itself). Repos inside it:

| Repo dir | GitHub | Working tree |
|---|---|---|
| `backend/` | `jaivial/herorestaurant-backend` | `/var/www/newvillacarmen/backend` |
| `backoffice/` | `jaivial/backofficereact` | `/var/www/newvillacarmen/backoffice` |
| `preactvillacarmen/` | `jaivial/preactvillacarmen` | `/var/www/newvillacarmen/preactvillacarmen` |

Main checkouts often sit on `main` and may have untracked local files
(`.env.example`, `.worktrees/`, `brag-output/`...). Leave them alone. Never
commit secrets or `.env*` files.

### The branch shape matters: build the release branch from `main`, not `dev`

`main` is **ahead** of `dev`, not behind it: past releases merged `dev` into
`main`, so `main` carries merge commits that `dev` does not have. Creating the
branch from `dev` therefore does **not** promote `dev` — it would also revert
everything `main` gained, and `main` would come out behind.

So for each repo:

1. branch `release/dev-to-main-<repo>` off the fresh `origin/main`
2. merge `origin/dev` into it

The merge brings in everything `dev` has that `main` lacks, and keeps every
commit `main` already has. That is what a release is: `main` moves forward to
include `dev`, never backwards. (The repo already contains a commit doing
exactly this — "Merge main into release: dev already contains every main
change".)

A repo with **nothing to promote** (`git rev-list --count origin/main..origin/dev`
is `0`) still gets its merge executed if needed for consistency, but it does not
need a PR: skip it and say so in the final report.

## Step 1 — Prepare one release branch per repo

```bash
cd /var/www/newvillacarmen/<repo>
git fetch origin --prune
git rev-list --count origin/main..origin/dev   # how many commits to promote
git worktree add -b release/dev-to-main-<repo> <wt-dir>/dev-to-main-<repo> origin/main
```

- Worktree dirs are git-ignored: `backend/.worktrees/…`, and `backoffice/.worktree/…`
  (note the singular directory name for backoffice).
- Branch names follow the repo convention: `release/dev-to-main-<repo>`.
- **Do all work, builds and checks inside these worktrees** for the whole
  session. Never edit the main checkouts.
- Never touch anybody else's worktree listed by `git worktree list`.

## Step 2 — Merge `dev` into the release branch

```bash
cd <wt>
git merge --no-edit origin/dev
```

- Clean merge → continue. Verify with `git log --oneline origin/main..HEAD`
  that only the intended commits are being promoted.
- Conflict → go to Step 3 and resolve it yourself. Never stop to ask the user.

Verify the result locally before the PR:

```bash
go build ./... && go vet ./...          # backend
npx tsc -p tsconfig.json --noEmit       # backoffice, preactvillacarmen
npm run build                          # frontends
```

Commit the merge and push:

```bash
git -C <wt> push -u origin release/dev-to-main-<repo>
```

## Step 3 — Resolve conflicts yourself, the professional way

A conflict is never a reason to stop and never a reason to ask. Resolve it and
keep **both** intents. Blindly taking `--ours` or `--theirs` is wrong: for a
`dev → main` promotion, "ours" is `main` and "theirs" is `dev`, and dropping
either side silently reverts real work.

For every conflicted file:

1. **Read both sides.** `git log --oneline --merge -- <file>` shows the commits
   from `main` and from `dev` that touched it. Read the surrounding file to
   understand what each side changed and why.
2. **Understand the shape of the change.** Most release conflicts are one of:
   - *Both sides edited the same region* — merge the two edits into one coherent
     block, keeping every distinct change from both sides.
   - *`main` moved code that `dev` did not touch* — take `main`'s version and
     re-apply `dev`'s intent on top of it, so nothing that landed on `main`
     between the branch point and now is lost.
   - *Generated or lock files* (`go.sum`, `bun.lock`, `package-lock.json`,
     `dist/`) — resolve by regenerating them from the merged sources
     (`go mod tidy`, `bun install`) rather than by hand-merging.
   - *Churn on both sides with no real overlap in meaning* (reordered imports,
     reformatted blocks) — prefer the version that keeps both sets of changes
     and matches the surrounding style.
3. **Keep the code working.** The merged result must compile and typecheck; run
   the checks of Step 2 on the resolved tree. A "resolution" that does not build
   is not a resolution.
4. **Never invent content.** Do not silently change behaviour, rename things,
   or drop a feature to make a conflict disappear. If two sides genuinely make
   incompatible product decisions, resolve it the way the rest of the file and
   the rest of the repo already do, and explain the choice in the merge commit
   message — that is the professional call, not a question to the user.
5. **No markers left.** `git diff --check` must be clean, and
   `grep -rn '<<<<<<<\|>>>>>>>' <file>` must find nothing.
6. `git add` the resolved files and commit:

```bash
git commit --no-edit        # or a message describing how the conflict was resolved
git push origin release/dev-to-main-<repo>
```

## Step 4 — Open the PR with $pr-body

For each repo with changes, generate the body with skill `$pr-body` from the
diff against `origin/main`, then:

```bash
gh pr create --base main --head release/dev-to-main-<repo> \
  --title "release: promote dev to main — <one-line summary>" \
  --body-file /tmp/pr-body-<repo>.md
```

Follow the existing title convention:
`release: promote dev to main — <what shipped>`.

If `$pr-body` is not already in context, read
`~/.config/mini-tui/skills/pr-body/SKILL.md` first. Do not improvise the format.

## Step 5 — Run $pr-fix-loop on every PR against `main`

Run skill `$pr-fix-loop` on each PR (read
`~/.config/mini-tui/skills/pr-fix-loop/SKILL.md` if it is not in context). It
runs review → comment → fix → push → re-review until there are 0 critical,
important or medium blockers and the PR is `MERGEABLE`, max 5 iterations. Fixes
are committed in the session worktree. Conflicts are Critical Issues: resolve
them with Step 3 of this skill, never by force-pushing.

CI status is ignored. If the loop does not converge, stop and report.

## Step 6 — Merge with a MERGE COMMIT (never squash)

```bash
gh pr view <number> --json mergeable,state    # must be MERGEABLE / OPEN
gh pr merge <number>                          # plain merge → merge commit
gh pr view <number> --json state,mergeCommit   # confirm MERGED
```

- **Plain `gh pr merge` with no flag.** This is the whole point of the skill:
  a release PR must land as a real merge commit, preserving the history of
  `dev` and the "promote dev to main" record. **Never** pass `--squash`, and
  never use `--rebase` or a fast-forward that would erase the merge.
- Sanity check that it really is a merge commit (two parents):

```bash
gh api repos/<owner>/<repo>/commits/<mergeCommit> --jq '[.parents[].sha] | length'
```

- Do not wait on CI. Local verification stands in for it.
- Do not pass `--delete-branch` while the worktree still has the branch checked
  out. Step 7 deletes branches.

## Step 7 — Clean up the worktrees and merged branches

For each session worktree whose PR is `MERGED`:

```bash
cd /var/www/newvillacarmen/<repo>
git worktree remove <wt-dir>/dev-to-main-<repo>   # no --force; if dirty, stop and ask
git branch -D release/dev-to-main-<repo>           # -D needed: a merge commit ≠ branch ancestry
git push origin --delete release/dev-to-main-<repo>
git worktree prune
git fetch origin --prune
```

Only delete branches whose PR is confirmed `MERGED`. Never touch other people's
worktrees or branches.

## Step 8 — Check out `main` in every repo, fetch and pull

Do this for **all three** repos:

```bash
for r in backend backoffice preactvillacarmen; do
  git -C /var/www/newvillacarmen/$r fetch origin --prune
  git -C /var/www/newvillacarmen/$r checkout main
  git -C /var/www/newvillacarmen/$r pull --ff-only origin main
done
```

If `checkout` fails because of tracked local changes, or `pull --ff-only` fails,
stop and report. Never stash away, reset or discard the user's work without
asking. Untracked ignored files are fine.

## Step 9 — Redeploy the PROD docker stack

```bash
cd /var/www/newvillacarmen
docker compose -f backend/deploy/docker-compose.prod.yml up -d --build
docker compose -f backend/deploy/docker-compose.prod.yml ps
```

- Prod is project `newvillacarmen-prod`: `newvillacarmen-backend-prod`,
  `newvillacarmen-backoffice-prod`, `newvillacarmen-bot-pipeline-prod`.
  Relative paths in that file resolve against its own directory
  (`backend/deploy/`), so `context ../..` is the multi-repo root.
- **This skill only ever touches prod.** Do not run
  `docker compose -f docker-compose.dev.yml` or anything against the dev
  containers. Do not run `docker compose down`, `docker system prune`, or
  remove volumes.
- Check the result: the containers are `Up` and
  `docker logs --tail 50 <container>` shows no startup errors (e.g.
  `curl -fsS http://127.0.0.1:<prod-port>/` or a health route for the backend).
- If a container fails, read its logs. Fix the problem through the normal
  dev → PR → release cycle, or report to the user.

## Hard rule: never write or run a test

Never create, add, modify or run a test of any kind: no unit, integration, e2e,
Playwright, browser, regression, snapshot or smoke **test file**, no test runner,
config, harness or fixture, and no `tests/` directory — not even to "prove" a
fix, not "just one red test first", and not as a throwaway reproduction script.
Verification is running the repo's **existing** build, typecheck and suites and
reporting their numbers; it is never a test you wrote. This overrides any
sub-skill that asks for a test.

## Final report

Tell the user: the PR URLs and merge commit shas (confirming each is a merge
commit with two parents), the fix-loop iterations, which worktrees/branches
were removed, the `main` HEAD of each repo, and the prod container status.
