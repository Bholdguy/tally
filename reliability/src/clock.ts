/** Time abstraction so the gate's evidence wait is testable deterministically (no real sleeps in tests). */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Deterministic clock: `sleep` advances virtual time and runs anything scheduled for that window, so a test can script
 * "the stream drops at t=1200 ms" and watch the gate react at exactly that moment.
 */
export class FakeClock implements Clock {
  private t = 0;
  private timers: { at: number; fn: () => void }[] = [];
  now(): number { return this.t; }
  /** run `fn` when virtual time reaches `atMs` */
  at(atMs: number, fn: () => void): void { this.timers.push({ at: atMs, fn }); this.timers.sort((a, b) => a.at - b.at); }
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = target;
  }
  async sleep(ms: number): Promise<void> { this.advance(ms); }
}
