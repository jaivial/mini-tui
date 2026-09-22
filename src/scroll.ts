import type { ScrollAcceleration } from "@opentui/core";

/**
 * Constant-multiplier wheel acceleration: every mouse-wheel delta is scaled by
 * `factor`, so the wheel scrolls faster without changing keyboard paging.
 */
export class WheelSpeed implements ScrollAcceleration {
  private readonly factor: number;
  private readonly burst: number;

  constructor(factor = 2, burst = 3) {
    this.factor = factor;
    this.burst = Math.max(factor, burst);
  }

  private lastTick = 0;
  private streak = 0;

  tick(now: number = Date.now()): number {
    // consecutive quick wheel events ramp towards `burst`, slow ones stay at `factor`
    this.streak = now - this.lastTick < 120 ? Math.min(this.streak + 1, 4) : 0;
    this.lastTick = now;
    return this.factor + ((this.burst - this.factor) * this.streak) / 4;
  }

  reset(): void {
    this.streak = 0;
    this.lastTick = 0;
  }
}
