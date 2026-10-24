/**
 * Multi-turn regression tests for conversation intelligence. Each test drives SUCCESSIVE customer messages and
 * generations (the agent "sends" every draft), so state carries through the persisted case state and the message
 * history exactly as in production. The mock LLM keeps these tests deterministic: they verify workflow logic
 * (memory, routing, next action, guardrails, fallbacks). Real-model behaviour is measured by `pnpm eval:conversation`.
 */
import { describe, expect, it, vi } from 'vitest';
import { emptyCaseState } from '../case-state.js';
import { createMockLlm } from '../llm/mock.js';
import type { ComposedReply, ComposeInput, LlmPort } from '../llm/types.js';
import type { GenerationRecord } from '../ports.js';
import { runGeneration } from './build.js';
import type { GState } from './state.js';
import { emmaOrder, kb, makeHarness, msg, NOW, nordicPolicies, type Harness } from './testkit.js';

const NORDIC_ID = '00000000-0000-4000-8000-0000000000c2';
const NORDIC_RETURN_ID = '20000000-0000-4000-8000-000000000001';
const NORDIC_REFUND_ID = '20000000-0000-4000-8000-000000000002';
const returnHit = kb({
  id: NORDIC_RETURN_ID,
  title: 'Nordic Living return_policy',
  category: 'return_policy',
  content: nordicPolicies[0]!.content,
  vector_score: 0.7,
});
const refundHit = kb({
  id: NORDIC_REFUND_ID,
  title: 'Nordic Living refund_policy',
  category: 'refund_policy',
  content: nordicPolicies[1]!.content,
  vector_score: 0.55,
});

let counter = 0;
/** Customer writes; the assistant drafts; the agent sends the draft as-is. Returns the run state. */
async function turn(
  h: Harness,
  customerText: string,
  opts: { send?: boolean; images?: number } = {},
): Promise<GState> {
  h.ctx.messages.push(msg(`c${++counter}`, 'customer', customerText, opts.images ?? 0));
  const { state } = await runGeneration(h.deps, h.input);
  if (opts.send !== false && state.proposedResponse) {
    h.ctx.messages.push(msg(`a${++counter}`, 'agent', state.proposedResponse));
  }
  return state;
}

const emma = (extra: Partial<Parameters<typeof makeHarness>[0]> = {}) =>
  makeHarness({
    brand: 'nordic',
    messages: [],
    order: emmaOrder(),
    searchResults: [returnHit, refundHit],
    ...extra,
  });

/** An LLM whose compose step is replaced; everything else is the deterministic mock. */
const withCompose = (
  fn: (input: ComposeInput, base: ComposedReply, call: number) => Partial<ComposedReply>,
): { llm: LlmPort; calls: ComposeInput[] } => {
  const base = createMockLlm();
  const calls: ComposeInput[] = [];
  const llm: LlmPort = {
    ...base,
    compose: async (input) => {
      calls.push(input);
      const mock = (await base.compose(input)).value;
      return {
        value: { ...mock, cited_source_ids: [], ...fn(input, mock, calls.length) },
        usage: { input: 1, output: 1 },
        model: 'test',
      };
    },
  };
  return { llm, calls };
};

const ASKS_TO_CONFIRM =
  /confirm (that )?you (want|would like|wish)|would you like (me )?to proceed|do you (still )?want to return/i;

