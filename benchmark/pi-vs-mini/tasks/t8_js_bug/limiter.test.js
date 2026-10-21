import test from "node:test";
import assert from "node:assert/strict";
import { Limiter } from "./limiter.js";

test("never exceeds max concurrent", async () => {
  const lim = new Limiter(2);
  let inFlight = 0, peak = 0;
  const work = Array.from({ length: 40 }, () =>
    lim.run(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1 + Math.random() * 3));
      inFlight--;
    })
  );
  await Promise.all(work);
  assert.equal(peak, 2, `peak concurrency ${peak} exceeded 2`);
});

test("release hands the slot to exactly one waiter and never goes negative", async () => {
  const lim = new Limiter(2);
  await lim.acquire();
  await lim.acquire();
  const waiter = lim.acquire(); // queued
  lim.release();
  lim.release();
  lim.release();
  await waiter;
  assert.ok(lim.active >= 0 && lim.active <= lim.max, `active ${lim.active} out of range`);
});

test("a limiter reused after an over-release still caps concurrency", async () => {
  const lim = new Limiter(1);
  // over-release first (the bug makes active negative, which later breaks the cap)
  lim.release(); lim.release();
  let inFlight = 0, peak = 0;
  await Promise.all(Array.from({ length: 10 }, () =>
    lim.run(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    })));
  assert.equal(peak, 1, `peak ${peak} exceeded 1`);
});
