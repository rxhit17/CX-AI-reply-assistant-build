import { describe, expect, it } from 'vitest';
import type { Eligibility } from '@cx/shared';
import {
  blockingMessages,
  hasBlockingFailure,
  validateDraft,
  type GuardrailInput,
} from './guardrails.js';

const SRC = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Bloom Refund Policy',
  content:
    'Refunds are available within 7 days of delivery. Orders over $50 ship free. Delivery takes 3-5 business days.',
};
const inelig: Eligibility = {
  kind: 'refund',
  outcome: 'ineligible',
  reason: 'outside window',
  details: { window_days: 7, days_since_anchor: 20, discretionary_review_possible: true },
};
const elig: Eligibility = {
  kind: 'refund',
  outcome: 'eligible',
  reason: 'inside window',
  details: { window_days: 7, days_since_anchor: 3, days_remaining: 4 },
};

const base = (over: Partial<GuardrailInput> = {}): GuardrailInput => ({
  reply: 'Thanks for getting in touch. The refund period is 7 days after delivery.',
  citedIds: [SRC.id],
  sources: [SRC],
  eligibility: [inelig],
  order: {
    order_number: 'BB-10012',
    status: 'delivered',
    total: 42,
    currency: 'USD',
    placed_at: '',
    shipped_at: null,
    delivered_at: '',
    estimated_delivery_at: null,
    items: [{ name: 'Planter', quantity: 2, unit_price: 21 }],
  },
  otherBrandNames: ['Nordic Living'],
  customerSentImage: false,
  priorAgentMessage: false,
  retrievalSufficient: true,
  policyRelevant: true,
  expectedLanguage: 'en',
  replyLanguage: 'en',
  ...over,
});
const failing = (i: GuardrailInput) =>
  validateDraft(i)
    .filter((r) => !r.passed)
    .map((r) => r.check);

