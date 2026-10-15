/**
 * "Escribiendo…" — the chat presence (typing indicator) for one turn.
 *
 * What the fork actually supports (probed on 127.0.0.1:8952, version 0.2.8):
 * `POST /chat/sendPresence/{instance}` with `{number, presence, delay?}` where
 * `presence` is one of `available | unavailable | composing | recording |
 * paused`. `composing` IS WhatsApp's typing indicator and `paused` is the only
 * way to clear it — there is no "stopped" state. A 201 is the only success.
 *
 * Honesty about what a 201 means: the fork validates NOTHING about the jid (a
 * nonexistent number and a group jid both return 201), so a 201 proves the call
 * was accepted by our own stack, never that a human's client drew "typing…".
 * Nothing here may report otherwise, and nothing here may treat a failure as a
 * turn failure.
 *
 * The invariant that matters: the indicator must NEVER stay stuck. It is armed
 * with a server-side `delay` (WhatsApp expires it on its own) AND cleared
 * locally in every exit path — turn success, turn throw, consumer stop. Three
 * independent brakes, because a bot that types forever is worse than one that
 * never types.
 */

import type { EvoSender, Presence } from "./evoSend";

export interface TypingConfig {
  /** Chat to mark. Group jids are accepted by the fork, DMs are the ones where
   * WhatsApp clients reliably render the indicator. */
  thread: string;
  /** Disable entirely (no composing call, no clear call). */
  enabled?: boolean;
  /** Server-side expiry handed to WhatsApp, ms. Never longer than the hard cap. */
  delayMs?: number;
  /** Re-arm cadence while the turn runs, ms. 0 disables the keepalive. */
  refreshMs?: number;
  /** Hard ceiling on how long the local "still typing" state can live, ms. */
  maxMs?: number;
  /** Per-call timeout — presence is a nicety, it must never delay the turn. */
  timeoutMs?: number;
}

export interface TypingHandle {
  /** "composing" went out (or was deliberately skipped). Always safe to call. */
  readonly started: boolean;
  /** Clear the indicator. Idempotent, never throws, never rejects. */
  clear(): Promise<void>;
}

/** WhatsApp expires a presence with this key; anything larger is clamped. */
const PRESENCE_DELAY_CAP_MS = 300_000;
const DEFAULT_TYPING_TIMEOUT_MS = 2_500;
/** Re-arm cadence while the turn is still running. WhatsApp expires a presence
 * on its own after `delay`; a turn that outruns one window must re-arm or the
 * indicator blinks off mid-answer. */
const DEFAULT_REFRESH_MS = 30_000;

/**
 * Arm the typing indicator for one turn. Returns a handle whose `clear()` is
 * total — the caller's `finally` can always call it without a guard.
 */
export function startTyping(
  sender: EvoSender,
  log: (event: string, fields?: Record<string, unknown>) => void,
  config: TypingConfig,
): TypingHandle {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TYPING_TIMEOUT_MS;
  const noop: TypingHandle = { started: false, clear: async () => {} };
  if (config.enabled === false) return noop;

  const delayMs = Math.min(PRESENCE_DELAY_CAP_MS, config.delayMs ?? config.maxMs ?? 60_000);
  const refreshMs = config.refreshMs ?? DEFAULT_REFRESH_MS;
  let cleared = false;
  // Armed from here, not from the successful call: if the composing call itself
  // hangs until it times out, WhatsApp may still have received it, so the clear
  // has to be reachable even on the failure path.
  let started = true;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const put = async (presence: "composing" | "paused"): Promise<void> => {
    const at = Date.now();
    const result = await sender.sendPresence({ number: config.thread, presence, delayMs: presence === "composing" ? delayMs : undefined, timeoutMs });
    if (presence === "composing") {
      log(`channel.typing.${result.kind}`, { thread: config.thread, delayMs, ms: Date.now() - at, ...(result.kind === "failed" ? { status: result.status, error: result.error.slice(0, 160) } : {}) });
      if (result.kind === "failed") started = false;
    } else {
      log(`channel.typing.cleared_${result.kind}`, { thread: config.thread, ...(result.kind === "failed" ? { status: result.status, error: result.error.slice(0, 160) } : {}) });
    }
  };

  const clear = async (): Promise<void> => {
    if (cleared) return;
    cleared = true;
    started = false;
    if (keepalive) {
      clearInterval(keepalive);
      keepalive = null;
    }
    try {
      await put("paused");
    } catch (error) {
      // A stuck indicator is bad, but a failed CLEAR inside a finally block must
      // not replace the turn's own outcome with a presence error.
      log("channel.typing.clear_failed", { thread: config.thread, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
    }
  };

  void (async () => {
    try {
      await put("composing");
      // Keep it lit for a long turn; never past `clear()`, which stops the timer.
      if (!cleared && refreshMs > 0 && delayMs > refreshMs) {
        keepalive = setInterval(() => {
          if (cleared) return;
          void put("composing").catch((error) => log("channel.typing.refresh_failed", { thread: config.thread, error: error instanceof Error ? error.message.slice(0, 120) : String(error) }));
        }, refreshMs);
        (keepalive as { unref?: () => void }).unref?.();
      }
    } catch (error) {
      started = false;
      log("channel.typing.error", { thread: config.thread, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
    }
  })();

  return { get started() { return started; }, clear };
}