import { describe, expect, it } from 'vitest';
import type { Eligibility } from '@cx/shared';
import {
  hasBlockingFailure,
  statedFigures,
  validateDraft,
  type GuardrailInput,
} from './guardrails.js';

const SRC = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Refund Policy',
  content: 'Refunds are available within 7 days of delivery.',
};
const eligible = (kind: Eligibility['kind']): Eligibility => ({
  kind,
  outcome: 'eligible',
  reason: '',
  details: {},
});
const base = (over: Partial<GuardrailInput> = {}): GuardrailInput => ({
  reply: 'Thanks for getting in touch.',
  citedIds: [SRC.id],
  sources: [SRC],
  eligibility: [],
  order: null,
  otherBrandNames: [],
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

describe('eligibility claims must be verified, specific and requested', () => {
  it('a return claim needs a RETURN check (or a damage check); a refund claim needs a REFUND check', () => {
    expect(
      failing(base({ eligibility: [eligible('return')], reply: 'You are eligible for a refund.' })),
    ).toContain('eligibility_claim_supported');
    expect(
      failing(base({ eligibility: [eligible('refund')], reply: 'You are eligible to return it.' })),
    ).toContain('eligibility_claim_supported');
    expect(
      failing(base({ eligibility: [eligible('refund')], reply: 'You are eligible for a refund.' })),
    ).not.toContain('eligibility_claim_supported');
    expect(
      failing(
        base({
          eligibility: [eligible('damage')],
          reply: 'You can be eligible for a refund or return.',
        }),
      ),
    ).not.toContain('eligibility_claim_supported');
  });

  it('negated statements are not claims', () => {
    expect(
      failing(base({ reply: 'Unfortunately you are not eligible for a refund.' })),
    ).not.toContain('eligibility_claim_supported');
  });

  it('eligibility may not be asserted while the customer has only reported a problem', () => {
    const open = { eligibility: [eligible('return')], eligibilityTopicOpen: false };
    expect(failing(base({ ...open, reply: 'You are eligible to return it.' }))).toContain(
      'no_unrequested_eligibility',
    );
    expect(
      failing(base({ ...open, reply: 'Your item is within the 30-day return window.' })),
    ).toContain('no_unrequested_eligibility');
    expect(
      failing(base({ ...open, reply: 'Could you tell me what happened with the table?' })),
    ).not.toContain('no_unrequested_eligibility');
    expect(
      failing(
        base({
          eligibility: [eligible('return')],
          eligibilityTopicOpen: true,
          reply: 'You are eligible to return it.',
        }),
      ),
    ).not.toContain('no_unrequested_eligibility');
  });
});

describe('repeated content', () => {
  const prev =
    'Your return is within the window, and our team will follow up with the instructions for it.';

  it('a repeat is blocked, unless the customer explicitly asked for clarification', () => {
    expect(failing(base({ lastAgentReply: prev, reply: prev }))).toContain('no_repeated_reply');
    expect(failing(base({ lastAgentReply: prev, reply: prev, allowRepeat: true }))).not.toContain(
      'no_repeated_reply',
    );
  });

  it('restating a figure agents already gave is a warning, never a block', () => {
    const r = validateDraft(
      base({
        previouslyStatedFigures: ['7 day'],
        reply: 'The refund period is 7 days after delivery.',
      }),
    );
    expect(r.find((x) => x.check === 'repeats_policy_facts')).toMatchObject({
      passed: false,
      severity: 'warning',
    });
    expect(hasBlockingFailure(r)).toBe(false);
    const allowed = validateDraft(
      base({
        previouslyStatedFigures: ['7 day'],
        allowRepeat: true,
        reply: 'The refund period is 7 days after delivery.',
      }),
    );
    expect(allowed.find((x) => x.check === 'repeats_policy_facts')).toBeUndefined();
  });

  it('normalises figures the same way across phrasings', () => {
    expect(
      statedFigures('Within 30 days, or the 30-day window, plus $12 shipping.').sort(),
    ).toEqual(['$12', '30 day']);
  });
});

describe('regression: honest decline of an ineligible refund is not an entitlement claim', () => {
  const ineligible: Eligibility = {
    kind: 'refund',
    outcome: 'ineligible',
    reason: '',
    details: { window_days: 7, days_since_anchor: 20, discretionary_review_possible: true },
  };
  it.each([
    "Hi Maya! I understand you're looking for a refund, but it looks like your request is outside our 7-day refund window, as it's been 20 days since delivery. However, our team can review exceptional cases.",
    'You are asking about a refund for order BB-10012. That is past the 7-day window, so I cannot confirm one.',
    'You can ask our team to look at it, but a refund cannot be promised.',
  ])('is not blocked: %s', (reply) => {
    const r = failing(
      base({
        eligibility: [ineligible],
        reply,
        sources: [
          {
            ...SRC,
            content:
              'Refunds are available within 7 days of delivery. Exceptional cases may be reviewed.',
          },
        ],
      }),
    );
    expect(r).not.toContain('eligibility_claim_supported');
    expect(r).not.toContain('no_unsupported_promises');
    expect(r).not.toContain('respects_ineligibility');
  });
  it('still blocks a real entitlement claim for an ineligible refund', () => {
    expect(
      failing(
        base({
          eligibility: [ineligible],
          reply: 'You are eligible for a refund of the full amount.',
        }),
      ),
    ).toEqual(expect.arrayContaining(['respects_ineligibility']));
    expect(
      failing(base({ eligibility: [ineligible], reply: 'You can get a refund for this order.' })),
    ).toContain('respects_ineligibility');
  });
});

describe('guarantees: asserting one is blocked, disclaiming one is honest', () => {
  it.each([
    'I guarantee this will be fixed.',
    'We guarantee a full refund.',
    'Your replacement is guaranteed.',
  ])('blocks: %s', (reply) => {
    expect(failing(base({ reply }))).toContain('no_guarantees');
  });
  it.each([
    'Our team may review your case, but this does not guarantee an outcome.',
    "I can't guarantee a refund, but I will pass your request to the team.",
    'There is no guarantee that an exception can be made.',
    'We cannot guarantee a replacement.',
  ])('allows the disclaimer: %s', (reply) => {
    expect(failing(base({ reply }))).not.toContain('no_guarantees');
  });
});

describe('contractions count as negation', () => {
  it('"you can\'t return" / "you aren\'t eligible" are not entitlement claims', () => {
    const e: Eligibility = { kind: 'return', outcome: 'ineligible', reason: '', details: {} };
    for (const reply of [
      "Unfortunately you can't return it any more.",
      "You aren't eligible to return this, I'm afraid.",
    ]) {
      expect(failing(base({ eligibility: [e], reply }))).not.toContain('respects_ineligibility');
      expect(failing(base({ eligibility: [e], reply }))).not.toContain(
        'eligibility_claim_supported',
      );
    }
  });
});