describe('validateDraft', () => {
  it('passes a grounded, honest draft', () => {
    const r = validateDraft(base());
    expect(hasBlockingFailure(r)).toBe(false);
    expect(failing(base())).toEqual([]);
  });

  describe('citations', () => {
    it('rejects source ids the model was never given', () => {
      const r = base({ citedIds: ['99999999-9999-4999-8999-999999999999'] });
      expect(failing(r)).toContain('citations_exist');
      expect(hasBlockingFailure(validateDraft(r))).toBe(true);
    });
    it('warns when policy was available but nothing is cited', () => {
      const r = validateDraft(base({ citedIds: [] }));
      expect(r.find((x) => x.check === 'citations_present')?.severity).toBe('warning');
      expect(hasBlockingFailure(r)).toBe(false);
    });
  });

  describe('grounded figures', () => {
    it('blocks an invented return window', () => {
      expect(failing(base({ reply: 'You have 30 days to request a refund.' }))).toContain(
        'grounded_figures',
      );
    });
    it('blocks invented amounts but allows order totals and policy thresholds', () => {
      expect(failing(base({ reply: 'We will add a $15 handling fee.' }))).toContain(
        'grounded_figures',
      );
      expect(
        failing(base({ reply: 'Your order total was $42 and shipping is free over $50.' })),
      ).not.toContain('grounded_figures');
    });
    it('treats 48 hours and 2 days as the same window', () => {
      const e: Eligibility = {
        kind: 'damage',
        outcome: 'eligible',
        reason: '',
        details: { report_within_hours: 48 },
      };
      expect(
        failing(
          base({ eligibility: [e], reply: 'Damage must be reported within 2 days of delivery.' }),
        ),
      ).not.toContain('grounded_figures');
    });
    it('allows computed facts such as days since delivery', () => {
      expect(
        failing(
          base({ reply: 'Your order arrived 20 days ago, outside the 7 days refund period.' }),
        ),
      ).not.toContain('grounded_figures');
    });
    it('blocks any policy figure when no relevant policy was found', () => {
      const r = base({
        retrievalSufficient: false,
        sources: [],
        citedIds: [],
        eligibility: [],
        reply: 'Returns are accepted within 14 days.',
      });
      expect(failing(r)).toContain('no_policy_without_evidence');
    });
  });

  describe('promises and actions', () => {
    it.each([
      'We will refund you right away.',
      "You'll receive a full refund.",
      'I will refund the full amount to your card.',
    ])('blocks a refund promise when the customer is ineligible: %s', (reply) => {
      expect(failing(base({ reply }))).toContain('no_unsupported_promises');
    });
    it('only warns about a refund commitment when eligible', () => {
      const r = validateDraft(
        base({ eligibility: [elig], reply: "You'll receive a refund once we inspect the item." }),
      );
      expect(r.find((x) => x.check === 'no_unsupported_promises')?.severity).toBe('warning');
      expect(hasBlockingFailure(r)).toBe(false);
    });
    it.each([
      'I have refunded your order.',
      'Your refund has been processed.',
      "We've cancelled your order.",
      'Your replacement has been shipped.',
    ])('always blocks claims that an action was completed: %s', (reply) => {
      expect(failing(base({ eligibility: [elig], reply }))).toContain('no_completed_action_claims');
    });
    it('blocks entitlement claims when the rules say ineligible', () => {
      expect(failing(base({ reply: 'You are eligible for a refund on this order.' }))).toEqual(
        expect.arrayContaining(['no_unsupported_promises']),
      );
    });
    it('allows honestly saying the customer is NOT eligible', () => {
      expect(
        failing(
          base({
            reply:
              'Unfortunately you are not eligible for a refund because the 7 days period has passed.',
          }),
        ),
      ).toEqual([]);
    });
    it('blocks guarantees and invented discounts', () => {
      expect(failing(base({ reply: 'I guarantee this will be fixed.' }))).toContain(
        'no_guarantees',
      );
      expect(failing(base({ reply: 'Here is a 20% off coupon for next time.' }))).toContain(
        'no_invented_offers',
      );
    });
    it('allows a discount only if the policy itself mentions it', () => {
      const s = { ...SRC, content: SRC.content + ' First-time buyers get a 10% off coupon.' };
      expect(
        failing(base({ sources: [s], reply: 'You can use the 10% off coupon.' })),
      ).not.toContain('no_invented_offers');
    });
    it('honours the model’s own self-report as an extra signal', () => {
      expect(
        failing(
          base({
            reply: 'Muchas gracias, lo revisaremos.',
            selfReported: { promises_refund: true },
          }),
        ),
      ).toContain('no_unsupported_promises');
    });
  });

  describe('isolation and confidentiality', () => {
    it('blocks mentions of another brand', () => {
      expect(failing(base({ reply: 'Nordic Living offers 30 days instead.' }))).toContain(
        'no_cross_brand_leakage',
      );
    });
    it('blocks internal identifiers and system details', () => {
      expect(
        failing(base({ reply: 'Reference 11111111-1111-4111-8111-111111111111 applies.' })),
      ).toContain('no_internal_details');
      expect(failing(base({ reply: 'My system prompt says to help you.' }))).toContain(
        'no_internal_details',
      );
    });
    it('blocks a wrong order number', () => {
      expect(failing(base({ reply: 'About order BB-99999: the period is 7 days.' }))).toContain(
        'order_number_matches',
      );
      expect(failing(base({ reply: 'About order BB-10012: the period is 7 days.' }))).not.toContain(
        'order_number_matches',
      );
    });
  });

  describe('photos', () => {
    it('blocks claiming a photo was received when none exists', () => {
      expect(
        failing(base({ reply: 'Thanks for sending the photo, I can see the crack.' })),
      ).toContain('no_false_photo_claims');
    });
    it('blocks asking again for a photo that was already sent', () => {
      expect(
        failing(
          base({ customerSentImage: true, reply: 'Could you please send a photo of the damage?' }),
        ),
      ).toContain('no_redundant_photo_request');
    });
    it('allows asking for a photo when none exists, and acknowledging one that does', () => {
      expect(failing(base({ reply: 'Could you please send a photo of the damage?' }))).toEqual([]);
      expect(
        failing(
          base({
            customerSentImage: true,
            reply: 'Thanks for the photo, we have it and will review it.',
          }),
        ),
      ).toEqual([]);
    });
  });

  describe('conversation hygiene', () => {
    it('warns on a repeated greeting', () => {
      const r = validateDraft(
        base({ priorAgentMessage: true, reply: 'Hi there! The period is 7 days.' }),
      );
      expect(r.find((x) => x.check === 'no_repeated_greeting')?.severity).toBe('warning');
      expect(hasBlockingFailure(r)).toBe(false);
    });
    it('warns on a language mismatch', () => {
      expect(failing(base({ expectedLanguage: 'es', replyLanguage: 'en' }))).toContain(
        'reply_language',
      );
    });
  });

  it('blockingMessages lists only blocking failures', () => {
    const r = validateDraft(base({ reply: 'You have 30 days.', priorAgentMessage: true }));
    expect(blockingMessages(r).join(' ')).toMatch(/grounded_figures/);
  });
});

