import { describe, expect, it } from 'vitest';
import { findUnsupportedCoverageClaims } from './claims.js';

const SHIPPING =
  'Shipping is free on orders over $50. Orders of $50 or less ship for a flat $5.95. Standard delivery takes 3-5 business days after dispatch. Live plants ship Monday to Wednesday only so they never sit in a warehouse over a weekend.';
const PAYMENT =
  'If a payment fails or you were charged twice, please do not place the order again. A duplicate authorisation is normally released by your bank within 5 business days.';

describe('findUnsupportedCoverageClaims', () => {
  it('flags "we only ship within the United States" when the policy never says so', () => {
    const r = findUnsupportedCoverageClaims(
      'We currently only ship within the United States. Unfortunately, we do not offer shipping to Australia at this time.',
      SHIPPING,
    );
    expect(r.length).toBeGreaterThan(0);
    expect(r.flatMap((c) => c.missing)).toEqual(expect.arrayContaining(['united', 'australia']));
  });

  it('flags "we do not accept Bitcoin" and "we accept various other options"', () => {
    const r = findUnsupportedCoverageClaims(
      'Currently, we do not accept Bitcoin as a payment method. We accept various other payment options, which can be found at checkout.',
      PAYMENT,
    );
    expect(r.flatMap((c) => c.missing)).toContain('bitcoin');
  });

  it('allows a claim whose subject the policy does mention', () => {
    expect(
      findUnsupportedCoverageClaims('We do not ship live plants over a weekend.', SHIPPING),
    ).toEqual([]);
    expect(
      findUnsupportedCoverageClaims(
        'We do not take a new order if a payment fails; please do not place the order again.',
        PAYMENT,
      ),
    ).toEqual([]);
  });

  it('ignores ordinary policy wording and replies without coverage claims', () => {
    for (const text of [
      'Shipping is free on orders over $50 and delivery takes 3-5 business days.',
      'You can cancel while the order is still processing.',
      'The team will follow up with the exact instructions.',
      'Customers pay return shipping unless the item arrived damaged.',
      'I cannot confirm that, but the team will follow up.',
    ]) {
      expect(findUnsupportedCoverageClaims(text, SHIPPING + PAYMENT)).toEqual([]);
    }
  });
});
