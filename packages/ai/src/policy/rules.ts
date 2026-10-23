/**
 * Deterministic business rules. No LLM is ever asked to decide eligibility, windows, thresholds or dates.
 * All functions are pure: the caller supplies `now`.
 */
import type { Eligibility, PolicyConditions } from '@cx/shared';
import { addBusinessDays, addDays, daysBetween } from './dates.js';

export interface OrderFacts {
  order_number: string;
  status: 'processing' | 'shipped' | 'in_transit' | 'delivered' | 'cancelled';
  total: number;
  currency: string;
  placed_at: string;
  shipped_at: string | null;
  delivered_at: string | null;
  estimated_delivery_at: string | null;
  items: { name: string; quantity: number; unit_price: number }[];
}

/** A policy entry reduced to what the rules need; `kbId`/`version` let callers cite it as a source. */
export interface PolicyRef {
  kbId: string;
  version: number;
  title: string;
  category: string;
  conditions: PolicyConditions | null;
}

export type DeliveryEstimate =
  | { state: 'delivered'; delivered_on: string; days_ago: number }
  | {
      state: 'in_transit';
      expected_on: string | null;
      earliest: string | null;
      latest: string | null;
      days_until: number | null;
      basis: 'carrier_estimate' | 'policy_range' | 'unknown';
    }
  | {
      state: 'not_shipped';
      earliest_after_dispatch: string | null;
      latest_after_dispatch: string | null;
      policy_business_days: [number, number] | null;
    }
  | { state: 'cancelled' };

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function anchorDate(order: OrderFacts, anchor: 'delivery' | 'order'): Date | null {
  const raw = anchor === 'order' ? order.placed_at : order.delivered_at;
  return raw ? new Date(raw) : null;
}

function windowCheck(
  kind: Eligibility['kind'],
  noun: string,
  order: OrderFacts,
  conditions: PolicyConditions | null | undefined,
  now: Date,
): Eligibility {
  const windowDays = conditions?.window_days;
  if (!windowDays) {
    return {
      kind,
      outcome: 'insufficient_data',
      reason: `No structured ${noun} window is defined for this brand`,
      details: {},
    };
  }
  if (order.status === 'cancelled') {
    return {
      kind,
      outcome: 'ineligible',
      reason: 'The order was cancelled',
      details: { window_days: windowDays },
    };
  }
  const anchor = conditions?.window_anchor ?? 'delivery';
  const start = anchorDate(order, anchor);
  if (!start) {
    return {
      kind,
      outcome: 'insufficient_data',
      reason: `The order has not been delivered yet, so the ${noun} window has not started`,
      details: { window_days: windowDays, order_status: order.status },
    };
  }
  const elapsed = daysBetween(start, now);
  const deadline = addDays(start, windowDays);
  const details = {
    window_days: windowDays,
    days_since_anchor: elapsed,
    anchor_date: isoDate(start),
    deadline: isoDate(deadline),
    discretionary_review_possible: Boolean(conditions?.discretionary_review),
  };
  if (elapsed <= windowDays) {
    return {
      kind,
      outcome: 'eligible',
      reason: `Within the ${windowDays}-day ${noun} window (day ${elapsed}; window ends ${isoDate(deadline)})`,
      details: { ...details, days_remaining: windowDays - elapsed },
    };
  }
  return {
    kind,
    outcome: 'ineligible',
    reason: `Outside the ${windowDays}-day ${noun} window (${elapsed} days since ${anchor === 'order' ? 'order' : 'delivery'}; window ended ${isoDate(deadline)})`,
    details,
  };
}

export function checkReturnEligibility(
  order: OrderFacts,
  policy: PolicyRef | undefined,
  now: Date,
): Eligibility {
  return windowCheck('return', 'return', order, policy?.conditions, now);
}

export function checkRefundEligibility(
  order: OrderFacts,
  policy: PolicyRef | undefined,
  now: Date,
): Eligibility {
  return windowCheck('refund', 'refund', order, policy?.conditions, now);
}

export interface DamageEvidence {
  /** At least one image attachment from the customer exists in the conversation. */
  hasPhoto: boolean;
  /** Vision result when available. */
  visibleDamage?: 'yes' | 'possible' | 'no' | 'unclear' | null;
}

/** Damage reports are time-boxed in hours from delivery and usually require photographic evidence. */
export function checkDamageEligibility(
  order: OrderFacts,
  policy: PolicyRef | undefined,
  evidence: DamageEvidence,
  now: Date,
): Eligibility {
  const reportDays = policy?.conditions?.report_within_days;
  if (!reportDays) {
    return {
      kind: 'damage',
      outcome: 'insufficient_data',
      reason: 'No structured damage-reporting window is defined for this brand',
      details: {},
    };
  }
  if (!order.delivered_at) {
    return {
      kind: 'damage',
      outcome: 'insufficient_data',
      reason: 'The order has not been delivered yet',
      details: { order_status: order.status },
    };
  }
  const hours = (now.getTime() - new Date(order.delivered_at).getTime()) / 3_600_000;
  const limitHours = reportDays * 24;
  const requiresPhoto = Boolean(policy?.conditions?.requires_photo);
  const details = {
    report_within_hours: limitHours,
    hours_since_delivery: Math.floor(hours),
    requires_photo: requiresPhoto,
    photo_received: evidence.hasPhoto,
    visible_damage: evidence.visibleDamage ?? null,
    discretionary_review_possible: Boolean(policy?.conditions?.discretionary_review),
  };
  if (hours > limitHours) {
    return {
      kind: 'damage',
      outcome: 'ineligible',
      reason: `Reported ${Math.floor(hours)}h after delivery; the policy requires reports within ${limitHours}h`,
      details,
    };
  }
  if (requiresPhoto && !evidence.hasPhoto) {
    return {
      kind: 'damage',
      outcome: 'insufficient_data',
      reason:
        'Within the reporting window, but the policy requires a photo of the damage and none has been received',
      details: { ...details, missing_evidence: 'photo' },
    };
  }
  if (evidence.visibleDamage === 'no') {
    return {
      kind: 'damage',
      outcome: 'needs_review',
      reason:
        'A photo was received but automated review did not see clear damage; a person must check it',
      details,
    };
  }
  return {
    kind: 'damage',
    outcome: 'eligible',
    reason:
      'Within the reporting window with the required evidence; subject to verification by the team',
    details,
  };
}