describe('delivery estimate figures', () => {
  it('allows quoting day counts from the verified delivery estimate', () => {
    const r = failing(
      base({
        eligibility: [],
        reply: 'Your order is expected in 2 days.',
        deliveryEstimate: {
          state: 'in_transit',
          expected_on: '2026-10-25',
          earliest: null,
          latest: null,
          days_until: 2,
          basis: 'carrier_estimate',
        },
      }),
    );
    expect(r).not.toContain('grounded_figures');
  });
  it('still blocks day counts that match nothing verified', () => {
    const r = failing(
      base({
        eligibility: [],
        reply: 'Your order is expected in 9 days.',
        deliveryEstimate: {
          state: 'in_transit',
          expected_on: '2026-10-25',
          earliest: null,
          latest: null,
          days_until: 2,
          basis: 'carrier_estimate',
        },
      }),
    );
    expect(r).toContain('grounded_figures');
  });
});

describe('internal source labels', () => {
  it.each([
    'Per our policy (S1), you have 7 days.',
    'The period is 7 days. (Source : S1)',
    'See (Fuente: S2).',
  ])('blocks: %s', (reply) => expect(failing(base({ reply }))).toContain('no_source_labels'));
  it('does not flag ordinary text', () => {
    expect(failing(base({ reply: 'Size S is available. The period is 7 days.' }))).not.toContain(
      'no_source_labels',
    );
  });
});

describe('conversation progress checks', () => {
  const answered = ['item_unused', 'original_packaging', 'resolution_confirmation'];

  it('blocks asking again about something the customer already answered (model self-report)', () => {
    const r = failing(
      base({
        answeredTopics: answered,
        selfReported: { questions_asked: ['resolution_confirmation'] },
        reply: 'Thanks for your patience. 7 days.',
      }),
    );
    expect(r).toContain('no_redundant_question');
  });
  it.each([
    'Please confirm that you want to return the item.',
    'Do you still want to return it?',
    'Is the item unused?',
    'Could you confirm it is in the original packaging?',
  ])('catches the re-ask in the text: %s', (reply) => {
    expect(failing(base({ answeredTopics: answered, reply }))).toContain('no_redundant_question');
  });
  it('allows the same question when the customer has not answered it yet', () => {
    expect(
      failing(
        base({
          answeredTopics: [],
          reply: 'Please confirm that you want to return the item. Is the item unused?',
        }),
      ),
    ).not.toContain('no_redundant_question');
  });
  it('does not block unrelated clarifying questions', () => {
    expect(
      failing(base({ answeredTopics: answered, reply: 'Which colour was the table you ordered?' })),
    ).not.toContain('no_redundant_question');
  });

  it('blocks a draft that repeats the previous agent reply', () => {
    const prev =
      'Thank you for confirming. Our team will follow up with the return instructions for your order.';
    expect(failing(base({ lastAgentReply: prev, reply: prev }))).toContain('no_repeated_reply');
    expect(
      failing(
        base({
          lastAgentReply: prev,
          reply: 'The period is 7 days after delivery, and your order is within it.',
        }),
      ),
    ).not.toContain('no_repeated_reply');
  });

  it('blocks procedures that the policy sources do not document, but allows documented ones', () => {
    expect(
      failing(base({ reply: 'Please print the return label and use the return portal.' })),
    ).toContain('no_invented_procedure');
    const documented = {
      ...SRC,
      content: SRC.content + ' We arrange a prepaid collection for defective items.',
    };
    expect(
      failing(base({ sources: [documented], reply: 'We can arrange a collection for you.' })),
    ).not.toContain('no_invented_procedure');
  });
});
