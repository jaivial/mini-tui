import { describe, expect, test } from "bun:test";

import { WheelSpeed } from "../src/scroll";

describe("WheelSpeed", () => {
  test("always scrolls at least 2x and ramps up to 3x on quick bursts", () => {
    const accel = new WheelSpeed(2, 3);
    expect(accel.tick(1000)).toBe(2); // relaxed wheel
    expect(accel.tick(1050)).toBeCloseTo(2.25); // quick streak ramps
    expect(accel.tick(1100)).toBeCloseTo(2.5);
    expect(accel.tick(1150)).toBeCloseTo(2.75);
    expect(accel.tick(1200)).toBe(3); // sustained burst caps at 3x

    accel.reset();
    expect(accel.tick(9000)).toBe(2); // a slow wheel is back to the base factor
  });
});
