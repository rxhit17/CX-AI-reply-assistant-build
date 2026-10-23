import { describe, expect, it } from 'vitest';
import {
  calculateDeliveryEstimate,
  calculateShippingEligibility,
  checkCancellationEligibility,
  checkDamageEligibility,
  checkRefundEligibility,
  checkReturnEligibility,
  type OrderFacts,
  type PolicyRef,
} from './rules.js';

const NOW = new Date('2026-10-23T12:00:00Z');
const daysAgo = (d: number, hours = 0) =>
  new Date(NOW.getTime() - d * 86_400_000 - hours * 3_600_000).toISOString();

const order = (over: Partial<OrderFacts> = {}): OrderFacts => ({
  order_number: 'BB-1',
  status: 'delivered',
  total: 64.5,
  currency: 'USD',
  placed_at: daysAgo(10),
  shipped_at: daysAgo(8),
  delivered_at: daysAgo(3),
  estimated_delivery_at: null,
  items: [],
  ...over,
});
const policy = (conditions: PolicyRef['conditions'], category = 'x'): PolicyRef => ({
  kbId: 'k',
  version: 1,
  title: 't',
  category,
  conditions,
});

describe('refund / return window', () => {
  const p7 = policy({ window_days: 7, window_anchor: 'delivery', discretionary_review: true });

  it('is eligible inside the window and reports days remaining', () => {
    const r = checkRefundEligibility(order({ delivered_at: daysAgo(3) }), p7, NOW);
    expect(r.outcome).toBe('eligible');
    expect(r.details.days_remaining).toBe(4);
  });
  it('treats the last day of the window as eligible (inclusive)', () => {
    expect(checkRefundEligibility(order({ delivered_at: daysAgo(7) }), p7, NOW).outcome).toBe(
      'eligible',
    );
  });
  it('is ineligible one day after the window and flags discretionary review separately', () => {
    const r = checkRefundEligibility(order({ delivered_at: daysAgo(8) }), p7, NOW);
    expect(r.outcome).toBe('ineligible');
    expect(r.details.discretionary_review_possible).toBe(true);
  });
  it('the brief’s example: delivered 20 days ago, 7-day policy → ineligible', () => {
    const r = checkRefundEligibility(order({ delivered_at: daysAgo(20) }), p7, NOW);
    expect(r.outcome).toBe('ineligible');
    expect(r.details.days_since_anchor).toBe(20);
    expect(r.details.deadline).toBe(
      new Date(NOW.getTime() - 13 * 86_400_000).toISOString().slice(0, 10),
    );
  });
  it('the same elapsed time differs by brand policy (30-day window)', () => {
    const p30 = policy({ window_days: 30, window_anchor: 'delivery' });
    expect(checkReturnEligibility(order({ delivered_at: daysAgo(12) }), p30, NOW).outcome).toBe(
      'eligible',
    );
    expect(checkReturnEligibility(order({ delivered_at: daysAgo(12) }), p7, NOW).outcome).toBe(
      'ineligible',
    );
    expect(checkReturnEligibility(order({ delivered_at: daysAgo(40) }), p30, NOW).outcome).toBe(
      'ineligible',
    );
  });
  it('cannot be evaluated before delivery', () => {
    const r = checkReturnEligibility(order({ status: 'in_transit', delivered_at: null }), p7, NOW);
    expect(r.outcome).toBe('insufficient_data');
  });
  it('cancelled orders are ineligible', () => {
    expect(checkReturnEligibility(order({ status: 'cancelled' }), p7, NOW).outcome).toBe(
      'ineligible',
    );
  });
  it('missing structured policy → insufficient data, never a guess', () => {
    expect(checkRefundEligibility(order(), policy(null), NOW).outcome).toBe('insufficient_data');
    expect(checkRefundEligibility(order(), undefined, NOW).outcome).toBe('insufficient_data');
  });
  it('supports an order-date anchor', () => {
    const p = policy({ window_days: 14, window_anchor: 'order' });
    expect(checkReturnEligibility(order({ placed_at: daysAgo(20) }), p, NOW).outcome).toBe(
      'ineligible',
    );
  });
});

