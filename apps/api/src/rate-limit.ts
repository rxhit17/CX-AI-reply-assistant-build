/**
 * Small in-process sliding-window limiter for AI generation (per agent and per conversation).
 * In-memory is deliberate (no Redis): correct for a single API instance. Behind multiple instances each one
 * enforces its own window, so the effective limit scales with instance count; documented in ARCHITECTURE.md.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt. Returns `{ allowed: false, retryAfterMs }` when the key is over its limit. */
  take(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: this.windowMs - (t - recent[0]!) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(t);
    return { allowed: true };
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.every((h) => t - h >= this.windowMs)) this.hits.delete(k);
  }
}
