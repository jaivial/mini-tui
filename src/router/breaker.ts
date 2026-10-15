/**
 * v6-C: the persistent circuit breaker.
 *
 * A provider that answers 429 / 402 / 403 / 5xx / timeout is not "unlucky right
 * now": for the length of its quota window it cannot serve another call, and
 * retrying it burns the wall clock of the run that could have been finished by
 * the next model. The breaker is what makes fallback *silent* — the model is
 * marked unavailable, the router moves on, and the user sees a finished task
 * instead of a provider error.
 *
 * **It must survive a restart.** A breaker that lives in memory forgets every
 * exhausted quota the moment `systemctl restart mini-tui-web` runs, and the very
 * first task after a deploy walks straight back into the 429 that just emptied
 * the window. So the state is a small SQLite table next to the usage ledger,
 * written with `synchronous=FULL`: a lost write costs one extra 429, a lost
 * window costs a stuck run.
 *
 * Shape per model: `closed` (normal), `open` (skip until `openUntil`), and
 * `half-open` (one probe allowed after the cooldown, which closes the circuit on
 * success and re-opens it with a longer cooldown on failure).
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Why a model was taken out — every one of these is a reason to move on. */
export type BreakerReason =
  | "rate-limited" // 429
  | "quota-exhausted" // 403, quota window spent
  | "payment-required" // 402, credits/plan gone
  | "server-error" // 5xx
  | "timeout" // no answer inside the budget
  | "empty-content" // HTTP 200 with a null/empty body: the reasoning ate the budget
  | "auth" // 401: key revoked, not retryable by falling back
  | "unknown";

export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerRow {
  model: string;
  provider: string;
  state: BreakerState;
  /** Epoch ms the circuit stops being open. 0 = open indefinitely (auth). */
  openUntil: number;
  failures: number;
  reason: BreakerReason;
  detail: string;
  lastFailureAt: number;
  openedAt: number;
}

export interface BreakerStatus {
  model: string;
  state: BreakerState;
  /** True when this call must not use the model. */
  blocked: boolean;
  reason: BreakerReason;
  detail: string;
  failures: number;
  /** Epoch ms the circuit reopens, or 0 when it is not time-blocked. */
  retryAt: number;
}

/** Cooldowns by consecutive failure count, in ms. The last one is the ceiling. */
const COOLDOWN_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000];
/** A failure that will not fix itself by waiting out a window (a revoked key). */
const PERMANENT: ReadonlySet<BreakerReason> = new Set<BreakerReason>(["auth"]);
/** One probe through a cooled-down circuit, so a fixed provider heals without a restart. */
const HALF_OPEN_MS = 30_000;

export function breakerDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINITUI_ROUTER_DB ?? join(homedir(), ".local", "share", "mini-tui", "router.sqlite");
}

function text(value: unknown, max = 256): string {
  // Provider error strings are untrusted: strip control characters (they can
  // rewrite a terminal line) and bound the length.
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";
}

function reasonOf(value: unknown): BreakerReason {
  const list: BreakerReason[] = ["rate-limited", "quota-exhausted", "payment-required", "server-error", "timeout", "empty-content", "auth", "unknown"];
  return list.includes(value as BreakerReason) ? (value as BreakerReason) : "unknown";
}

export class CircuitBreaker {
  readonly db: Database;
  readonly path: string;

