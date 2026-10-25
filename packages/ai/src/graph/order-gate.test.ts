import { describe, expect, it, vi } from 'vitest';
import { runGeneration, type GraphDeps } from './build.js';
import { config, makeHarness, msg, order } from './testkit.js';

const MY_ORDERS = [
  { id: 'order-1', order_number: 'BB-10041' },
  { id: 'order-2', order_number: 'BB-10012' },
];

/** A conversation with NO order linked, the gate switched on, and in-memory order ports. */
function gateHarness(messages: ReturnType<typeof msg>[], opts: { enabled?: boolean } = {}) {
  const h = makeHarness({ messages, order: null, brand: 'bloom' });
  const linked: string[] = [];
  const list = vi.fn(async () => MY_ORDERS);
  const link = vi.fn(async ({ orderId }: { orderId: string }) => {
    linked.push(orderId);
  });
  const deps: GraphDeps = {
    ...h.deps,
    config: { ...config, orderGate: { enabled: opts.enabled ?? true, maxAttempts: 3 } },
    ports: {
      ...h.deps.ports,
      listCustomerOrders: list,
      linkOrderToConversation: link,
      // once an order is linked, the port returns its facts
      loadOrder: async (id) => (id === 'order-1' ? order() : null),
    },
  };
  return { h, deps, linked, list, link };
}

const run = (g: ReturnType<typeof gateHarness>) => runGeneration(g.deps, g.h.input);

describe('order verification gate', () => {
  it('asks for the order number when the question needs an order and none is linked', async () => {
    const g = gateHarness([msg('m1', 'customer', 'I want to return my plant pot')]);
    const { state } = await run(g);
    const rec = g.h.saved[0]!;
    expect(state.orderGate?.outcome).toBe('ask');
    expect(rec.status).toBe('draft');
    expect(rec.body).toMatch(/share your order number/i);
    expect(rec.body.startsWith('Hi Maya!')).toBe(true);
    expect(rec.case_state?.derived).toMatchObject({
      next_action: 'ask_missing_info',
      missing_information: ['order_reference'],
    });
    expect(rec.escalate).toBe(false);
    expect(rec.guardrails.some((x) => !x.passed && x.severity === 'blocking')).toBe(false);
    expect(g.link).not.toHaveBeenCalled();
    // no policy was retrieved: the draft only asks for the number
    expect(g.h.search).not.toHaveBeenCalled();
  });

  it('verifies a matching order number, links it and continues with the normal flow', async () => {
    const g = gateHarness([
      msg('m1', 'customer', 'I want to return my plant pot'),
      msg('m2', 'agent', 'Could you share your order number?'),
      msg('m3', 'customer', 'it is bb 10041'),
    ]);
    const { state } = await run(g);
    expect(state.orderGate).toMatchObject({ outcome: 'verified', orderNumber: 'BB-10041' });
    expect(g.linked).toEqual(['order-1']);
    expect(state.orderFacts?.order_number).toBe('BB-10041');
    // the normal flow ran: it routed, evaluated eligibility and did not just ask for the number again
    expect(state.eligibility.length).toBeGreaterThan(0);
    expect(g.h.saved[0]!.order_facts?.order_number).toBe('BB-10041');
    expect(g.h.saved[0]!.body).not.toMatch(/share your order number/i);
  });

  it('accepts an order number the customer gave together with the question', async () => {
    const g = gateHarness([msg('m1', 'customer', 'I want to return order BB-10041')]);
    const { state } = await run(g);
    expect(state.orderGate?.outcome).toBe('verified');
    expect(g.linked).toEqual(['order-1']);
  });

  it('asks again, politely, when the number does not match', async () => {
    const g = gateHarness([
      msg('m1', 'customer', 'I want to return my plant pot'),
      msg('m2', 'agent', 'Could you share your order number?'),
      msg('m3', 'customer', 'BB-99999'),
    ]);
    const { state } = await run(g);
    expect(state.orderGate).toMatchObject({ outcome: 'ask', failedAttempts: 1 });
    expect(g.h.saved[0]!.body).toMatch(/could not find an order/i);
    expect(g.link).not.toHaveBeenCalled();
    expect(g.h.saved[0]!.escalate).toBe(false);
  });

  it("does not match another customer's order number", async () => {
    // NL-20077 exists in the database, but not among this customer's orders
    const g = gateHarness([
      msg('m1', 'customer', 'I want to return my plant pot'),
      msg('m2', 'agent', 'Could you share your order number?'),
      msg('m3', 'customer', 'NL-20077'),
    ]);
    const { state } = await run(g);
    expect(state.orderGate?.outcome).toBe('ask');
    expect(g.link).not.toHaveBeenCalled();
    expect(g.h.saved[0]!.body).not.toMatch(/NL-20077/);
  });

  it('hands over to a person after too many wrong numbers', async () => {
    const g = gateHarness([
      msg('m1', 'customer', 'I want to return my plant pot'),
      msg('m2', 'agent', 'Could you share your order number?'),
      msg('m3', 'customer', 'BB-11111'),
      msg('m4', 'agent', 'I could not find it, please check.'),
      msg('m5', 'customer', 'BB-22222'),
      msg('m6', 'agent', 'I could not find it, please check.'),
      msg('m7', 'customer', 'BB-33333'),
    ]);
    const { state } = await run(g);
    expect(state.orderGate).toMatchObject({ outcome: 'handoff', failedAttempts: 3 });
    const rec = g.h.saved[0]!;
    expect(rec.escalate).toBe(true);
    expect(rec.body).toMatch(/passing this to our team/i);
    expect(g.h.escalations).toHaveLength(1);
  });

  it('does not gate questions that need no order data', async () => {
    const g = gateHarness([msg('m1', 'customer', 'what is your free shipping policy?')]);
    const { state } = await run(g);
    expect(state.orderGate?.outcome).toBe('not_needed');
    // the gate produced no draft of its own (the assistant's usual flow handled the question)
    expect(g.h.saved[0]!.guardrails.some((x) => x.check === 'order_verification')).toBe(false);
    expect(g.h.saved[0]!.graph_trace.map((t) => t.node)).not.toContain('generateOrderRequest');
  });

  it('does not gate a customer who asks for a person', async () => {
    const g = gateHarness([msg('m1', 'customer', 'I want to speak to a real person')]);
    const { state } = await run(g);
    expect(state.orderGate?.outcome).toBe('not_needed');
  });

  it('skips the gate when an order is already linked (e.g. chosen by the agent)', async () => {
    const h = makeHarness({
      messages: [msg('m1', 'customer', 'I want to return my plant pot')],
      order: order(),
    });
    const list = vi.fn(async () => MY_ORDERS);
    const deps: GraphDeps = {
      ...h.deps,
      config: { ...config, orderGate: { enabled: true, maxAttempts: 3 } },
      ports: { ...h.deps.ports, listCustomerOrders: list, linkOrderToConversation: vi.fn() },
    };
    const { state } = await runGeneration(deps, h.input);
    expect(state.orderGate?.outcome).toBe('not_needed');
    expect(list).not.toHaveBeenCalled();
    expect(h.saved[0]!.body).not.toMatch(/share your order number/i);
  });

  it('is completely inactive when switched off', async () => {
    const g = gateHarness([msg('m1', 'customer', 'I want to return my plant pot')], {
      enabled: false,
    });
    const { state } = await run(g);
    expect(state.orderGate).toBeNull();
    expect(g.list).not.toHaveBeenCalled();
    expect(g.h.saved[0]!.graph_trace.map((t) => t.node)).not.toContain('verifyOrder');
  });
});

