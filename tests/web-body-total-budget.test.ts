/**
 * The total ceiling on a request body, measured against the deployed build (E43).
 *
 * THE DEFECT. `BODY_TOTAL_SECONDS` was a FLAT 300 s applied to every body, so it
 * answered without ever asking how much was still owed. Measured with a raw
 * socket against the deployed build, sending 15 728 640 bytes at ~38 kB/s --
 * steady progress every single second, never a second of silence, the largest
 * file the app accepts:
 *
 *     t+ 299.0s sent 11.2 MB (38.2 kB/s)
 *     SEND FAILED at t+301.05s: [Errno 32] Broken pipe
 *     HTTP/1.1 408 Request Timeout
 *     {"error":"the request body did not finish within 300s"}
 *
 * 11,7 MB of a 15 MB file had gone out and the rest was thrown away. The idle
 * deadline never fired, because the client was never silent -- which is exactly
 * the distinction the file's own comment claims to make ("a total-time cap would
 * refuse real work"), immediately before shipping one that did.
 *
 * The same defect lived a second time in the web client, on its own flat 5 min
 * deadline, and there it was worse: the abort looked like a user cancel, so the
 * chip vanished with no toast at all (measured over CDP, E43).
 *
 * The rule these hold down: the ceiling is a function of the WORK, not of the
 * calendar. How long the largest legal body needs at the slowest rate still
 * counted as working -- and nothing more, so a trickle is still caught.
 */
import { describe, expect, test } from "bun:test";

import {
  BODY_IDLE_SECONDS,
  BODY_MIN_BYTES_PER_SECOND,
  BODY_TOTAL_FLOOR_SECONDS,
  BODY_TOTAL_MAX_SECONDS,
  BodyTimeout,
  JSON_MAX_BYTES,
  bodyTotalSeconds,
} from "../src/web/bodyRead";
import { ATTACH_MAX_BYTES } from "../src/web/attachments";
import { ATTACH_MAX } from "../web/src/lib/attachments";

/** A slow link is one where every byte arrives in its own tick. */
const SLOW_RATE = 38_000;

describe("the total ceiling is a function of the work", () => {
  test("the 15 MB upload that was refused at 301 s now has the time it needs", () => {
    // THE CASE. 15 MiB at 38 kB/s is 413 s of honest transfer; the old flat
    // ceiling killed it at 300 with 3,5 MB still owed.
    const budget = bodyTotalSeconds(ATTACH_MAX_BYTES + 8192);
    const secondsNeeded = Math.ceil((ATTACH_MAX_BYTES + 8192) / SLOW_RATE);
    expect(secondsNeeded).toBeGreaterThan(BODY_TOTAL_FLOOR_SECONDS);
    expect(budget).toBeGreaterThanOrEqual(secondsNeeded);
  });

  test("the web client and the server agree on the budget for the same file", () => {
    // They are separate packages with separate constants, which is how the same
    // bug shipped twice. They must not drift: the client's backstop has to sit
    // above the server's ceiling or it pre-empts an honest answer.
    expect(ATTACH_MAX).toBe(ATTACH_MAX_BYTES);
    const server = bodyTotalSeconds(ATTACH_MAX_BYTES + 8192);
    const client = Math.ceil((ATTACH_MAX * 1000) / BODY_MIN_BYTES_PER_SECOND);
    expect(client).toBeGreaterThanOrEqual(server);
  });

  test("a small JSON route is completely unchanged", () => {
    // 1 MiB at the floor rate is under the floor, so every read route keeps the
    // 300 s it has always had. No route that takes a prompt changes behaviour.
    expect(bodyTotalSeconds(JSON_MAX_BYTES)).toBe(BODY_TOTAL_FLOOR_SECONDS);
    expect(bodyTotalSeconds(0)).toBe(BODY_TOTAL_FLOOR_SECONDS);
    expect(bodyTotalSeconds(1024)).toBe(BODY_TOTAL_FLOOR_SECONDS);
  });

  test("the ceiling stays bounded whatever the limit", () => {
    // A large limit must not buy an unbounded hold on the connection.
    expect(bodyTotalSeconds(10 ** 12)).toBe(BODY_TOTAL_MAX_SECONDS);
    expect(BODY_TOTAL_MAX_SECONDS).toBeGreaterThan(BODY_TOTAL_FLOOR_SECONDS);
    // Monotone: more legal bytes never buys less time.
    let prev = 0;
    for (const limit of [1, 1e5, 1e6, 5e6, 1e7, 1.5e7, 1e9]) {
      const now = bodyTotalSeconds(limit);
      expect(now).toBeGreaterThanOrEqual(prev);
      prev = now;
    }
  });

  test("a trickle is still caught: progress at one byte per idle window is not work", () => {
    // The point of a ceiling at all. A client that sends a byte every
    // BODY_IDLE_SECONDS - 1 s resets the idle deadline forever, and the only
    // thing that ends it is a total budget. It must stay reachable.
    const budget = bodyTotalSeconds(ATTACH_MAX_BYTES + 8192);
    const trickleWindow = BODY_IDLE_SECONDS - 1;
    const bytesAfterBudget = Math.ceil((budget / trickleWindow) * 1000);
    expect(bytesAfterBudget).toBeLessThan(ATTACH_MAX_BYTES + 8192);
  });

  test("the message names the budget the read was actually given", () => {
    // E42's lesson one layer up: a status that is honest about the reason but
    // quotes a stale number is still a lie. Once the ceiling scales, "300s" is
    // only true for the routes that still use the floor.
    expect(new BodyTimeout("total").message).toBe("the request body did not finish within 300s");
    expect(new BodyTimeout("total", 1229_000).message).toBe("the request body did not finish within 1229s");
    expect(new BodyTimeout("idle").message).toBe(`the request body stopped arriving for ${BODY_IDLE_SECONDS}s`);
  });

  test("the rule origin/main used: one flat clock, whatever was still owed", () => {
    // The control A/B, in the shape this file already uses: reproduce what
    // origin/main does so the comparison is BEHAVIOUR, not exports. The old code
    // was `setTimeout(..., BODY_TOTAL_SECONDS * 1000)` with BODY_TOTAL_SECONDS
    // a flat 300, never consulting the `limit` the same function enforces.
    const mainCeilingSeconds = (limit: number) => 300;
    const bytes = ATTACH_MAX_BYTES + 8192;
    const owed = Math.ceil(bytes / SLOW_RATE);
    expect(owed).toBeGreaterThan(mainCeilingSeconds(bytes)); // <- the measured refusal
    expect(bodyTotalSeconds(bytes)).toBeGreaterThanOrEqual(owed);
  });

  test("the source no longer carries a flat ceiling applied to every body", () => {
    // The constant is gone from the timer itself, so it cannot be reintroduced by
    // editing one number (E41's lesson: protection by type, not by custom).
    const src = require("node:fs").readFileSync(new URL("../src/web/bodyRead.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/BODY_TOTAL_SECONDS\b/);
    expect(src).toMatch(/bodyTotalSeconds\(limit\)/);
  });
});
