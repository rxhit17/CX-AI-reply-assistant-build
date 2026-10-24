import { describe, expect, it } from 'vitest';
import { knowledgeBase } from '../../../../supabase/seed/data.js';
import type { PolicyFigures } from '../llm/types.js';
import { deriveConditions, numbersIn } from './derive-conditions.js';

describe('deriveConditions: reads the eligibility figures out of the policy wording', () => {
  it.each(knowledgeBase.filter((k) => k.conditions))(
    'reproduces the seeded figures for $key from its text alone',
    (kb) => {
      const { conditions, warnings } = deriveConditions(kb.category, kb.content, null);
      expect(conditions).toEqual(kb.conditions);
      expect(warnings).toEqual([]);
    },
  );

  const bloomRefund = knowledgeBase.find((k) => k.key === 'bloom-refund')!;

  it('a reworded window changes window_days and reports it', () => {
    const text = bloomRefund.content.replaceAll('7 days', '30 days');
    const r = deriveConditions('refund_policy', text, bloomRefund.conditions);
    expect(r.conditions?.window_days).toBe(30);
    expect(r.changes.join(' ')).toMatch(/7 days → 30 days/);
  });

  it('an unchanged text changes nothing', () => {
    const r = deriveConditions('refund_policy', bloomRefund.content, bloomRefund.conditions);
    expect(r.changes).toEqual([]);
    expect(r.conditions).toEqual(bloomRefund.conditions);
  });

  it('a figure the text no longer states keeps its previous value and warns', () => {
    const r = deriveConditions(
      'refund_policy',
      'Refunds are available for eligible returns.',
      bloomRefund.conditions,
    );
    expect(r.conditions?.window_days).toBe(7);
    expect(r.warnings[0]).toMatch(/previous value/);
  });

  it('a yes/no flag that the text no longer states is switched off', () => {
    const text = bloomRefund.content.replace(/;[^.]*no refund can be promised in advance/, '');
    const r = deriveConditions('refund_policy', text, bloomRefund.conditions);
    expect(r.conditions?.discretionary_review).toBeUndefined();
  });

  it('hours are converted to days for the damage report window', () => {
    const r = deriveConditions(
      'damaged_products',
      'Report damage within 72 hours with a photo.',
      null,
    );
    expect(r.conditions).toEqual({ report_within_days: 3, requires_photo: true });
  });

  it('categories without structured figures are left untouched', () => {
    const existing = { window_days: 5 };
    expect(deriveConditions('faq', 'Plants arrive within 3 days.', existing).conditions).toBe(
      existing,
    );
  });
});

describe('numbersIn', () => {
  it('reads digits, number words, fortnights and weeks', () => {
    const n = numbersIn(
      'Within thirty days, or twenty-one days for sale items; a fortnight; 2 weeks; $49.95',
    );
    for (const v of [30, 21, 14, 49.95]) expect(n.has(v)).toBe(true);
  });
});

describe('model figures are verified against the text before they are used', () => {
  const none: PolicyFigures = {
    window_days: null,
    window_anchor: null,
    window_quote: null,
    report_within: null,
    report_unit: null,
    report_quote: null,
    free_shipping_threshold: null,
    threshold_quote: null,
    delivery_days_min: null,
    delivery_days_max: null,
    delivery_quote: null,
    cancellable_until: null,
    cancel_quote: null,
    requires_photo: false,
    discretionary_review: false,
  };
  const text =
    'You have a fortnight from the day your parcel arrives to ask for a refund. Late requests are looked at one by one.';

  it('accepts a figure that the text states, however it is phrased', () => {
    const r = deriveConditions('refund_policy', text, null, {
      ...none,
      window_days: 14,
      window_anchor: 'delivery',
      window_quote: 'a fortnight from the day your parcel arrives',
      discretionary_review: true,
    });
    expect(r.conditions).toEqual({
      window_days: 14,
      window_anchor: 'delivery',
      discretionary_review: true,
    });
  });

  it('rejects a figure whose number is not in the text (hallucination)', () => {
    const r = deriveConditions(
      'refund_policy',
      text,
      { window_days: 7, window_anchor: 'delivery' },
      {
        ...none,
        window_days: 45,
        window_quote: 'a fortnight from the day your parcel arrives',
      },
    );
    expect(r.conditions?.window_days).toBe(7); // 45 is rejected; nothing else states a window, so the old 7 is kept
    expect(r.warnings[0]).toMatch(/previous value/);
  });

  it('rejects a figure whose quoted evidence is not in the text', () => {
    const r = deriveConditions(
      'refund_policy',
      'Refunds are available for returns.',
      { window_days: 7 },
      {
        ...none,
        window_days: 30,
        window_quote: 'within 30 days of delivery',
      },
    );
    expect(r.conditions?.window_days).toBe(7);
    expect(r.warnings[0]).toMatch(/previous value/);
  });

  it('understands hours/weeks wording and flags', () => {
    const damaged =
      'Please tell us about any breakage no later than three days after it arrives and attach pictures.';
    const r = deriveConditions('damaged_products', damaged, null, {
      ...none,
      report_within: 3,
      report_unit: 'days',
      report_quote: 'no later than three days after it arrives',
      requires_photo: true,
    });
    expect(r.conditions).toEqual({ report_within_days: 3, requires_photo: true });
  });

  it('a model "no photo needed" beats the pattern reader that only sees the word photo', () => {
    const r = deriveConditions(
      'damaged_products',
      'Report damage within 7 days. No photo is needed.',
      { requires_photo: true },
      {
        ...none,
        report_within: 7,
        report_unit: 'days',
        report_quote: 'within 7 days',
        requires_photo: false,
      },
    );
    expect(r.conditions).toEqual({ report_within_days: 7 });
  });

  it('shipping and cancellation wording in other phrasings', () => {
    const ship =
      'Orders above $75 get free postage. Parcels normally arrive in 2 to 4 business days.';
    expect(
      deriveConditions('shipping_policy', ship, null, {
        ...none,
        free_shipping_threshold: 75,
        threshold_quote: 'Orders above $75 get free postage',
        delivery_days_min: 2,
        delivery_days_max: 4,
        delivery_quote: '2 to 4 business days',
      }).conditions,
    ).toEqual({ free_shipping_threshold: 75, delivery_business_days: [2, 4] });
    expect(
      deriveConditions(
        'cancellation_policy',
        'You can cancel until the courier has collected the parcel (status Shipped).',
        null,
        {
          ...none,
          cancellable_until: 'shipped',
          cancel_quote: 'until the courier has collected the parcel (status Shipped)',
        },
      ).conditions,
    ).toEqual({ cancellable_until: 'shipped' });
  });
});