describe('Nordic Living: Emma, Oak Side Table (the reported failure)', () => {
  it('remembers what she said, never re-asks, and progresses instead of repeating', async () => {
    const h = emma();
    const s1 = await turn(
      h,
      "I purchased an Oak Side Table, but it doesn't look like what I ordered.",
    );
    expect(s1.caseState!.confirmed_facts).toContain('item_differs_from_listing');

    const s2 = await turn(h, 'I think I ordered the wrong product.');
    // correction: it is now a customer-side return, not a seller error
    expect(s2.caseState!.issue_type).toBe('return');
    expect(s2.caseState!.confirmed_facts).toContain('customer_ordered_wrong_item');
    expect(s2.caseState!.confirmed_facts).not.toContain('item_differs_from_listing');
    expect(s2.caseState!.corrections.join(' ')).toMatch(/ordered the wrong/);
    expect(s2.route).toBe('policy');
    expect(s2.eligibility[0]).toMatchObject({ kind: 'return', outcome: 'eligible' });

    const s3 = await turn(h, 'Yes, it is unused.');
    expect(s3.caseState!.confirmed_facts).toEqual(
      expect.arrayContaining(['item_unused', 'customer_ordered_wrong_item']),
    );
    const s4 = await turn(h, 'And it is in the original packaging.');
    expect(s4.caseState!.confirmed_facts).toEqual(
      expect.arrayContaining(['item_unused', 'original_packaging']),
    );

    const s5 = await turn(h, 'I want to return it and get a refund.');
    expect(s5.caseState).toMatchObject({
      desired_resolution: 'return_and_refund',
      resolution_confirmed: true,
    });
    expect(s5.derived!.next_action).toBe('provide_next_step');
    expect(s5.eligibility.map((e) => `${e.kind}:${e.outcome}`).sort()).toEqual([
      'refund:eligible',
      'return:eligible',
    ]);
    // reuses her facts (as hers, subject to inspection) and hands over because no procedure applies to this case
    expect(s5.proposedResponse).toMatch(/unused/i);
    expect(s5.proposedResponse).toMatch(/inspect/i);
    expect(s5.composed!.next_step_documented).toBe(false);
    expect(s5.escalate).toBe(true);
    expect(s5.escalationReason).toMatch(/No documented procedure/i);

    const s6 = await turn(h, 'I already confirmed. What is the next step?');
    expect(s6.caseState!.confirmed_facts).toEqual(
      expect.arrayContaining(['item_unused', 'original_packaging', 'customer_ordered_wrong_item']),
    );
    expect(s6.caseState).toMatchObject({
      desired_resolution: 'return_and_refund',
      resolution_confirmed: true,
    });
    expect(s6.understanding!.intent).toBe('unclear');
    expect(s6.effectiveIntent).toBe('return_request');
    // she has been told the next step and asks again: the answer MOVES FORWARD instead of repeating
    expect(s6.nextStepAlreadyGiven).toBe(true);
    expect(s6.derived).toMatchObject({
      next_action: 'follow_up_pending',
      workflow_stage: 'ready_to_resolve',
      eligibility_status: 'eligible',
    });
    expect(s6.orderFacts!.order_number).toBe('NL-20077');

    const reply = s6.proposedResponse!;
    expect(reply).not.toMatch(ASKS_TO_CONFIRM);
    expect(reply).not.toBe(s5.proposedResponse);
    expect(reply).toMatch(/following up|with our team/i);
    expect(reply).not.toMatch(/30|window|shipping/i); // no policy restated
    expect(s6.composed!.questions_asked).toEqual([]);
    expect(s6.escalate).toBe(true);
    expect(s6.escalationReason).toMatch(/still pending/i);
    expect(reply).not.toMatch(/return label|prepaid|rma|portal/i);
    expect(s6.guardrails.filter((g) => !g.passed && g.severity === 'blocking')).toEqual([]);
    expect(reply).not.toMatch(
      /we will refund|has been (refunded|processed)|you will receive a refund/i,
    );
    expect(h.saved[0]!.body).toContain('With kind regards, Nordic Living Customer Care');
    expect(reply).not.toContain('With kind regards');
    expect(s6.fallbackUsed).toBe(false);
  });

  it('persists the case state on every generation and reloads the one BEFORE the current message', async () => {
    const h = emma();
    await turn(h, 'I think I ordered the wrong product. Yes it is unused.');
    expect(h.saved[0]!.case_state).toMatchObject({
      issue_type: 'return',
      confirmed_facts: expect.arrayContaining(['item_unused']),
    });
    expect(h.saved[0]!.case_state!.derived).toBeDefined();
    const second = await turn(h, 'It is in the original packaging.');
    expect(second.previousCaseState).toEqual(h.saved[0]!.case_state);
    expect(second.caseState!.as_of_message_id).toBe(second.latest!.id);
  });

  it('keeps early facts even when the history window no longer contains them', async () => {
    const h = emma();
    await turn(
      h,
      'I think I ordered the wrong product, it is unused and in the original packaging. I want to return it and get a refund.',
    );
    h.ctx.messages.splice(
      0,
      h.ctx.messages.length,
      ...Array.from({ length: 60 }, (_, i) =>
        msg(`f${i}`, i % 2 ? 'agent' : 'customer', `chit chat ${i}`),
      ),
    );
    const s = await turn(h, 'What is the next step?');
    expect(s.caseState!.confirmed_facts).toEqual(
      expect.arrayContaining(['item_unused', 'original_packaging', 'customer_ordered_wrong_item']),
    );
    expect(s.caseState!.resolution_confirmed).toBe(true);
    expect(s.derived!.next_action).toBe('provide_next_step');
  });
});

