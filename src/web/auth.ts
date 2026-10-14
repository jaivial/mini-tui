/**
 * Cookie session auth for the web app — the qwenchat v4 model (src/auth.rs there), ported.
 *
 * Login verifies against an htpasswd file (apr1 hashes) so the credentials are exactly the
 * ones the old nginx basic-auth used — no new password to manage. The session cookie is
 * `v1.<exp>.<nonce>.<hmac>` HMAC-SHA256-signed with a secret persisted in a 0600 file
 * (survives restarts), 30-day expiry with sliding renewal, and a file-backed nonce list so
 * logout revokes for real.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const COOKIE_NAME = "mini_session";
export const COOKIE_TTL = 30 * 24 * 3600; // seconds
/** Renew the cookie once less than half the TTL remains (sliding window). */
export const RENEW_THRESHOLD = 15 * 24 * 3600;

// ---- apr1 (Apache $apr1$) MD5 crypt -----------------------------------------------------------------------------

const ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Apache's apr_md5_encode (classic FreeBSD md5crypt with the "$apr1$" magic), per apr_md5.c. */
export function md5Apr1(password: string, salt: string): string {
  const pw = Buffer.from(password, "utf8");
  const sl = Buffer.from(salt.slice(0, 8), "utf8");

  let ctx = createHash("md5").update(pw).update("$apr1$").update(sl);
  let final_ = createHash("md5").update(pw).update(sl).update(pw).digest();

  // The digest of (pw + salt + pw), added back in min(16, remaining) chunks.
  for (let pl = pw.length; pl > 0; pl -= 16) {
    ctx.update(final_.subarray(0, Math.min(16, pl)));
  }
  // "Don't leave anything around in vm they could use" — then "something really weird":
  // the digest is ZEROED first, so an odd length folds in a NUL byte, not a digest byte.
  const zero = Buffer.alloc(1);
  for (let i = pw.length; i > 0; i >>= 1) {
    if (i & 1) ctx.update(zero);
    else ctx.update(pw.subarray(0, 1));
  }
  final_ = ctx.digest();
  // 1000 rounds of pw/final + salt/pw stir-fry.
  for (let i = 0; i < 1000; i++) {
    const ctx1 = createHash("md5");
    if (i & 1) ctx1.update(pw);
    else ctx1.update(final_);
    if (i % 3) ctx1.update(sl);
    if (i % 7) ctx1.update(pw);
    if (i & 1) ctx1.update(final_);
    else ctx1.update(pw);
    final_ = ctx1.digest();
  }
  // to64, three bytes at a time, then the last byte's two bits.
  const I = ITOA64;
  let out = "";
  for (const [a, b, c] of [[0, 6, 12], [1, 7, 13], [2, 8, 14], [3, 9, 15], [4, 10, 5]] as const) {
    let l = ((final_[a]! << 16) | (final_[b]! << 8) | final_[c]!) >>> 0;
    for (let k = 0; k < 4; k++) {
      out += I[l & 0x3f];
      l >>= 6;
    }
  }
  const l = final_[11]!;
  out += I[l & 0x3f];
  out += I[(l >> 6) & 0x3f];
  return out;
}

function apr1Verify(password: string, hash: string): boolean {
  const rest = hash.startsWith("$apr1$") ? hash.slice(6) : hash;
  const i = rest.indexOf("$");
  if (i <= 0) return false;
  const salt = rest.slice(0, i);
  const expected = rest.slice(i + 1);
  if (!salt || !expected) return false;
  const calc = md5Apr1(password, salt);
  if (calc.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(calc), Buffer.from(expected));
}

/** Verify `user`/`password` against an htpasswd file (apr1 lines: `user:hash`). Unknown user still runs a dummy verify to keep timing flat. */
export function verifyHtpasswd(path: string, user: string, password: string): boolean {
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    console.error(`auth: cannot read htpasswd file ${path}`);
    return false;
  }
  let found: string | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const c = trimmed.indexOf(":");
    if (c < 0) continue;
    if (trimmed.slice(0, c) === user) found = trimmed.slice(c + 1);
  }
  if (!found) {
    apr1Verify(password, "$apr1$xxxxxxxx$0000000000000000000000");
    return false;
  }
  return apr1Verify(password, found);
}

