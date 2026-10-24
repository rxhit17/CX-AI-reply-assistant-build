import { describe, expect, it } from 'vitest';
import { casePassed, detectReplyLanguage, evaluate, type Observation } from './checks.js';

const obs = (over: Partial<Observation> = {}): Observation => ({
  reply:
    'Hi Maya!\n\nUnfortunately the 7 days refund window has passed.\n\nHappy growing, The Bloom Team',
  intent: 'refund_request',
  eligibility: [{ kind: 'refund', outcome: 'ineligible', reason: '', details: {} }],
  escalate: false,
  guardrails: [{ check: 'grounded_figures', passed: true, severity: 'info' }],
  fallbackUsed: false,
  injectionSuspected: false,
  sourceBrandIds: ['b1'],
  expectedBrandId: 'b1',
  brandSignOff: 'Happy growing, The Bloom Team',
  otherBrandNames: ['Nordic Living'],
  failed: false,
  ...over,
});

describe('detectReplyLanguage', () => {
  it('detects the supported languages', () => {
    expect(detectReplyLanguage('Your order is on its way and will arrive soon.')).toBe('en');
    expect(
      detectReplyLanguage('Tu pedido está en camino y llegará pronto, gracias por esperar.'),
    ).toBe('es');
    expect(
      detectReplyLanguage(
        'Aapka order abhi processing mein hai, isliye aap ise cancel kar sakte hain.',
      ),
    ).toBe('hinglish');
  });
  it('plain English is not mistaken for Hinglish', () => {
    expect(
      detectReplyLanguage('Thank you. We will contact you with the next steps for your order.'),
    ).toBe('en');
  });
});

describe('evaluate', () => {
  it('passes a correct draft', () => {
    const r = evaluate(
      {
        intent: ['refund_request'],
        eligibility: { kind: 'refund', outcome: ['ineligible'] },
        greeting: true,
        language: 'en',
      },
      obs(),
    );
    expect(casePassed(r)).toBe(true);
  });
  it('fails on wrong eligibility, wrong intent and a repeated greeting', () => {
    const r = evaluate(
      {
        intent: ['return_request'],
        eligibility: { kind: 'refund', outcome: ['eligible'] },
        greeting: false,
      },
      obs(),
    );
    expect(
      r
        .filter((x) => !x.passed)
        .map((x) => x.metric)
        .sort(),
    ).toEqual(['eligibility', 'intent', 'style']);
  });
  it('flags other-brand leakage and a missing sign-off', () => {
    const r = evaluate({}, obs({ reply: 'Nordic Living allows 30 days.' }));
    expect(r.filter((x) => !x.passed).map((x) => x.name)).toEqual(
      expect.arrayContaining(['no_other_brand_in_reply', 'brand_sign_off']),
    );
  });
  it('fails guardrail-backed checks', () => {
    const r = evaluate(
      {},
      obs({
        guardrails: [{ check: 'no_unsupported_promises', passed: false, severity: 'blocking' }],
      }),
    );
    expect(r.find((x) => x.name === 'no_unsupported_promises')?.passed).toBe(false);
  });
  it('treats the safe fallback as a failure unless allowed', () => {
    expect(casePassed(evaluate({}, obs({ fallbackUsed: true })))).toBe(false);
    expect(
      evaluate({ fallbackOk: true }, obs({ fallbackUsed: true })).find(
        (x) => x.name === 'no_fallback',
      ),
    ).toBeUndefined();
  });
  it('checks formal voice and figure-free replies', () => {
    const r = evaluate(
      { voice: 'formal', noFigures: true },
      obs({ reply: "We can't do that 😊 within 7 days.\n\nHappy growing, The Bloom Team" }),
    );
    expect(r.filter((x) => !x.passed).map((x) => x.name)).toEqual(
      expect.arrayContaining(['formal_no_emoji', 'formal_no_contractions', 'no_invented_figures']),
    );
  });
  it('a failed run short-circuits', () => {
    const r = evaluate({ intent: ['x'] }, obs({ failed: true }));
    expect(r).toHaveLength(1);
    expect(casePassed(r)).toBe(false);
  });
});
