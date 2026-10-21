// limiter.js - a simple concurrency limiter
export class Limiter {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }

  // Resolves when a slot is free. BUGGY: two concurrent acquire() calls can
  // both see active < max and both run, exceeding the limit.
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
