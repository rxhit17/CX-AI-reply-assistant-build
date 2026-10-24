import { describe, expect, it } from 'vitest';
import type { Eligibility } from '@cx/shared';
import { emptyCaseState, type CaseState } from '../case-state.js';
import {
  decideNextAction,
  effectiveIntent,
  eligibilityKindsForCase,
  finalizeNextAction,
  type DecisionInput,
} from './next-action.js';

const st = (over: Partial<CaseState> = {}): CaseState => ({ ...emptyCaseState(), ...over });
const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  intent: 'return_request',
  asksForHuman: false,
  asksNextStep: false,
  state: st(),
  customerSentImage: false,
  orderLinked: true,
  ...over,
});
const elig = (
  kind: Eligibility['kind'],
  outcome: Eligibility['outcome'],
  details: Eligibility['details'] = {},
): Eligibility => ({ kind, outcome, reason: '', details });

const confirmedReturn = st({
  issue_type: 'return',
  confirmed_facts: ['item_unused', 'original_packaging', 'customer_ordered_wrong_item'],
  desired_resolution: 'return_and_refund',
  resolution_confirmed: true,
});

describe('effectiveIntent', () => {
  it('continues an open case when the latest message has no intent of its own', () => {
    expect(effectiveIntent('unclear', confirmedReturn, true)).toBe('return_request');
    expect(effectiveIntent('general_question', confirmedReturn, false)).toBe('return_request');
  });
  it('leaves a clear new intent alone', () => {
    expect(effectiveIntent('cancellation', confirmedReturn, false)).toBe('cancellation');
  });
  it('does not invent a case where none exists', () => {
    expect(effectiveIntent('unclear', emptyCaseState(), false)).toBe('unclear');
  });
  it('a plain greeting stays a greeting unless it continues the case', () => {
    expect(effectiveIntent('greeting', confirmedReturn, false)).toBe('greeting');
    expect(effectiveIntent('greeting', confirmedReturn, true)).toBe('return_request');
  });
});

describe('eligibilityKindsForCase', () => {
  it('combines what the message asks with what the customer wants', () => {
    expect(eligibilityKindsForCase('return_request', confirmedReturn)).toEqual([
      'return',
      'refund',
    ]);
    expect(eligibilityKindsForCase('refund_request', st({ desired_resolution: 'return' }))).toEqual(
      ['refund', 'return'],
    );
  });
  it('adds nothing for unrelated intents', () => {
    expect(eligibilityKindsForCase('shipping_question', confirmedReturn)).toEqual(['shipping']);
  });
});

describe('decideNextAction', () => {
  it('"I already confirmed. What is the next step?" moves the case forward, not back to clarification', () => {
    const d = decideNextAction(
      input({ intent: 'unclear', asksNextStep: true, state: confirmedReturn }),
    );
    expect(d.route).toBe('policy');
    expect(d.effectiveIntent).toBe('return_request');
    expect(d.nextAction).toBe('provide_next_step');
    expect(d.workflowStage).toBe('ready_to_resolve');
    expect(d.eligibilityKinds).toEqual(['return', 'refund']);
    expect(d.missingInformation).toEqual([]);
  });
  it('explains eligibility for a question that is not yet a confirmed request', () => {
    const d = decideNextAction(
      input({
        state: st({
          issue_type: 'return',
          desired_resolution: 'return',
          resolution_confirmed: false,
        }),
      }),
    );
    expect(d.nextAction).toBe('explain_eligibility');
  });
  it('asks for the order only when none is linked', () => {
    const d = decideNextAction(input({ orderLinked: false, state: confirmedReturn }));
    expect(d.nextAction).toBe('ask_missing_info');
    expect(d.missingInformation).toEqual(['order_reference']);
    expect(
      decideNextAction(input({ orderLinked: true, state: confirmedReturn })).missingInformation,
    ).toEqual([]);
  });
  it('asks for a photo for a damage report only when none exists', () => {
    const base = input({ intent: 'damaged_product' });
    expect(decideNextAction(base).missingInformation).toContain('photo');
    expect(decideNextAction({ ...base, customerSentImage: true }).missingInformation).not.toContain(
      'photo',
    );
  });
  it('routes people, small talk, order status and unclear messages appropriately', () => {
    expect(decideNextAction(input({ intent: 'human_agent_request' })).nextAction).toBe(
      'handoff_to_human',
    );
    expect(decideNextAction(input({ intent: 'greeting' })).nextAction).toBe('acknowledge');
    expect(decideNextAction(input({ intent: 'order_status' })).nextAction).toBe(
      'order_status_update',
    );
    expect(decideNextAction(input({ intent: 'unclear', state: emptyCaseState() })).nextAction).toBe(
      'clarify_request',
    );
  });
  it('without a confirmed decision it explains policy', () => {
    expect(decideNextAction(input({ intent: 'general_question' })).nextAction).toBe(
      'explain_policy',
    );
  });
});

describe('finalizeNextAction', () => {
  const prelim = decideNextAction(
    input({ intent: 'unclear', asksNextStep: true, state: confirmedReturn }),
  );
  it('keeps provide_next_step when eligible', () => {
    const d = finalizeNextAction(prelim, [elig('return', 'eligible'), elig('refund', 'eligible')]);
    expect(d).toMatchObject({
      next_action: 'provide_next_step',
      eligibility_status: 'eligible',
      workflow_stage: 'ready_to_resolve',
    });
  });
  it('explains ineligibility instead of giving next steps', () => {
    const d = finalizeNextAction(prelim, [
      elig('return', 'ineligible'),
      elig('refund', 'eligible'),
    ]);
    expect(d).toMatchObject({
      next_action: 'explain_eligibility',
      eligibility_status: 'ineligible',
    });
  });
  it('hands over when a person must review', () => {
    expect(finalizeNextAction(prelim, [elig('return', 'needs_review')]).next_action).toBe(
      'handoff_to_human',
    );
  });
  it('asks for the photo when evidence is missing', () => {
    const d = finalizeNextAction(prelim, [
      elig('damage', 'insufficient_data', { missing_evidence: 'photo' }),
    ]);
    expect(d.next_action).toBe('ask_missing_info');
    expect(d.missing_information).toContain('photo');
  });
});