describe('ambiguous first messages and unsupported eligibility claims', () => {
  const FIRST = "I purchased an Oak Side Table, but it doesn't look like what I ordered.";

  it('a mismatch report is NOT a return request: no eligibility, one clarifying question', async () => {
    const h = emma();
    const s = await turn(h, FIRST, { send: false });
    expect(s.caseState!.issue_type).toBe('mismatch');
    expect(s.caseState!.desired_resolution).toBe('unknown');
    expect(s.effectiveIntent).toBe('complaint');
    expect(s.eligibilityKinds).toEqual([]);
    expect(s.eligibility).toEqual([]);
    expect(s.derived).toMatchObject({
      next_action: 'clarify_request',
      workflow_stage: 'gathering_information',
    });
    expect(s.derived!.missing_information).toEqual(['issue_cause']);
    expect(s.proposedResponse).toMatch(/\?/);
    expect(s.proposedResponse).not.toMatch(/eligible|return window|refund|30|shipping/i);
    expect(s.composed!.questions_asked).toEqual(['other']);
  });

  it('even if the model asserts eligibility, the draft is blocked and retried with guidance', async () => {
    const { llm, calls } = withCompose((_i, mock, call) =>
      call === 1
        ? {
            reply_body:
              'You are eligible to return the Oak Side Table within the 30-day return window.',
          }
        : { reply_body: mock.reply_body },
    );
    const h = emma({ llm });
    const s = await turn(h, FIRST, { send: false });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.violationFeedback!.join(' ')).toMatch(/no_unrequested_eligibility/);
    expect(calls[1]!.violationFeedback!.join(' ')).toMatch(/Do not state or imply eligibility/);
    expect(s.proposedResponse).not.toMatch(/eligible/i);
    expect(s.fallbackUsed).toBe(false);
  });

  it('if the model keeps asserting it, nothing about eligibility reaches the agent', async () => {
    const { llm } = withCompose(() => ({
      reply_body: 'You are eligible to return it within the 30-day window.',
    }));
    const s = await turn(emma({ llm }), FIRST, { send: false });
    expect(s.fallbackUsed).toBe(true);
    expect(s.guardrails.find((g) => g.check === 'no_unrequested_eligibility')?.passed).toBe(false);
    expect(s.proposedResponse).not.toMatch(/eligible|30/i);
  });

  it('with no linked order eligibility is unverified and cannot be claimed', async () => {
    const { llm } = withCompose(() => ({
      reply_body: 'You are eligible for a refund and a return.',
    }));
    const h = emma({ order: null, llm });
    const s = await turn(h, 'I want to return it and get a refund.', { send: false });
    expect(s.eligibility.every((e) => e.outcome === 'insufficient_data')).toBe(true);
    expect(s.fallbackUsed).toBe(true);
    expect(s.proposedResponse).not.toMatch(/eligible/i);
  });

  it('a refund-eligibility claim needs a REFUND check, not just a return check', async () => {
    const { llm } = withCompose(() => ({
      reply_body: 'You are eligible for a refund of the table.',
    }));
    const h = emma({ llm });
    // customer only asks about returning: only the return check is run
    const s = await turn(h, 'Can I return the table?', { send: false });
    expect(s.eligibilityKinds).toEqual(['return']);
    expect(s.guardrails.find((g) => g.check === 'eligibility_claim_supported')?.passed).toBe(false);
  });

  it('after the customer says what happened, eligibility is computed and may be stated', async () => {
    const h = emma();
    await turn(h, FIRST);
    const s = await turn(h, 'I think I ordered the wrong product. Can I return it?');
    expect(s.caseState!.issue_type).toBe('return');
    expect(s.eligibility[0]).toMatchObject({ kind: 'return', outcome: 'eligible' });
    expect(s.guardrails.find((g) => g.check === 'no_unrequested_eligibility')).toBeUndefined();
  });

  it('a damage report still gets its damage check (exceptions for defective goods are preserved)', async () => {
    const h = makeHarness({
      messages: [],
      brand: 'nordic',
      order: emmaOrder({ delivered_at: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() }),
      policies: [
        ...nordicPolicies,
        {
          kbId: '20000000-0000-4000-8000-000000000003',
          version: 1,
          title: 'Nordic Living damaged_products',
          category: 'damaged_products',
          conditions: { report_within_days: 14, requires_photo: true },
          content: 'Damage must be reported within 14 days with photographs.',
        },
      ],
    });
    const s = await turn(h, 'The table arrived damaged, it is cracked.', { send: false });
    expect(s.eligibilityKinds).toContain('damage');
    expect(s.derived!.missing_information).toContain('photo');
  });
});