describe('damage reports', () => {
  const bloom = policy({ report_within_days: 2, requires_photo: true, discretionary_review: true });
  const nordic = policy({ report_within_days: 14, requires_photo: true });

  it('needs a photo inside the window', () => {
    const r = checkDamageEligibility(
      order({ delivered_at: daysAgo(1) }),
      bloom,
      { hasPhoto: false },
      NOW,
    );
    expect(r.outcome).toBe('insufficient_data');
    expect(r.details.missing_evidence).toBe('photo');
  });
  it('is eligible with a photo inside the window', () => {
    expect(
      checkDamageEligibility(
        order({ delivered_at: daysAgo(1) }),
        bloom,
        { hasPhoto: true, visibleDamage: 'yes' },
        NOW,
      ).outcome,
    ).toBe('eligible');
  });
  it('48h boundary is measured in hours, not calendar days', () => {
    expect(
      checkDamageEligibility(
        order({ delivered_at: daysAgo(1, 23) }),
        bloom,
        { hasPhoto: true },
        NOW,
      ).outcome,
    ).toBe('eligible');
    expect(
      checkDamageEligibility(order({ delivered_at: daysAgo(2, 1) }), bloom, { hasPhoto: true }, NOW)
        .outcome,
    ).toBe('ineligible');
  });
  it('the same age is fine for the 14-day brand', () => {
    expect(
      checkDamageEligibility(order({ delivered_at: daysAgo(3) }), nordic, { hasPhoto: true }, NOW)
        .outcome,
    ).toBe('eligible');
  });
  it('a photo showing no damage escalates to human review rather than approving', () => {
    expect(
      checkDamageEligibility(
        order({ delivered_at: daysAgo(1) }),
        bloom,
        { hasPhoto: true, visibleDamage: 'no' },
        NOW,
      ).outcome,
    ).toBe('needs_review');
  });
  it('unclear/possible damage is still eligible pending verification', () => {
    expect(
      checkDamageEligibility(
        order({ delivered_at: daysAgo(1) }),
        bloom,
        { hasPhoto: true, visibleDamage: 'unclear' },
        NOW,
      ).outcome,
    ).toBe('eligible');
  });
});

describe('shipping threshold', () => {
  const p50 = policy({ free_shipping_threshold: 50 });
  it('is free strictly above the threshold', () => {
    expect(calculateShippingEligibility(50.01, p50).outcome).toBe('eligible');
    expect(calculateShippingEligibility(50, p50).outcome).toBe('ineligible');
    expect(calculateShippingEligibility(35.9, p50).outcome).toBe('ineligible');
  });
  it('different thresholds per brand', () => {
    expect(calculateShippingEligibility(95, policy({ free_shipping_threshold: 100 })).outcome).toBe(
      'ineligible',
    );
  });
  it('no threshold → insufficient data', () => {
    expect(calculateShippingEligibility(10, policy(null)).outcome).toBe('insufficient_data');
  });
});

describe('cancellation', () => {
  const strict = policy({ cancellable_until: 'processing' });
  const lenient = policy({ cancellable_until: 'shipped' });
  it.each([
    ['processing', strict, 'eligible'],
    ['shipped', strict, 'ineligible'],
    ['shipped', lenient, 'eligible'],
    ['in_transit', lenient, 'ineligible'],
    ['delivered', lenient, 'ineligible'],
    ['cancelled', lenient, 'ineligible'],
  ] as const)('%s with %j → %s', (status, pol, expected) => {
    expect(checkCancellationEligibility(order({ status }), pol).outcome).toBe(expected);
  });
});

describe('delivery estimate', () => {
  const ship = policy({ free_shipping_threshold: 50, delivery_business_days: [3, 5] });
  it('uses the carrier ETA when present', () => {
    const e = calculateDeliveryEstimate(
      order({ status: 'in_transit', delivered_at: null, estimated_delivery_at: daysAgo(-2) }),
      ship,
      NOW,
    );
    expect(e).toMatchObject({ state: 'in_transit', basis: 'carrier_estimate', days_until: 2 });
  });
  it('falls back to the policy range in business days from the ship date', () => {
    // shipped Friday 2026-10-16 → +3bd = Wed 10-21, +5bd = Fri 10-23
    const e = calculateDeliveryEstimate(
      order({ status: 'shipped', delivered_at: null, shipped_at: '2026-10-16T09:00:00Z' }),
      ship,
      NOW,
    );
    expect(e).toMatchObject({
      state: 'in_transit',
      basis: 'policy_range',
      earliest: '2026-10-21',
      latest: '2026-10-23',
    });
  });
  it('processing orders get a range after dispatch', () => {
    const e = calculateDeliveryEstimate(
      order({ status: 'processing', delivered_at: null, shipped_at: null }),
      ship,
      NOW,
    );
    expect(e).toMatchObject({ state: 'not_shipped', policy_business_days: [3, 5] });
  });
  it('delivered and cancelled states', () => {
    expect(calculateDeliveryEstimate(order(), ship, NOW)).toMatchObject({
      state: 'delivered',
      days_ago: 3,
    });
    expect(calculateDeliveryEstimate(order({ status: 'cancelled' }), ship, NOW)).toEqual({
      state: 'cancelled',
    });
  });
  it('is explicit when nothing is known', () => {
    const e = calculateDeliveryEstimate(
      order({ status: 'in_transit', delivered_at: null, shipped_at: null }),
      undefined,
      NOW,
    );
    expect(e).toMatchObject({ state: 'in_transit', basis: 'unknown' });
  });
});
