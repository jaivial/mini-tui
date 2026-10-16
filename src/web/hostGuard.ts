/**
 * Which hostnames this server answers to, decided by the SERVER and never read
 * back off the request.
 *
 * The bug this exists to prevent: `sameOrigin` used to compare the request's
 * `Origin` against the request's own `Host` (and `X-Forwarded-Host`). A page
 * that controls DNS defeats that completely. `evil.example` resolves to
 * 127.0.0.1, the browser sends `Host: evil.example` and `Origin:
 * http://evil.example` — a *perfect* same-origin pair, forged by the attacker,
 * not forged by the browser's protection. Measured against this server before
 * the fix: `/api/hub` answered 101 and handed over an interactive shell as
 * `jaime` (full RCE), and `POST /api/sessions` answered 201 and spawned an
 * agent, from a Host the server had never heard of.
 *
 * The fix in one line: the comparison target stops being attacker-supplied.
 * The allowlist is the bind address, loopback in its spellings, and whatever
 * names the operator declares. `X-Forwarded-Host` is not consulted at all —
 * nginx sets it from the *original* request, so a caller can forge it freely
 * (measured: 201 on `POST /api/sessions` from a plain `curl` with no DNS
 * tricks at all, and 101 on the hub socket).
 */

/** One accepted spelling of one name: an optional port after it. */
export interface HostRule {
  /** The name itself, lowercased, without brackets or port (`127.0.0.1`, `mini.example`). */
  name: string;
  /** The port, or null to accept any (a reverse proxy may or may not pass one). */
  port: number | null;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/** True for the names that mean "this machine", whatever the port. */
export function isLoopbackName(name: string): boolean {
  return LOOPBACK.has(name.toLowerCase());
}

/**
 * Split an authority (`host`, `host:port`, `[::1]:4317`) into its two parts.
 * Returns null for anything malformed — a Host header we cannot parse is a
 * Host we will not accept, rather than one we try to guess at.
 */
export function parseAuthority(raw: string): { name: string; port: number | null } | null {
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 255) return null;
  // Bracketed IPv6: the colon inside the brackets is part of the name.
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return null;
    const name = value.slice(0, close + 1);
    const rest = value.slice(close + 1);
    if (!rest) return { name, port: null };
    if (!/^:\d{1,5}$/.test(rest)) return null;
    const port = Number(rest.slice(1));
    return port >= 1 && port <= 65535 ? { name, port } : null;
  }
  const colon = value.indexOf(":");
  if (colon < 0) return { name: value, port: null };
  // More than one colon and no brackets: a bare IPv6 literal.
  if (value.indexOf(":", colon + 1) >= 0) return { name: value, port: null };
  const portPart = value.slice(colon + 1);
  if (!/^\d{1,5}$/.test(portPart)) return null;
  const port = Number(portPart);
  return port >= 1 && port <= 65535 ? { name: value.slice(0, colon), port } : null;
}

/**
 * The rules this process serves, from server state only:
 *  - the address it is bound to (`MINITUI_WEB_HOST` / `--host`);
 *  - loopback, in every spelling and on any port (the Vite dev proxy, `curl`,
 *    and the app talking to itself);
 *  - extra names the operator declares, for the deployments that answer on a
 *    public hostname behind a proxy (`MINITUI_WEB_ALLOWED_HOSTS`).
 */
export function hostRules(bindHost: string, extra: string[] = []): HostRule[] {
  const rules: HostRule[] = [];
  const seen = new Set<string>();
  const add = (name: string, port: number | null): void => {
    const key = `${name}:${port ?? "*"}`;
    if (seen.has(key)) return;
    seen.add(key);
    rules.push({ name, port });
  };
  const bind = parseAuthority(bindHost);
  if (bind) add(bind.name, bind.port);
  for (const name of ["localhost", "127.0.0.1", "::1", "[::1]"]) add(name, null);
  for (const entry of extra) {
    const parsed = parseAuthority(entry);
    if (parsed) add(parsed.name, parsed.port);
  }
  return rules;
}

/** The `MINITUI_WEB_ALLOWED_HOSTS` value as a list, ignoring empty entries. */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * True when `raw` (a `Host` header) names this server, per `rules`.
 * A rule without a port accepts any port: a proxy that strips the port and a
 * direct client that sends it are the same deployment, and refusing the second
 * would break the app for no security gain.
 */
export function hostAllowed(raw: string | null, rules: HostRule[]): boolean {
  if (!raw) return false;
  const got = parseAuthority(raw);
  if (!got) return false;
  return rules.some((rule) => {
    if (rule.name !== got.name) return false;
    return rule.port === null || rule.port === got.port;
  });
}

/**
 * The origin guard, now comparing `Origin` against server state instead of
 * against the attacker's own `Host`.
 *
 * A request with no `Origin` is not a browser cross-site request (curl, the
 * test suite, a server-to-server call): there is nothing to hijack, and the
 * caller already reached a loopback port, which is the boundary that matters.
 * A browser always sends `Origin` on both fetches and WebSocket handshakes,
 * and a page cannot forge it — that premise is sound. What was unsound was
 * trusting the *other* side of the comparison.
 */
export function sameOrigin(headers: Headers, rules: HostRule[]): boolean {
  const origin = headers.get("origin");
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return hostAllowed(host, rules);
}