describe('missing and linked orders', () => {
  it('asks for the order only when none is linked, and never again once it is', async () => {
    const h = emma({ order: null });
    const s1 = await turn(h, 'I want to return it and get a refund.');
    expect(s1.derived!.next_action).toBe('ask_missing_info');
    expect(s1.derived!.missing_information).toEqual(['order_reference']);
    expect(s1.proposedResponse).toMatch(/order number/i);
    expect(s1.composed!.questions_asked).toContain('order_reference');
    const s2 = await turn(emma(), 'I want to return it and get a refund.');
    expect(s2.derived!.missing_information).toEqual([]);
    expect(s2.proposedResponse).not.toMatch(/order number/i);
  });
});

describe('repetition: progress instead of echoes, and useful fallbacks', () => {
  /** Always answers with exactly the previous agent reply (the failure observed with the real model). */
  const echo = () => withCompose((input) => ({ reply_body: input.lastAgentReply ?? 'Thank you.' }));

  const confirmedTurns = async (h: Harness) => {
    await turn(
      h,
      'I think I ordered the wrong product. It is unused and in the original packaging. I want to return it and get a refund.',
    );
  };

  it('a repeated draft is blocked and the retry is told exactly what progress is required', async () => {
    const { llm, calls } = withCompose((input, mock, call) =>
      call === 1 ? { reply_body: input.lastAgentReply ?? '' } : { reply_body: mock.reply_body },
    );
    const h = emma({ llm });
    await confirmedTurns(h);
    calls.length = 0;
    const s = await turn(h, 'I already confirmed. What is the next step?');
    expect(calls).toHaveLength(2);
    const feedback = calls[1]!.violationFeedback!.join('\n');
    expect(feedback).toMatch(/no_repeated_reply/);
    expect(feedback).toMatch(/PROGRESS REQUIRED/);
    expect(feedback).toMatch(/where the request stands/i);
    expect(calls[1]!.nextAction).toBe('follow_up_pending'); // the decision is authoritative and passed to the model
    expect(s.fallbackUsed).toBe(false);
    expect(s.attempts).toBe(2);
  });

  it('if every attempt repeats, the fallback is a grounded handoff naming the request and the verified order, not a generic holding line', async () => {
    const { llm } = echo();
    const h = emma({ llm });
    await confirmedTurns(h);
    const s = await turn(h, 'I already confirmed. What is the next step?');
    expect(s.fallbackUsed).toBe(true);
    expect(s.proposedResponse).toMatch(/return and refund request for order NL-20077/);
    expect(s.proposedResponse).not.toMatch(/We are looking into this/);
    expect(s.proposedResponse).not.toMatch(/eligible|\d+ days|\$/i); // grounded: promises and states nothing else
    expect(s.escalate).toBe(true);
    expect(s.guardrails.find((g) => g.check === 'safe_fallback')).toMatchObject({
      passed: false,
      severity: 'warning',
    });
  });

  it('a second consecutive fallback acknowledges the follow-up instead of repeating the first one', async () => {
    const { llm } = echo();
    const h = emma({ llm });
    await confirmedTurns(h);
    const first = await turn(h, 'I already confirmed. What is the next step?');
    const second = await turn(h, 'Any update?');
    expect(first.fallbackUsed && second.fallbackUsed).toBe(true);
    expect(second.proposedResponse).not.toBe(first.proposedResponse);
    expect(second.proposedResponse).toMatch(/Thank you for following up/);
  });

  it('with an unknown case the fallback is the generic holding message', async () => {
    const { llm } = withCompose(() => ({ reply_body: 'I have refunded your order.' }));
    const s = await turn(emma({ llm }), 'asdf', { send: false });
    expect(s.fallbackUsed).toBe(true);
    expect(s.proposedResponse).toMatch(/We are looking into this/);
  });

  it('repeating the same customer message is detected and idempotent for the case state', async () => {
    const h = emma();
    await confirmedTurns(h);
    const first = await turn(h, 'I already confirmed. What is the next step?');
    const again = await turn(h, 'I already confirmed. What is the next step?');
    expect(again.customerRepeated).toBe(true);
    expect(again.caseState!.confirmed_facts.slice().sort()).toEqual(
      first.caseState!.confirmed_facts.slice().sort(),
    );
    expect(again.derived!.next_action).toBe('follow_up_pending');
    expect(again.proposedResponse).not.toBe(first.proposedResponse);
    expect(again.proposedResponse).not.toMatch(ASKS_TO_CONFIRM);
    expect(again.fallbackUsed).toBe(false);
  });

  it('a NEW question after the step was given is answered from policy, not treated as a repeat', async () => {
    const h = emma();
    await confirmedTurns(h);
    const s = await turn(h, 'How long will the refund take once it is processed?');
    expect(s.nextStepAlreadyGiven).toBe(true);
    expect(s.derived!.next_action).not.toBe('follow_up_pending');
    expect(s.derived!.next_action).toBe('explain_eligibility');
  });

  it('an explicit request for clarification may repeat earlier content', async () => {
    const { llm } = echo();
    const h = emma({ llm });
    await confirmedTurns(h);
    const s = await turn(h, 'Can you explain that again? I did not understand.');
    expect(s.asksClarification).toBe(true);
    expect(s.guardrails.find((g) => g.check === 'no_repeated_reply')).toBeUndefined();
    expect(s.fallbackUsed).toBe(false);
  });

  it('tells the model which policy figures were already stated, and only warns (not blocks) if it restates them', async () => {
    const { llm, calls } = withCompose(() => ({
      reply_body: 'Remember the 30 days window applies to your table.',
    }));
    const h = emma({ llm });
    h.ctx.messages.push(msg('a0', 'agent', 'You are within the 30-day return window.'));
    const s = await turn(h, 'Can I return the table?', { send: false });
    expect(calls[0]!.alreadyStatedFigures).toContain('30 day');
    const g = s.guardrails.find((x) => x.check === 'repeats_policy_facts');
    expect(g).toMatchObject({ passed: false, severity: 'warning' });
    expect(s.fallbackUsed).toBe(false);
  });
});

