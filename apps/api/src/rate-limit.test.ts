import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from './rate-limit.js';

describe('SlidingWindowLimiter', () => {
  it('allows up to max within the window, then blocks with a retry hint', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(2, 1000, () => t);
    expect(l.take('a')).toEqual({ allowed: true });
    t = 100;
    expect(l.take('a')).toEqual({ allowed: true });
    t = 200;
    expect(l.take('a')).toEqual({ allowed: false, retryAfterMs: 800 });
  });
  it('recovers after the window slides', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(1, 1000, () => t);
    l.take('a');
    t = 999;
    expect(l.take('a').allowed).toBe(false);
    t = 1001;
    expect(l.take('a').allowed).toBe(true);
  });
  it('keeps keys independent', () => {
    const l = new SlidingWindowLimiter(1, 1000, () => 0);
    expect(l.take('a').allowed).toBe(true);
    expect(l.take('b').allowed).toBe(true);
    expect(l.take('a').allowed).toBe(false);
  });
});
