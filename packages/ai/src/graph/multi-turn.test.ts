/**
 * Multi-turn regression tests for conversation intelligence. Each test drives SUCCESSIVE customer messages and
 * generations (the agent "sends" every draft), so state carries through the persisted case state and the message
 * history exactly as in production. The mock LLM keeps these tests deterministic: they verify workflow logic
 * (memory, routing, next action, guardrails). Real-model behaviour is measured by `pnpm eval:conversation`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMockLlm } from '../llm/mock.js';
import type { ComposedReply, LlmPort } from '../llm/types.js';
import { runGeneration } from './build.js';
import type { GState } from './state.js';
import { emmaOrder, kb, makeHarness, msg, NOW, nordicPolicies, type Harness } from './testkit.js';

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

const ASKS_TO_CONFIRM =
  /confirm (that )?you (want|would like|wish)|would you like (me )?to proceed|do you (still )?want to return/i;

describe('Nordic Living: Emma, Oak Side Table (the reported failure)', () => {
  it('remembers what she said, never re-asks, and moves to the next supported step', async () => {
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
    expect(s2.route).toBe('policy'); // not the clarification path
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

    const s6 = await turn(h, 'I already confirmed. What is the next step?');
    // facts retained across all turns
    expect(s6.caseState!.confirmed_facts).toEqual(
      expect.arrayContaining(['item_unused', 'original_packaging', 'customer_ordered_wrong_item']),
    );
    expect(s6.caseState).toMatchObject({
      desired_resolution: 'return_and_refund',
      resolution_confirmed: true,
    });
    // the vague message continues the open case instead of becoming "unclear"
    expect(s6.understanding!.intent).toBe('unclear');
    expect(s6.effectiveIntent).toBe('return_request');
    expect(s6.route).toBe('policy');
    expect(s6.derived).toMatchObject({
      next_action: 'provide_next_step',
      workflow_stage: 'ready_to_resolve',
      eligibility_status: 'eligible',
    });
    // verified order facts are used (from the database, not from what she said)
    expect(s6.orderFacts!.order_number).toBe('NL-20077');
    expect(s6.eligibility.every((e) => e.outcome === 'eligible')).toBe(true);

    const reply = s6.proposedResponse!;
    expect(reply).not.toMatch(ASKS_TO_CONFIRM);
    expect(s6.composed!.questions_asked).toEqual([]);
    expect(reply).toMatch(/unused/i); // reuses her facts, marked as hers and subject to inspection
    expect(reply).toMatch(/inspect/i);
    // no documented return procedure in the policy => honest handoff, no invented steps
    expect(s6.composed!.next_step_documented).toBe(false);
    expect(s6.escalate).toBe(true);
    expect(s6.escalationReason).toMatch(/documented procedure/i);
    expect(reply).not.toMatch(/return label|prepaid|rma|portal/i);
    // nothing promised, nothing claimed as done
    expect(s6.guardrails.filter((g) => !g.passed && g.severity === 'blocking')).toEqual([]);
    expect(reply).not.toMatch(
      /we will refund|has been (refunded|processed)|you will receive a refund/i,
    );
    // brand voice: fixed sign-off appears on the first reply, not on every chat message
    expect(h.saved[0]!.body).toContain('With kind regards, Nordic Living Customer Care');
    expect(reply).not.toContain('With kind regards');
    expect(s6.fallbackUsed).toBe(false);
  });

  it('persists the case state on every generation and reloads it for the next run', async () => {
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
    // a very long thread: the early messages are gone from what the graph can see
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

describe('corrections', () => {
  it('uses the corrected intent and issue', async () => {
    const h = emma();
    await turn(h, "The table doesn't look like what I ordered.");
    const s = await turn(h, 'Sorry, I ordered the wrong one myself. I want to return it.');
    expect(s.caseState!.issue_type).toBe('return');
    expect(s.caseState!.confirmed_facts).not.toContain('item_differs_from_listing');
    expect(s.caseState!.confirmed_facts).toContain('customer_ordered_wrong_item');
    expect(s.derived!.next_action).toBe('provide_next_step');
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

    const linked = emma();
    const s2 = await turn(linked, 'I want to return it and get a refund.');
    expect(s2.derived!.missing_information).toEqual([]);
    expect(s2.proposedResponse).not.toMatch(/order number/i);
  });

  it('does not invent eligibility without an order', async () => {
    const h = emma({ order: null });
    const s = await turn(h, 'I want to return it and get a refund.');
    expect(s.eligibility.every((e) => e.outcome === 'insufficient_data')).toBe(true);
    expect(s.proposedResponse).not.toMatch(/eligible under our policy/i);
  });
});

describe('repeated customer messages', () => {
  it('is idempotent for the case state and does not repeat the previous reply', async () => {
    const h = emma();
    await turn(
      h,
      'I think I ordered the wrong product. It is unused and in the original packaging. I want to return it and get a refund.',
    );
    const first = await turn(h, 'I already confirmed. What is the next step?');
    const again = await turn(h, 'I already confirmed. What is the next step?');
    expect(again.caseState!.confirmed_facts.slice().sort()).toEqual(
      first.caseState!.confirmed_facts.slice().sort(),
    );
    expect(again.caseState!.desired_resolution).toBe(first.caseState!.desired_resolution);
    expect(again.proposedResponse).not.toBe(first.proposedResponse);
    expect(again.proposedResponse).not.toMatch(ASKS_TO_CONFIRM);
    expect(again.fallbackUsed).toBe(false);
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
    expect(arg.brandId).toBe('00000000-0000-4000-8000-0000000000c2'); // always the conversation's own brand
    expect(arg.categories).toEqual(['return_policy']); // derived from the effective intent, not "unclear"
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
  const reaskThenFix = (second: string): { llm: LlmPort; calls: unknown[] } => {
    const calls: unknown[] = [];
    const base = createMockLlm();
    const llm: LlmPort = {
      ...base,
      compose: async (input) => {
        calls.push(input.violationFeedback);
        const reply: ComposedReply = (await base.compose(input)).value;
        const first = calls.length === 1;
        return {
          value: first
            ? {
                ...reply,
                reply_body: 'Please confirm that you want to return the item.',
                questions_asked: ['resolution_confirmation'],
                cited_source_ids: [],
              }
            : {
                ...reply,
                reply_body: second,
                questions_asked: [],
                next_step_documented: false,
                suggest_human_review: true,
                cited_source_ids: [],
              },
          usage: { input: 1, output: 1 },
          model: 'test',
        };
      },
    };
    return { llm, calls };
  };

  it('blocks a redundant confirmation request and retries with feedback', async () => {
    const { llm, calls } = reaskThenFix(
      'Thank you for confirming. Our team will follow up with the return instructions.',
    );
    const h = emma({ llm });
    await turn(
      h,
      'It is unused and in the original packaging. I want to return it and get a refund.',
      { send: false },
    );
    calls.length = 0;
    h.ctx.messages.splice(0);
    const s = await turn(
      h,
      'I already confirmed. What is the next step? I want to return it and get a refund.',
    );
    expect(calls).toHaveLength(2);
    expect((calls[1] as string[]).join(' ')).toMatch(/no_redundant_question/);
    expect(s.attempts).toBe(2);
    expect(s.proposedResponse).toMatch(/follow up with the return instructions/);
    expect(s.fallbackUsed).toBe(false);
  });

  it('also catches the re-ask in the text when the model under-reports its questions', async () => {
    const base = createMockLlm();
    const llm: LlmPort = {
      ...base,
      compose: async (input) => {
        const r = (await base.compose(input)).value;
        return {
          value: {
            ...r,
            reply_body: 'Could you confirm that you want to return the item?',
            questions_asked: [],
            cited_source_ids: [],
          },
          usage: { input: 1, output: 1 },
          model: 'test',
        };
      },
    };
    const h = emma({ llm });
    const s = await turn(
      h,
      'I want to return it and get a refund. I already confirmed. What is the next step?',
    );
    expect(s.guardrails.find((g) => g.check === 'no_redundant_question')?.passed).toBe(false);
    expect(s.fallbackUsed).toBe(true); // always re-asking → neutral holding message, never the repeated question
    expect(s.proposedResponse).not.toMatch(ASKS_TO_CONFIRM);
  });

  it('does NOT block a legitimate question about something still unknown', async () => {
    const base = createMockLlm();
    const llm: LlmPort = {
      ...base,
      compose: async (input) => {
        const r = (await base.compose(input)).value;
        return {
          value: {
            ...r,
            reply_body: 'Is the item unused and in its original packaging?',
            questions_asked: ['item_unused', 'original_packaging'],
            cited_source_ids: [],
          },
          usage: { input: 1, output: 1 },
          model: 'test',
        };
      },
    };
    const h = emma({ llm });
    const s = await turn(h, 'Can I return the table?'); // customer has said nothing about its condition yet
    expect(s.guardrails.find((g) => g.check === 'no_redundant_question')?.passed).toBe(true);
    expect(s.fallbackUsed).toBe(false);
  });

  it('blocks invented return procedures that no policy source documents', async () => {
    const base = createMockLlm();
    const llm: LlmPort = {
      ...base,
      compose: async (input) => {
        const r = (await base.compose(input)).value;
        return {
          value: {
            ...r,
            reply_body:
              'Please print the return label from our return portal and drop it off at the post office.',
            questions_asked: [],
            cited_source_ids: [],
          },
          usage: { input: 1, output: 1 },
          model: 'test',
        };
      },
    };
    const h = emma({ llm });
    const s = await turn(h, 'I want to return it and get a refund. What is the next step?');
    expect(s.guardrails.find((g) => g.check === 'no_invented_procedure')?.passed).toBe(false);
    expect(s.proposedResponse).not.toMatch(/return label|portal|drop it off/i);
  });
});

describe('brand isolation in a continuing conversation', () => {
  it('never mentions the other brand even if the model does', async () => {
    const base = createMockLlm();
    const llm: LlmPort = {
      ...base,
      compose: async (input) => {
        const r = (await base.compose(input)).value;
        return {
          value: {
            ...r,
            reply_body: 'At Bloom Botanics you would have 7 days instead.',
            cited_source_ids: [],
          },
          usage: { input: 1, output: 1 },
          model: 'test',
        };
      },
    };
    const h = emma({ llm });
    const s = await turn(h, 'I want to return it and get a refund. What is the next step?');
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
    expect(s3.caseState!.confirmed_facts).toContain('photo_provided'); // remembered
    expect(s3.derived!.missing_information).not.toContain('photo');
    expect(s3.proposedResponse).not.toMatch(/send (us )?(a|another) (photo|picture)/i);
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
    const sent = spy.mock.calls[0]![0].history;
    expect(sent.length).toBeLessThanOrEqual(30); // bounded prompt size
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

    // the conversation resumes the next day: the earlier agent message is old
    const old = new Date(NOW.getTime() - 24 * 3_600_000).toISOString();
    h.ctx.messages.forEach((m) => (m.created_at = old));
    const resumed = await turn(h, 'Hi again, one more question about the table.');
    expect(resumed.proposedResponse).toContain('With kind regards');
  });
});