/** Free shipping applies when the order total is strictly above the threshold ("over $50"). */
export function calculateShippingEligibility(
  total: number,
  policy: PolicyRef | undefined,
): Eligibility {
  const threshold = policy?.conditions?.free_shipping_threshold;
  if (threshold === undefined) {
    return {
      kind: 'shipping',
      outcome: 'insufficient_data',
      reason: 'No free-shipping threshold is defined for this brand',
      details: {},
    };
  }
  const free = total > threshold;
  return {
    kind: 'shipping',
    outcome: free ? 'eligible' : 'ineligible',
    reason: free
      ? `Order total ${total.toFixed(2)} is above the free-shipping threshold of ${threshold}`
      : `Order total ${total.toFixed(2)} does not exceed the free-shipping threshold of ${threshold}`,
    details: {
      order_total: total,
      free_shipping_threshold: threshold,
      amount_to_free_shipping: free ? 0 : Math.round((threshold - total) * 100) / 100 + 0.01,
    },
  };
}

export function checkCancellationEligibility(
  order: OrderFacts,
  policy: PolicyRef | undefined,
): Eligibility {
  const until = policy?.conditions?.cancellable_until;
  if (!until) {
    return {
      kind: 'cancellation',
      outcome: 'insufficient_data',
      reason: 'No structured cancellation rule is defined for this brand',
      details: {},
    };
  }
  const base = { cancellable_until: until, order_status: order.status };
  switch (order.status) {
    case 'cancelled':
      return {
        kind: 'cancellation',
        outcome: 'ineligible',
        reason: 'The order is already cancelled',
        details: base,
      };
    case 'processing':
      return {
        kind: 'cancellation',
        outcome: 'eligible',
        reason: 'The order has not shipped yet',
        details: base,
      };
    case 'shipped':
      return until === 'shipped'
        ? {
            kind: 'cancellation',
            outcome: 'eligible',
            reason: 'Shipped but not yet with the carrier; this brand still allows cancellation',
            details: base,
          }
        : {
            kind: 'cancellation',
            outcome: 'ineligible',
            reason: 'The order has already shipped and can no longer be cancelled',
            details: base,
          };
    case 'in_transit':
      return {
        kind: 'cancellation',
        outcome: 'ineligible',
        reason: 'The order is in transit and can no longer be cancelled',
        details: base,
      };
    case 'delivered':
      return {
        kind: 'cancellation',
        outcome: 'ineligible',
        reason: 'The order was already delivered; a return may be possible instead',
        details: base,
      };
  }
}

export function calculateDeliveryEstimate(
  order: OrderFacts,
  shippingPolicy: PolicyRef | undefined,
  now: Date,
  holidays: string[] = [],
): DeliveryEstimate {
  if (order.status === 'cancelled') return { state: 'cancelled' };
  if (order.status === 'delivered' && order.delivered_at) {
    return {
      state: 'delivered',
      delivered_on: isoDate(new Date(order.delivered_at)),
      days_ago: daysBetween(new Date(order.delivered_at), now),
    };
  }
  const range = shippingPolicy?.conditions?.delivery_business_days ?? null;
  if (order.status === 'processing') {
    return {
      state: 'not_shipped',
      earliest_after_dispatch: range ? isoDate(addBusinessDays(now, range[0], holidays)) : null,
      latest_after_dispatch: range ? isoDate(addBusinessDays(now, range[1], holidays)) : null,
      policy_business_days: range,
    };
  }
  // shipped / in_transit
  if (order.estimated_delivery_at) {
    const eta = new Date(order.estimated_delivery_at);
    return {
      state: 'in_transit',
      expected_on: isoDate(eta),
      earliest: null,
      latest: null,
      days_until: daysBetween(now, eta),
      basis: 'carrier_estimate',
    };
  }
  if (order.shipped_at && range) {
    const shipped = new Date(order.shipped_at);
    const earliest = addBusinessDays(shipped, range[0], holidays);
    const latest = addBusinessDays(shipped, range[1], holidays);
    return {
      state: 'in_transit',
      expected_on: null,
      earliest: isoDate(earliest),
      latest: isoDate(latest),
      days_until: daysBetween(now, latest),
      basis: 'policy_range',
    };
  }
  return {
    state: 'in_transit',
    expected_on: null,
    earliest: null,
    latest: null,
    days_until: null,
    basis: 'unknown',
  };
}