describe('procedural grounding in context', () => {
  it('a collection that the policy documents only for defective goods is not allowed for a customer ordering mistake', async () => {
    const { llm } = withCompose(() => ({
      reply_body: 'We will arrange a prepaid collection of the table for you.',
    }));
    const h = emma({ llm });
    const s = await turn(
      h,
      'I think I ordered the wrong product. I want to return it and get a refund.',
      { send: false },
    );
    const g = s.guardrails.find((x) => x.check === 'no_invented_procedure');
    expect(g?.passed).toBe(false);
    expect(g?.detail).toMatch(/only documented for|applies only to defective/i);
    expect(s.proposedResponse).not.toMatch(/collection/i);
  });

  it('the model cannot claim the step is documented when no applicable policy sentence documents it', async () => {
    const { llm } = withCompose(() => ({
      next_step_documented: true,
      reply_body: 'Our team will take it from here.',
    }));
    const s = await turn(
      emma({ llm }),
      'I think I ordered the wrong product. It is unused. I want to return it and get a refund.',
      { send: false },
    );
    expect(s.derived!.next_action).toBe('provide_next_step');
    expect(s.composed!.next_step_documented).toBe(true); // the model's claim...
    expect(s.escalate).toBe(true); // ...is overruled by the policy check
    expect(s.escalationReason).toMatch(/No documented procedure/i);
  });

  it('no invented return labels, addresses or approvals reach the draft', async () => {
    const { llm } = withCompose(() => ({
      reply_body:
        'Please send it to 12 Oak Street with the return label we emailed; your refund is approved.',
    }));
    const s = await turn(emma({ llm }), 'I want to return it and get a refund.', { send: false });
    expect(s.fallbackUsed).toBe(true);
    expect(s.proposedResponse).not.toMatch(/Oak Street|label|approved/i);
  });
});

