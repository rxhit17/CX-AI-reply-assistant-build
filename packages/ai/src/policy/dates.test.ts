import { describe, expect, it } from 'vitest';
import { addBusinessDays, addDays, daysBetween } from './dates.js';

describe('daysBetween', () => {
  it('counts calendar days regardless of time of day', () => {
    expect(daysBetween(new Date('2026-01-01T23:59:00Z'), new Date('2026-01-08T00:01:00Z'))).toBe(7);
  });
  it('is negative when target is earlier', () => {
    expect(daysBetween(new Date('2026-01-08T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))).toBe(
      -7,
    );
  });
});

describe('addDays', () => {
  it('adds across month boundary', () => {
    expect(addDays(new Date('2026-01-30T00:00:00Z'), 3).toISOString()).toBe(
      '2026-02-02T00:00:00.000Z',
    );
  });
});

describe('addBusinessDays', () => {
  it('skips weekends', () => {
    // Friday 2026-10-23 + 1 business day = Monday 2026-10-26
    expect(addBusinessDays(new Date('2026-10-23T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe(
      '2026-10-26',
    );
  });
  it('skips holidays', () => {
    expect(
      addBusinessDays(new Date('2026-10-23T00:00:00Z'), 1, ['2026-10-26'])
        .toISOString()
        .slice(0, 10),
    ).toBe('2026-10-27');
  });
  it('returns same date for zero', () => {
    expect(addBusinessDays(new Date('2026-10-23T00:00:00Z'), 0).toISOString().slice(0, 10)).toBe(
      '2026-10-23',
    );
  });
  it('rejects invalid input', () => {
    expect(() => addBusinessDays(new Date(), -1)).toThrow(RangeError);
  });
});