  constructor(path: string = breakerDbPath()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS breakers(
      model TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'closed',
      open_until INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT 'unknown',
      detail TEXT NOT NULL DEFAULT '',
      last_failure_at INTEGER NOT NULL DEFAULT 0,
      opened_at INTEGER NOT NULL DEFAULT 0
    )`);
  }

  /** Whether this model may be used right now. A cooldown that has elapsed reads as half-open. */
  status(model: string, now = Date.now()): BreakerStatus {
    const row = this.db.query("SELECT * FROM breakers WHERE model = ?").get(model) as Record<string, unknown> | undefined;
    if (!row) return { model, state: "closed", blocked: false, reason: "unknown", detail: "", failures: 0, retryAt: 0 };
    const stored = text(row.state) as BreakerState;
    const openUntil = Number(row.open_until ?? 0);
    const failures = Number(row.failures ?? 0);
    const reason = reasonOf(row.reason);
    const detail = text(row.detail);
    if (stored === "closed") return { model, state: "closed", blocked: false, reason, detail, failures, retryAt: 0 };
    if (openUntil === 0) return { model, state: "open", blocked: true, reason, detail, failures, retryAt: 0 };
    if (now < openUntil) return { model, state: "open", blocked: true, reason, detail, failures, retryAt: openUntil };
    // The cooldown elapsed: one probe is allowed through.
    return { model, state: "half-open", blocked: false, reason, detail, failures, retryAt: 0 };
  }

  /**
   * Record a failure and open the circuit. `failures` escalates, so a provider
   * that keeps failing stays out for longer each time, and a permanent reason
   * (a revoked key) never reopens on a timer — only `reset` does.
   */
  trip(model: string, reason: BreakerReason, detail = "", now = Date.now()): BreakerStatus {
    const previous = this.status(model, now);
    const failures = previous.failures + 1;
    const permanent = PERMANENT.has(reason);
    const cooldown = COOLDOWN_MS[Math.min(failures, COOLDOWN_MS.length) - 1] ?? COOLDOWN_MS[COOLDOWN_MS.length - 1]!;
    const openUntil = permanent ? 0 : now + cooldown;
    this.db
      .query(`INSERT INTO breakers(model,provider,state,open_until,failures,reason,detail,last_failure_at,opened_at)
        VALUES(?1,'',?2,?3,?4,?5,?6,?7,?7)
        ON CONFLICT(model) DO UPDATE SET state=?2, open_until=?3, failures=?4, reason=?5, detail=?6, last_failure_at=?7, opened_at=?7`)
      .run(model, "open", openUntil, failures, reason, text(detail), now);
    return { model, state: "open", blocked: true, reason, detail, failures, retryAt: openUntil };
  }

  /** A call that worked: close the circuit and clear the escalation. */
  close(model: string): void {
    this.db
      .query(`INSERT INTO breakers(model,provider,state,open_until,failures,reason,detail,last_failure_at,opened_at)
        VALUES(?1,'','closed',0,0,'unknown','',0,0)
        ON CONFLICT(model) DO UPDATE SET state='closed', open_until=0, failures=0, reason='unknown', detail=''`)
      .run(model);
  }

  /** Forget a cooldown so the operator can retry a model right now. */
  reset(model: string): boolean {
    return Number(this.db.query("DELETE FROM breakers WHERE model = ?").run(model).changes) > 0;
  }

  /** Every circuit, open ones first — the Settings panel's list. */
  list(now = Date.now()): BreakerStatus[] {
    const rows = this.db.query("SELECT model FROM breakers ORDER BY opened_at DESC").all() as Array<{ model: string }>;
    return rows.map((row) => this.status(text(row.model), now));
  }

  /**
   * Release the database handle. Named `dispose` rather than `close` because
   * `close(model)` above already means "close this model's circuit" — two
   * meanings on one name is how a test ends up tripping over a closed database.
   */
  dispose(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

// One store per process: opening SQLite per decision would cost more than the decision.
let shared: CircuitBreaker | null = null;

export function breakerStore(path?: string): CircuitBreaker {
  if (path) return new CircuitBreaker(path);
  shared ??= new CircuitBreaker();
  return shared;
}

export function resetBreakerStore(): void {
  shared?.dispose();
  shared = null;
}

/**
 * Classify what a provider said into a breaker reason.
 *
 * The catalog's own `errorFallbackRules` (v6-A) is the authority for the HTTP
 * side: 429 → rate-limited, 402 → payment, 403 → quota-exhausted, 5xx →
 * server-error, 401 → auth. Two house-specific cases are decided here because
 * they never arrive as a status code:
 *
 * - **timeout**: a transport/abort failure, or a call that blew its wall budget.
 * - **empty-content**: HTTP 200 with a null/empty message. `glm-5.3-flash` does
 *   this systematically under a small token budget — the reasoning consumes the
 *   budget and the content comes back null. Retrying the same model with the same
 *   budget reproduces it exactly, so it is a fallback reason, not a flake.
 */
export function classifyFailure(error: { status?: number | null; message?: string; emptyContent?: boolean }): BreakerReason {
  if (error.emptyContent) return "empty-content";
  const status = typeof error.status === "number" ? error.status : null;
  const message = (error.message ?? "").toLowerCase();
  if (status === 429) return "rate-limited";
  if (status === 402) return "payment-required";
  if (status === 403) return "quota-exhausted";
  if (status === 401) return "auth";
  if (status !== null && status >= 500 && status <= 599) return "server-error";
  if (status === null || status === 408) {
    if (/abort|timeout|timed out|etimedout|deadline|socket hang up|network|fetch failed/.test(message)) return "timeout";
  }
  if (/rate.?limit|too many requests|\b429\b/.test(message)) return "rate-limited";
  // Payment before quota: "insufficient credits" contains no "quota" today, but
  // a provider that words it "quota exhausted, top up your credits" would, and
  // the two need different operator actions (wait for the window vs add funds).
  if (/insufficient (credits|funds|balance)|\b402\b|payment required/.test(message)) return "payment-required";
  if (/quota|exhausted|rate window|\b403\b/.test(message)) return "quota-exhausted";
  if (/(5\d\d)\b|internal server|bad gateway|service unavailable|gateway timeout|overloaded/.test(message)) return "server-error";
  if (/timed? ?out|abort/.test(message)) return "timeout";
  return "unknown";
}

/** A short operator-facing line for a trip, so the audit says what actually happened. */
export function reasonLabel(reason: BreakerReason): string {
  switch (reason) {
    case "rate-limited":
      return "429 rate limited";
    case "quota-exhausted":
      return "403 quota window exhausted";
    case "payment-required":
      return "402 insufficient credits";
    case "server-error":
      return "5xx server error";
    case "timeout":
      return "timeout";
    case "empty-content":
      return "empty content (null reply)";
    case "auth":
      return "401 auth/permission";
    default:
      return "unknown failure";
  }
}