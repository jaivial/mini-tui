/**
 * The channel consumer loop: durable, at-least-once handoff from the inbox to a
 * delivery handler. The inbox cursor advances only through CAS acknowledge after
 * the handler's durable side effects are done — a failed send never acknowledges.
 * No model polling, no unbounded reads: bounded pages, bounded backoff.
 */
import type { ChannelInbox } from "./inbox";

/** One accepted, not-yet-acknowledged inbox row (route fields are the accepted ones). */
export interface ConsumerRow {
  seq: number;
  channel: string;
  account: string;
  thread: string;
  message_id: string;
  sender: string;
  sent_at: number;
  payload: string;
  session: string;
  project: string;
}

export interface ChannelConsumerOptions {
  /** The durable checkpoint name in `channel_consumers`. One name, one cursor. */
  consumer: string;
  /** Idle poll interval (250 ms – 60 s; default 2 s). */
  pollMs?: number;
  /** First retry delay after a failure (default 2 s), doubling up to `maxBackoffMs`. */
  errorBackoffMs?: number;
  maxBackoffMs?: number;
  /** Rows read per pending() page (1–1000; default 20). */
  limit?: number;
}

export interface ChannelConsumerDeps {
  /**
   * Deliver one accepted message. Must be idempotent per row: the loop calls it
   * again after any failure, and only a clean resolve leads to acknowledge.
   */
  process(row: ConsumerRow): Promise<void>;
  /** Bounded context for operations; never message content or credentials. */
  log?(message: string): void;
}

export interface ChannelConsumer {
  stop(): Promise<void>;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function startChannelConsumer(inbox: ChannelInbox, options: ChannelConsumerOptions, deps: ChannelConsumerDeps): ChannelConsumer {
  if (!options.consumer || options.consumer.length > 256 || /[\x00-\x1f]/.test(options.consumer)) throw new Error("invalid consumer name");
  const pollMs = clamp(options.pollMs ?? 2_000, 250, 60_000);
  const firstBackoff = clamp(options.errorBackoffMs ?? 2_000, 250, 60_000);
  const maxBackoff = clamp(options.maxBackoffMs ?? 60_000, firstBackoff, 300_000);
  const limit = clamp(options.limit ?? 20, 1, 1000);

  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backoff = 0;
  let idleResolve: (() => void) | undefined;

  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
  };

  async function tick(): Promise<void> {
    if (stopped || busy) return;
    busy = true;
    try {
      for (;;) {
        const { cursor, messages } = inbox.pending(options.consumer, limit);
        if (!messages.length) {
          backoff = 0;
          schedule(pollMs);
          return;
        }
        let expected = cursor;
        for (const row of messages as unknown as ConsumerRow[]) {
          if (stopped) return;
          // The handler's own durability is the contract: only its clean resolve
          // lets the cursor move past this row.
          await deps.process(row);
          inbox.acknowledge(options.consumer, expected, { seq: row.seq, session: row.session, project: row.project });
          expected = row.seq;
          backoff = 0;
        }
        // Bounded page loop: drain at most `limit` rows per tick, then reschedule.
        schedule(0);
        return;
      }
    } catch (error) {
      backoff = backoff ? Math.min(backoff * 2, maxBackoff) : firstBackoff;
      const shape = error instanceof Error ? error.message : "unknown error";
      deps.log?.(`delivery failed (cursor stays at the failed row): ${shape}; retrying in ${backoff}ms`);
      schedule(backoff);
    } finally {
      busy = false;
      idleResolve?.();
    }
  }

  schedule(pollMs);
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (busy) await new Promise<void>((resolve) => { idleResolve = resolve; });
    },
  };
}
