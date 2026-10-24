import { describe, expect, it } from 'vitest';
import type { Eligibility } from '@cx/shared';
import { emptyCaseState, type CaseState } from '../case-state.js';
import {
  decideNextAction,
  effectiveIntent,
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
const elig = (kind: Eligibility['kind'], outcome: Eligibility['outcome']): Eligibility => ({
  kind,
  outcome,
  reason: '',
  details: {},
});

const confirmedReturn = st({
  issue_type: 'return',
  confirmed_facts: ['item_unused', 'original_packaging', 'customer_ordered_wrong_item'],
  desired_resolution: 'return_and_refund',
  resolution_confirmed: true,
});

describe('ambiguity: a reported mismatch is not a return request', () => {
  const mismatch = st({ issue_type: 'mismatch', confirmed_facts: ['item_differs_from_listing'] });

  it('demotes a return/refund intent the customer has not actually asked for', () => {
    expect(effectiveIntent('return_request', mismatch, false)).toBe('complaint');
    expect(effectiveIntent('refund_request', mismatch, false)).toBe('complaint');
  });

  it('runs no eligibility checks and asks what happened', () => {
    const d = decideNextAction(input({ intent: 'return_request', state: mismatch }));
    expect(d.effectiveIntent).toBe('complaint');
    expect(d.eligibilityKinds).toEqual([]);
    expect(d.nextAction).toBe('clarify_request');
    expect(d.workflowStage).toBe('gathering_information');
    expect(d.missingInformation).toContain('issue_cause');
  });

  it('an unclear follow-up continues the open mismatch case', () => {
    expect(effectiveIntent('unclear', mismatch, false)).toBe('complaint');
  });

  it('once the customer names the resolution, ordinary eligibility applies again', () => {
    const asked = st({ issue_type: 'mismatch', desired_resolution: 'return' });
    const d = decideNextAction(input({ intent: 'return_request', state: asked }));
    expect(d.eligibilityKinds).toEqual(['return']);
    expect(d.nextAction).not.toBe('clarify_request');
  });

  it('a customer who corrects themselves (ordered the wrong item) leaves the ambiguous state', () => {
    const corrected = st({
      issue_type: 'return',
      confirmed_facts: ['customer_ordered_wrong_item'],
    });
    expect(effectiveIntent('unclear', corrected, false)).toBe('return_request');
  });
});

describe('follow_up_pending: progress instead of repeating', () => {
  const given = { nextStepAlreadyGiven: true };

  it('asking "what is next" again after the step was given moves to the pending follow-up', () => {
    const d = decideNextAction(
      input({ intent: 'unclear', asksNextStep: true, state: confirmedReturn, ...given }),
    );
    expect(d.nextAction).toBe('follow_up_pending');
    expect(d.workflowStage).toBe('ready_to_resolve');
  });

  it('so does repeating the same message', () => {
    const d = decideNextAction(
      input({ intent: 'return_request', state: confirmedReturn, customerRepeated: true, ...given }),
    );
    expect(d.nextAction).toBe('follow_up_pending');
  });

  it('a NEW question after the step was given is answered, not treated as a follow-up', () => {
    const d = decideNextAction(
      input({ intent: 'refund_request', state: confirmedReturn, ...given }),
    );
    expect(d.nextAction).toBe('explain_eligibility');
  });

  it('the first time the step is needed it is still provided', () => {
    const d = decideNextAction(
      input({
        intent: 'unclear',
        asksNextStep: true,
        state: confirmedReturn,
        nextStepAlreadyGiven: false,
      }),
    );
    expect(d.nextAction).toBe('provide_next_step');
  });

  it('ineligibility and review still override a pending follow-up', () => {
    const prelim = decideNextAction(
      input({ intent: 'unclear', asksNextStep: true, state: confirmedReturn, ...given }),
    );
    expect(finalizeNextAction(prelim, [elig('return', 'ineligible')]).next_action).toBe(
      'explain_eligibility',
    );
    expect(finalizeNextAction(prelim, [elig('return', 'needs_review')]).next_action).toBe(
      'handoff_to_human',
    );
  });
});