// ---- secret -----------------------------------------------------------------------------------------------------

export function configDir(): string {
  return process.env.MINITUI_CONFIG_DIR ?? join(homedir(), ".config/minitui");
}

export function defaultSecretPath(): string {
  return process.env.MINITUI_WEB_SESSION_SECRET ?? join(configDir(), "web-session-secret");
}

/**
 * Where the accepted credentials live. Defaults beside the config (a deployment that wants the
 * very same credentials its old nginx basic-auth had points MINITUI_WEB_HTPASSWD at that
 * htpasswd file). No file, no gate — the server stays usable, loudly logged.
 */
export function defaultHtpasswdPath(): string {
  return process.env.MINITUI_WEB_HTPASSWD ?? join(configDir(), "web-htpasswd");
}

/** Load the HMAC secret from `path`; generate and persist a fresh one (0600) when missing. A persistent secret means existing cookies survive restarts. */
export function loadOrCreateSecret(path = defaultSecretPath()): Buffer {
  try {
    const hex = readFileSync(path, "utf8").trim();
    if (hex.length >= 32) return Buffer.from(hex, "utf8");
  } catch {}
  const fresh = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${fresh}\n`, { mode: 0o600 });
  console.error(`auth: generated new cookie secret at ${path}`);
  return Buffer.from(fresh, "utf8");
}

// ---- cookie -----------------------------------------------------------------------------------------------------

function sign(secret: Buffer, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export { sign };

export interface CookieClaims {
  nonce: string;
  exp: number;
}

/** `v1.<exp>.<nonce>.<sig>` — sig covers `v1.<exp>.<nonce>`. */
export function makeCookieValue(secret: Buffer, nonce: string, exp: number): string {
  const body = `v1.${exp}.${nonce}`;
  return `${body}.${sign(secret, body)}`;
}

export function verifyCookie(secret: Buffer, value: string): CookieClaims | null {
  const c = value.lastIndexOf(".");
  if (c < 0) return null;
  const body = value.slice(0, c);
  const given = value.slice(c + 1);
  const expected = sign(secret, body);
  if (expected.length !== given.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return null;
  const [ver, expRaw, nonce] = body.split(".");
  if (ver !== "v1" || !expRaw || !nonce) return null;
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp <= now()) return null;
  return { nonce, exp };
}

export function cookieHeader(secret: Buffer, nonce: string, maxAge: number, secure: boolean): string {
  const exp = now() + maxAge;
  const value = makeCookieValue(secret, nonce, exp);
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

const now = (): number => Math.floor(Date.now() / 1000);

// ---- revocable sessions (file-backed nonces) --------------------------------------------------------------------

/**
 * Where the live session nonces live. Logout deletes the nonce, so the signed cookie stops
 * working even though it still verifies — revocation is real, not just "forget the cookie".
 */
class SessionFile {
  #path: string;
  #sessions = new Map<string, number>();
  constructor(path: string) {
    this.#path = path;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
      for (const [nonce, exp] of Object.entries(raw)) {
        if (typeof exp === "number" && exp > now()) this.#sessions.set(nonce, exp);
      }
    } catch {}
  }
  add(nonce: string, exp: number): void {
    this.#sessions.set(nonce, exp);
    this.#save();
  }
  has(nonce: string): boolean {
    const exp = this.#sessions.get(nonce);
    if (exp === undefined) return false;
    if (exp <= now()) {
      this.#sessions.delete(nonce);
      this.#save();
      return false;
    }
    return true;
  }
  revoke(nonce: string): void {
    if (this.#sessions.delete(nonce)) this.#save();
  }
  #save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(this.#path, JSON.stringify(Object.fromEntries(this.#sessions)), { mode: 0o600 });
    } catch (error) {
      console.error(`auth: cannot save sessions: ${(error as Error).message}`);
    }
  }
}

// ---- the gate ---------------------------------------------------------------------------------------------------

export interface Auth {
  /** True when no htpasswd file could be read: the gate stays open rather than locking everyone out. */
  disabled: boolean;
  secret: Buffer;
  htpasswd: string;
  sessions: SessionFile;
  /** The cookie of this request, verified and still live (not revoked): null when there is none. */
  claimsOf(request: Request): CookieClaims | null;
}

export function initAuth(): Auth {
  const htpasswd = defaultHtpasswdPath();
  if (!existsSync(htpasswd)) {
    console.error(`auth: no htpasswd at ${htpasswd} — the sign-in gate is OFF (set MINITUI_WEB_HTPASSWD to enable it)`);
  }
  const secret = loadOrCreateSecret();
  const sessions = new SessionFile(join(dirname(defaultSecretPath()), "web-sessions.json"));
  return {
    disabled: !existsSync(htpasswd),
    secret,
    htpasswd,
    sessions,
    claimsOf(request) {
      const header = request.headers.get("cookie") ?? "";
      for (const part of header.split(";")) {
        const [name, ...rest] = part.trim().split("=");
        if (name !== COOKIE_NAME) continue;
        const claims = verifyCookie(secret, rest.join("="));
        if (!claims) return null;
        if (!sessions.has(claims.nonce)) return null; // revoked (logout) or the session file was reset
        return claims;
      }
      return null;
    },
  };
}

/** The request is https (as seen by the proxy in front of us): mark the cookie Secure. */
const isSecure = (request: Request): boolean => (request.headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() === "https";

export function nonce(): string {
  return randomBytes(16).toString("hex");
}

export { isSecure };

// ---- the login page ---------------------------------------------------------------------------------------------

/** The login page, in the app's silver-on-graphite voice. `error` is pre-escaped by the caller. */
export function loginPage(error?: string): string {
  const err = error ? `<p class="error">${error.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0b0d">
<title>mini-tui · sign in</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
         background:#0a0b0d; color:#f2f3f5;
         font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
         padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
  .card { width:min(22rem, calc(100vw - 2.5rem)); padding:2rem; border-radius:14px;
          border:1px solid #26292f; background:#101214; }
  h1 { margin:0 0 .25rem; font-size:1.25rem; letter-spacing:-0.02em; font-weight:600; }
  h1 .dot { color:#c9cdd6; }
  p.sub { margin:0 0 1.5rem; color:#9aa0aa; font-size:.8125rem; }
  label { display:block; font-size:.75rem; color:#9aa0aa; margin:.75rem 0 .25rem; }
  input { width:100%; padding:.7rem .8rem; border-radius:8px; border:1px solid #26292f;
          background:#0a0b0d; color:#f2f3f5; font-size:.9375rem; outline:none; }
  input:focus { border-color:#c9cdd6; }
  button { margin-top:1.25rem; width:100%; padding:.7rem .8rem; border-radius:8px; border:1px solid #3b4048;
           background:#c9cdd6; color:#0a0b0d; font-size:.9rem; font-weight:600; cursor:pointer; }
  button:hover { background:#dfe2e8; }
  .error { margin:.75rem 0 0; padding:.5rem .7rem; border-radius:8px; font-size:.8125rem;
           border:1px solid #5a3a42; background:#241418; color:#e06879; }
  p.hint { margin:1.25rem 0 0; color:#71767f; font-size:.75rem; text-align:center; }
</style></head><body>
<form class="card" method="post" action="/api/login">
  <h1>mini-tui<span class="dot">.</span></h1>
  <p class="sub">Sign in to reach your agents and their bots.</p>
  <label for="user">User</label>
  <input id="user" name="user" autocomplete="username" autofocus required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  ${err}
  <button type="submit">Sign in</button>
  <p class="hint">Same credentials as always · stays signed in for 30 days</p>
</form>
</body></html>`;
}
