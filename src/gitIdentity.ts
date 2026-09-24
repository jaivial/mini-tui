/**
 * Git identity for agent runs. Models like to "fix" commits with ad-hoc flags such as
 * `git -c user.name=claude -c user.email=claude@anthropic.local commit`, which makes GitHub
 * show the commit as Claude or an unknown user. `GIT_AUTHOR_*` / `GIT_COMMITTER_*` beat every
 * `user.*` setting (including `-c`), so exporting them pins every commit to the real user.
 *
 * Resolution order: the account logged into `gh` (name + GitHub noreply email, so commits link
 * to the profile), then `git config --global user.*`. Set `MINITUI_GIT_IDENTITY=0` to opt out;
 * explicit `GIT_AUTHOR_*` / `GIT_COMMITTER_*` in the environment are always respected.
 */

export interface GitIdentity {
  name: string;
  email: string;
}

type Runner = (cmd: string[]) => string;

function defaultRunner(cmd: string[]): string {
  try {
    const out = Bun.spawnSync({ cmd, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 });
    return out.exitCode === 0 ? out.stdout.toString().trim() : "";
  } catch {
    return ""; // command missing
  }
}

/** Identity of the `gh` account: `{ name || login, email || <id>+<login>@users.noreply.github.com }`. */
export function ghIdentity(run: Runner = defaultRunner): GitIdentity | null {
  const raw = run(["gh", "api", "user", "--jq", "{login, name, id, email}"]);
  if (!raw) return null;
  try {
    const user = JSON.parse(raw) as { login?: string; name?: string | null; id?: number; email?: string | null };
    if (!user.login) return null;
    const email = user.email || (user.id ? `${user.id}+${user.login}@users.noreply.github.com` : "");
    if (!email) return null;
    return { name: user.name || user.login, email };
  } catch {
    return null;
  }
}

/** Identity from the user's global git config. */
export function gitConfigIdentity(run: Runner = defaultRunner): GitIdentity | null {
  const name = run(["git", "config", "--global", "user.name"]);
  const email = run(["git", "config", "--global", "user.email"]);
  return name && email ? { name, email } : null;
}

let cached: GitIdentity | null | undefined;

/** The user's identity (resolved once per process). */
export function resolveGitIdentity(run: Runner = defaultRunner): GitIdentity | null {
  if (cached === undefined) cached = ghIdentity(run) ?? gitConfigIdentity(run);
  return cached;
}

/** Reset the per-process cache (tests). */
export function resetGitIdentity(): void {
  cached = undefined;
}

/** `GIT_AUTHOR_*` / `GIT_COMMITTER_*` for a run, or `{}` when disabled / already set / unknown. */
export function gitIdentityEnv(
  env: NodeJS.ProcessEnv = process.env,
  resolve: () => GitIdentity | null = () => resolveGitIdentity(),
): Record<string, string> {
  if (env.MINITUI_GIT_IDENTITY === "0") return {};
  const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
  if (keys.every((k) => env[k])) return {};
  const id = resolve();
  if (!id) return {};
  const out: Record<string, string> = {};
  for (const k of keys) if (!env[k]) out[k] = k.endsWith("_NAME") ? id.name : id.email;
  return out;
}