describe('progress events (streaming)', () => {
  it('reports the stages in order and the reply text, without changing the result', async () => {
    const h = makeHarness({
      messages: [msg('m1', 'customer', 'Hi, I would like a refund for my plant pot')],
      order: order(),
    });
    const events: { type: string; node?: string; text?: string }[] = [];
    const plain = await runGeneration(h.deps, h.input);
    const h2 = makeHarness({
      messages: [msg('m1', 'customer', 'Hi, I would like a refund for my plant pot')],
      order: order(),
    });
    const streamed = await runGeneration(
      { ...h2.deps, onProgress: (e) => events.push(e as never) },
      h2.input,
    );

    const steps = events.filter((e) => e.type === 'step').map((e) => e.node);
    expect(steps[0]).toBe('loadConversation');
    expect(steps).toEqual(
      expect.arrayContaining(['understandIntent', 'generateResponse', 'saveDraft']),
    );
    expect(steps.indexOf('understandIntent')).toBeLessThan(steps.indexOf('generateResponse'));
    expect(steps.indexOf('generateResponse')).toBeLessThan(steps.indexOf('saveDraft'));
    // the preview text is the model's own text; the saved draft only adds greeting and sign-off around it
    const lastText = events.filter((e) => e.type === 'draft_text').at(-1)?.text;
    expect(lastText).toBeTruthy();
    expect(h2.saved[0]!.body).toContain(lastText!);
    // streaming must not change the outcome
    expect(h2.saved[0]!.body).toBe(h.saved[0]!.body);
    expect(streamed.state.route).toBe(plain.state.route);
  });

  it('a failing listener never breaks generation', async () => {
    const h = makeHarness({ messages: [msg('m1', 'customer', 'refund please')], order: order() });
    const { generationId } = await runGeneration(
      {
        ...h.deps,
        onProgress: () => {
          throw new Error('listener bug');
        },
      },
      h.input,
    );
    expect(generationId).toBe('gen-1');
  });
});