describe('case-state persistence rules', () => {
  it('a regeneration re-derives the state from the messages instead of inheriting its own earlier extraction', async () => {
    const h = emma();
    const first = await turn(h, 'I think I ordered the wrong product.', { send: false });
    expect(first.previousCaseState).toBeNull();
    // regenerate for the SAME customer message
    const { state } = await runGeneration(h.deps, h.input);
    expect(state.previousCaseState).toBeNull(); // the state computed for this very message is excluded
    expect(state.caseState!.confirmed_facts).toContain('customer_ordered_wrong_item');

    h.ctx.messages.push(msg('c-next', 'customer', 'Yes it is unused.'));
    await runGeneration(h.deps, h.input);
    const regen = (await runGeneration(h.deps, h.input)).state;
    expect(regen.previousCaseState!.as_of_message_id).toBe(first.latest!.id); // the message BEFORE the current one
  });

  it('an older generation that was written later cannot shadow the state of a newer message', async () => {
    const h = emma();
    h.ctx.messages.push(
      msg('m1', 'customer', 'first'),
      msg('m2', 'customer', 'second'),
      msg('m3', 'customer', 'third'),
    );
    const rec = (trigger: string, facts: string[]): GenerationRecord =>
      ({
        trigger_message_id: trigger,
        case_state: { ...emptyCaseState(), confirmed_facts: facts, as_of_message_id: trigger },
      }) as unknown as GenerationRecord;
    h.saved.push(rec('m2', ['item_unused']), rec('m1', [])); // m1's generation finished LAST
    const { state } = await runGeneration(h.deps, h.input);
    expect(state.previousCaseState!.as_of_message_id).toBe('m2');
    expect(state.previousCaseState!.confirmed_facts).toEqual(['item_unused']);
  });

  it('an agent’s own suggestion is never recorded as a customer confirmation', async () => {
    const h = emma();
    h.ctx.messages.push(
      msg(
        'a-0',
        'agent',
        'I assume the table is unused and still in its original packaging, correct?',
      ),
    );
    const s = await turn(h, 'I want to return it.');
    expect(s.caseState!.confirmed_facts).not.toContain('item_unused');
    expect(s.caseState!.confirmed_facts).not.toContain('original_packaging');
  });

  it('a stale previous state cannot override a later correction from the customer', async () => {
    const h = emma();
    await turn(h, 'It is unused and in the original packaging. I want to return it.');
    const s = await turn(h, 'Actually it has been used, I opened and used it.');
    expect(s.caseState!.confirmed_facts).not.toContain('item_unused');
    expect(s.caseState!.denied_facts).toContain('item_unused');
  });
});

