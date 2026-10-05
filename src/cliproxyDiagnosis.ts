/**
 * Turn a failed `cliproxy/â¦` run's log tail into the one thing to check.
 *
 * cli-proxy is a local gateway, so a `cliproxy/` model has more moving parts than a hosted
 * provider: the gateway process, its config, the OAuth file it reads and an API key that both
 * sides have to agree on. Any one of them failing looks like any other in the transcript â
 * a refusal, a 401 or a 503 with the gateway's own jargon â so name the cause and its fix
 * instead of pasting a stack-shaped warning the user still has to decode.
 */

export interface CliproxyDiagnosis {
  /** What to check first, or "" when this tail is not a cli-proxy failure. */
  fix: string;
  /** The failing stage, for the label (`gateway`, `auth`, `model`, `credentials`). */
  stage: string;
}

const STAGES = ["gateway", "credentials", "auth", "model"] as const;

/**
 * Classify one log tail. Exported for tests and for a future `/doctor`; `tail` is whatever
 * `tailLog()` read from `mini.log`.
 */
export function diagnoseCliproxy(tail: string): CliproxyDiagnosis {
  const text = tail.toLowerCase();
  if (!text.includes("8317") && !text.includes("cliproxy") && !text.includes("cli-proxy")) {
    return { fix: "", stage: "" };
  }
  if (is("connection refused", "os error 111", "connect error")) {
    return {
      stage: "gateway",
      fix: "cli-proxy is not listening on port 8317: `systemctl --user start cli-proxy-api`, or point CLIPROXY_API_BASE where it runs",
    };
  }
  // Checked before the bare 401: a gateway fronts its own subscription login, so "OAuth â¦
  // revoked" / "auth_unavailable" arriving with a 401 status is the upstream login, not the key
  // mini sends. Blaming the key here sends the user off to edit a perfectly good one.
  if (is("auth_unavailable", "no auth available", "oauth", "revoked", "invalid_grant", "token refresh", "authentication_error", "cooldown")) {
    return {
      stage: "auth",
      fix: "the Claude subscription behind the gateway is signed out or cooling down: re-run its OAuth login (`cli-proxy-api -claude-login`), then check /v0/management/auth-files",
    };
  }
  if (is("invalid api key", "http 401", "status 401", "unauthorized")) {
    return {
      stage: "credentials",
      fix: "CLIPROXY_API_KEY does not match a key in the gateway's `api-keys`; set it to one the gateway accepts",
    };
  }
  if (is("not found", "404", "does not exist", "unknown model")) {
    return {
      stage: "model",
      fix: "the gateway does not advertise this id: compare with `curl $CLIPROXY_API_BASE/models` (its config maps ids to upstream models)",
    };
  }
  return { fix: "", stage: "" };

  function is(...needles: string[]): boolean {
    return needles.some((needle) => text.includes(needle));
  }
}

/** Which of the known stages this diagnosis reached, ordered by how early they break a run. */
export function stageRank(stage: string): number {
  const index = STAGES.indexOf(stage as (typeof STAGES)[number]);
  return index === -1 ? STAGES.length : index;
}
