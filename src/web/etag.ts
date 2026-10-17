/**
 * Conditional GET for the JSON API: an `ETag` on every read, and `304` when the client
 * already has it.
 *
 * WHAT WAS MEASURED, against the deployed server on 2026-10-17 with Chrome 145 over CDP:
 *
 *   - `/api/skills` answers **36 412 B** of JSON (11 % of the app's whole first load, and
 *     the second-largest transfer after the main bundle). None of it was ever compressed:
 *     `Accept-Encoding: gzip, br` came back with **no `Content-Encoding`** and the full
 *     36 412 B on the wire, while a hashed asset on the same server *is* gzipped
 *     (`App-…js`: 244 405 B -> 76 831 B). The asset path has a gzip memo 30 lines above
 *     this file's call site; the API path had none.
 *   - it carried **no `ETag`, no `Cache-Control` and no `Last-Modified`**, so there was no
 *     way for a browser to say "I already have this": every single visit re-shipped the
 *     whole payload.
 *   - the client makes that visit on a timer that has nothing to do with whether anything
 *     changed. `catalog.refreshSkills()` runs on **every `visibilitychange` back to
 *     visible** and on every `$` typed into the prompt bar, and both go through
 *     `loadSkills(true)` (forced), which is the one path that skips the
 *     `skillsStatus === "ready"` early return. Measured in one page lifetime: alt-tab
 *     away for 6 s and back re-fetched all 36 KB.
 *   - and the server rebuilds the list from scratch to answer it: `skillList()` walks
 *     `~/.config/mini-tui/skills` and does a **synchronous `readFileSync` of every
 *     `SKILL.md`** — 60 files, **701 904 B** read per request, on the one thread that also
 *     serves the terminal, the sockets and the channel mirror.
 *   - `/api/task-graph` (11 951 B, and a `Bun.spawn` of the Rust binary per call) had the
 *     same three missing headers, and the client asks for it **three times** on the first
 *     open of the task board.
 *
 * So the cost was paid whole, every time, for a payload that had not moved. This module is
 * the part that can be decided without a network: which responses may carry a validator,
 * what the validator says, and whether a request's `If-None-Match` already matches.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not cache anything server-side. A validator is a promise about a body, not a
 * copy of it: the skills list is still read from disk on every request, so a skill dropped
 * into the folder is still picked up on the next visit. Adding a TTL would have been the
 * smaller change and would have introduced a staleness window the client does not have
 * today — the same trade E22 refused when a truncated list was presented as a whole one.
 *
 * The validator is derived from the **bytes**, not from a timestamp or a counter. A
 * `max-age`-style shortcut would have been wrong here specifically: two different skill
 * folders, or a clock that moves backwards, would both have produced a "304" for a body
 * the client had never seen. Hashing the body cannot do that.
 */
import { createHash } from "node:crypto";

/** A weak validator: two bodies that gzip the same need not be the same bytes. */
export type Validator = string;

/** RFC 7232 `If-None-Match`: a list of validators, any of which may match. */
export type IfNoneMatch = string | null | undefined;

/**
 * The validator for a response body. Hex-digest of the bytes, quoted.
 *
 * `sha256` because it is in node's standard library on every runtime this server has, and
 * because the cost is irrelevant next to the `readFileSync` that produced the body: the
 * 36 KB payload hashes in well under a millisecond, and it is computed at most once per
 * response.
 */
export function etagFor(body: Uint8Array | string): Validator {
  return `"${createHash("sha256").update(body).digest("hex")}"`;
}

/** Everything after the last `,`, so a client that stacks validators still matches. */
function lastTag(value: string): string {
  const parts = value.split(",");
  return (parts[parts.length - 1] ?? "").trim();
}

/** Drop the `W/` weak prefix: a GET revalidation compares weak, per RFC 7232 §3.2. */
function normalize(tag: string): string {
  return tag.trim().replace(/^W\//i, "");
}

/**
 * Whether the client's cached copy is still current.
 *
 * `*` matches any existing representation, which is the documented way to ask "do you have
 * *something* for this URL" without naming it. A missing or empty header matches nothing:
 * that is the first visit, and it must be answered in full.
 */
export function isFresh(ifNoneMatch: IfNoneMatch, etag: Validator): boolean {
  if (!ifNoneMatch) return false;
  const header = ifNoneMatch.trim();
  if (header === "*") return true;
  const mine = normalize(etag);
  return header
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .some((tag) => normalize(tag) === mine);
}

/**
 * A JSON read that MAY be revalidated, decided from the request and the RESPONSE HEADERS
 * ALONE — no body, and that ordering is the whole contract.
 *
 * MEASURED, on the deployed server the day this was written: the first version of the
 * caller took `body` as a parameter and hashed it before asking, and `/api/stream` and the
 * SSE queue feed answered **0 bytes where the previous build answered 59 and 62**. Those
 * responses are open streams: `await response.arrayBuffer()` on one does not resolve until
 * the stream closes, which for a live feed is never, so the wrapper held both routes open
 * forever and the client saw a connection that never produced a byte. A rule that can only
 * be applied by consuming the body cannot be applied to a body that never ends.
 *
 * So this takes no body, and the caller checks it BEFORE reading anything. Content type is
 * what does the work: `text/event-stream` and every other non-JSON response is excluded by
 * the same test, with no list of streaming routes to keep in step with the code.
 *
 * The `method` check is the security-relevant half, not a nicety. `POST /api/sessions`
 * starts an agent and `PATCH /api/settings` writes a provider key; a validator on either
 * would let a client assert "I already have the answer" to a request that is supposed to
 * *do* something. Only reads get one.
 *
 * `no-store` in the caller's own headers is honoured rather than overridden: a response
 * that says it must not be stored must not end up in a disk cache behind an `ETag`.
 */
export function mayRevalidate(method: string, status: number, headers: Headers): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (status !== 200 || headers.get("content-encoding")) return false;
  if (!/^application\/json\b/i.test(headers.get("content-type") ?? "")) return false;
  if (/\bno-store\b/i.test(headers.get("cache-control") ?? "")) return false;
  return true;
}

/**
 * The headers a revalidatable read carries.
 *
 * `Cache-Control: no-cache` is the load-bearing one and it is not what it looks like: it
 * does NOT mean "do not store this", it means "store it, but ask again before using it".
 * That is exactly the contract wanted here — the browser keeps the bytes, revalidates on
 * every visit, and a `304` costs ~70 bytes of headers instead of 36 KB of body. Setting a
 * `max-age` instead would have bought silence between visits at the cost of showing a user
 * a skills list that no longer matches their disk.
 *
 * `Vary: accept-Encoding` is declared because the same URL is served in two encodings, and
 * a shared cache that mixed them up would be serving a client a body it cannot parse.
 */
export function revalidationHeaders(etag: Validator): Record<string, string> {
  return {
    etag,
    "cache-control": "no-cache",
    vary: "accept-encoding",
  };
}
