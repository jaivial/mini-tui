/** Rate limiter: fixed window, retry-after, bounded memory. */
import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/web/rateLimit";

describe("RateLimiter", () => {
  test("allows up to max in the window, then refuses with a retry-after", () => {
    const rl = new RateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(rl.take("a", t0).ok).toBe(true);
    expect(rl.take("a", t0 + 1).ok).toBe(true);
    expect(rl.take("a", t0 + 2).ok).toBe(true);
    const denied = rl.take("a", t0 + 3);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfter).toBeGreaterThan(0);
    expect(denied.retryAfter).toBeLessThanOrEqual(60);
  });

  test("the window slides: old hits stop counting", () => {
    const rl = new RateLimiter(1, 5_000);
    const t0 = 2_000_000;
    expect(rl.take("b", t0).ok).toBe(true);
    expect(rl.take("b", t0 + 1_000).ok).toBe(false);
    expect(rl.take("b", t0 + 5_001).ok).toBe(true);
  });

  test("keys are independent", () => {
    const rl = new RateLimiter(1, 60_000);
    expect(rl.take("x", 3_000_000).ok).toBe(true);
    expect(rl.take("y", 3_000_000).ok).toBe(true);
  });

  test("sweep forgets expired keys", () => {
    const rl = new RateLimiter(2, 1_000);
    rl.take("old", 4_000_000);
    rl.sweep(4_005_000);
    expect(rl.tracked).toBe(0);
  });
});