describe('policy retrieval and missing operational policy', () => {
  it('retrieves for the continued issue (not for the vague last message) within the brand', async () => {
    const h = emma();
    await turn(h, 'I want to return it and get a refund.');
    h.search.mockClear();
    await turn(h, 'I already confirmed. What is the next step?');
    expect(h.search).toHaveBeenCalledTimes(1);
    const arg = h.search.mock.calls[0]![0];
    expect(arg.brandId).toBe(NORDIC_ID);
    expect(arg.categories).toEqual(['return_policy']);
  });

  it('with no relevant policy it hands over instead of improvising steps', async () => {
    const h = emma({ policies: [], searchResults: [] });
    await turn(
      h,
      'It is unused and in the original packaging. I want to return it and get a refund.',
    );
    const s = await turn(h, 'I already confirmed. What is the next step?');
    expect(s.composeMode).toBe('insufficient');
    expect(s.derived!.next_action).toBe('handoff_to_human');
    expect(s.escalate).toBe(true);
    expect(s.proposedResponse).not.toMatch(/return label|prepaid|portal|within \d+ days/i);
  });
});

describe('guardrail retries for conversation progress', () => {
  it('blocks a redundant confirmation request and retries with feedback', async () => {
    const { llm, calls } = withCompose((_i, mock, call) =>
      call === 1
        ? {
            reply_body: 'Please confirm that you want to return the item.',
            questions_asked: ['resolution_confirmation'],
          }
        : {
            reply_body:
              'Thank you for confirming. Our team will follow up with the return instructions.',
            questions_asked: [],
            next_step_documented: false,
            suggest_human_review: true,
            ...{ cited_source_ids: mock.cited_source_ids },
          },
    );
    const h = emma({ llm });
    const s = await turn(
      h,
      'It is unused and in the original packaging. I want to return it and get a refund. What is the next step?',
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]!.violationFeedback!.join(' ')).toMatch(/no_redundant_question/);
    expect(s.attempts).toBe(2);
    expect(s.proposedResponse).toMatch(/follow up with the return instructions/);
    expect(s.fallbackUsed).toBe(false);
  });

  it('also catches the re-ask in the text when the model under-reports its questions', async () => {
    const { llm } = withCompose(() => ({
      reply_body: 'Could you confirm that you want to return the item?',
      questions_asked: [],
    }));
    const s = await turn(
      emma({ llm }),
      'I want to return it and get a refund. I already confirmed. What is the next step?',
    );
    expect(s.guardrails.find((g) => g.check === 'no_redundant_question')?.passed).toBe(false);
    expect(s.fallbackUsed).toBe(true);
    expect(s.proposedResponse).not.toMatch(ASKS_TO_CONFIRM);
  });

  it('does NOT block a legitimate question about something still unknown', async () => {
    const { llm } = withCompose(() => ({
      reply_body: 'Is the item unused and in its original packaging?',
      questions_asked: ['item_unused', 'original_packaging'],
    }));
    const s = await turn(emma({ llm }), 'Can I return the table?');
    expect(s.guardrails.find((g) => g.check === 'no_redundant_question')?.passed).toBe(true);
    expect(s.fallbackUsed).toBe(false);
  });

  it('does NOT block a clarifying question about details of a known problem', async () => {
    const { llm } = withCompose(() => ({
      reply_body: 'Could you tell me how the table differs from what you ordered?',
      questions_asked: ['item_differs_from_listing'],
    }));
    const s = await turn(emma({ llm }), "The table doesn't look like what I ordered.", {
      send: false,
    });
    expect(s.guardrails.find((g) => g.check === 'no_redundant_question')?.passed).toBe(true);
    expect(s.fallbackUsed).toBe(false);
  });
});

