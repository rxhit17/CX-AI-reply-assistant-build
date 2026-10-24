import { describe, expect, it } from 'vitest';
import { knowledgeBase } from '../../../../supabase/seed/data.js';
import { deriveConditions } from './derive-conditions.js';

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