describe('brand isolation in a continuing conversation', () => {
  it('never mentions the other brand even if the model does', async () => {
    const { llm } = withCompose(() => ({
      reply_body: 'At Bloom Botanics you would have 7 days instead.',
    }));
    const s = await turn(
      emma({ llm }),
      'I want to return it and get a refund. What is the next step?',
    );
    expect(s.fallbackUsed).toBe(true);
    expect(s.proposedResponse).not.toMatch(/bloom/i);
    expect(s.sources.every((x) => x.id.startsWith('2000'))).toBe(true);
  });
});

describe('damaged product: photo follow-ups across turns', () => {
  it('asks for the photo once, accepts it, and then moves on to the refund question', async () => {
    const h = makeHarness({
      messages: [],
      order: emmaOrder({ delivered_at: new Date(NOW.getTime() - 3 * 86_400_000).toISOString() }),
      brand: 'nordic',
      policies: [
        ...nordicPolicies,
        {
          kbId: '20000000-0000-4000-8000-000000000003',
          version: 1,
          title: 'Nordic Living damaged_products',
          category: 'damaged_products',
          conditions: { report_within_days: 14, requires_photo: true },
          content: 'Damage must be reported within 14 days with photographs.',
        },
      ],
    });
    const s1 = await turn(h, 'The table arrived damaged, it is cracked.');
    expect(s1.derived!.next_action).toBe('ask_missing_info');
    expect(s1.derived!.missing_information).toContain('photo');
    expect(s1.proposedResponse).toMatch(/photo/i);
    const s2 = await turn(h, 'Here it is.', { images: 1 });
    expect(s2.caseState!.confirmed_facts).toContain('photo_provided');
    expect(s2.derived!.missing_information).not.toContain('photo');
    expect(s2.proposedResponse).not.toMatch(/send (us )?(a|another) (photo|picture)/i);
    const s3 = await turn(h, 'What about the refund?');
    expect(s3.caseState!.confirmed_facts).toContain('photo_provided');
    expect(s3.derived!.missing_information).not.toContain('photo');
    expect(s3.eligibility.some((e) => e.kind === 'refund')).toBe(true);
  });
});

describe('long conversations', () => {
  it('stays fast and bounded with a long history', async () => {
    const h = emma();
    for (let i = 0; i < 80; i++)
      h.ctx.messages.push(
        msg(`l${i}`, i % 2 ? 'agent' : 'customer', `earlier message number ${i}`),
      );
    const spy = vi.spyOn(h.deps.llm, 'understand');
    const t0 = Date.now();
    await turn(h, 'I want to return it and get a refund.');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(spy.mock.calls[0]![0].history.length).toBeLessThanOrEqual(30);
  });
});

describe('sign-off and greeting appropriate to a live chat', () => {
  it('signs the first reply, not each chat message, and signs again after a long pause', async () => {
    const h = emma();
    const first = await turn(h, 'Hello');
    expect(first.proposedResponse).toContain('With kind regards');
    expect(first.proposedResponse!.startsWith('Dear Emma,')).toBe(true);
    const quick = await turn(h, 'Can I return the table?');
    expect(quick.proposedResponse).not.toContain('With kind regards');
    expect(quick.proposedResponse!.startsWith('Dear')).toBe(false);
    const old = new Date(NOW.getTime() - 24 * 3_600_000).toISOString();
    h.ctx.messages.forEach((m) => (m.created_at = old));
    const resumed = await turn(h, 'Hi again, one more question about the table.');
    expect(resumed.proposedResponse).toContain('With kind regards');
  });
});
