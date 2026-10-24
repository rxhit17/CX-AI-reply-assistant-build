/**
 * Real-model multi-turn evaluation of conversation intelligence. Runs scripted customer conversations through the
 * production workflow turn by turn: after every customer message the assistant drafts a reply, the "agent" sends it
 * unchanged, and the next customer message follows. Case state is persisted between turns exactly as in production.
 *
 *   pnpm eval:conversation            # all scenarios x 3 runs
 *   pnpm eval:conversation --runs 5
 *
 * Needs OPENAI_API_KEY (from .env; never printed) and the seeded Nordic Living knowledge base.
 * Output: docs/eval-conversation.md
 */
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import {
  createEmbeddingService,
  createLlm,
  runGeneration,
  type ConversationContext,
  type GenerationPorts,
  type GenerationRecord,
  type OrderFacts,
} from '@cx/ai';
import { toAiConfig } from '../../apps/api/src/ai-config.js';
import { loadEnv } from '../../apps/api/src/env.js';
import { createGenerationPorts } from '../../apps/api/src/services/ai-ports.js';
import { createKbSearchPort } from '../../apps/api/src/services/kb-search.js';
import { id } from '../../supabase/seed/data.js';

const args = process.argv.slice(2);
const RUNS = Number(args[args.indexOf('--runs') + 1] || 3);

const env = loadEnv();
const config = toAiConfig(env);
if (config.llmMode !== 'openai') throw new Error('Run this evaluation with LLM_MODE=openai');
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const llm = createLlm(config);
const embeddings = createEmbeddingService(config);
const real = createGenerationPorts(db);

const DAY = 86_400_000;
const NORDIC = id('brand:nordic');
const { data: settings } = await db
  .from('brand_settings')
  .select('*')
  .eq('brand_id', NORDIC)
  .single();

const order: OrderFacts = {
  order_number: 'NL-20077',
  status: 'delivered',
  total: 180,
  currency: 'USD',
  placed_at: new Date(Date.now() - 17 * DAY).toISOString(),
  shipped_at: new Date(Date.now() - 15 * DAY).toISOString(),
  delivered_at: new Date(Date.now() - 12 * DAY).toISOString(),
  estimated_delivery_at: null,
  items: [{ name: 'Oak Side Table', quantity: 1, unit_price: 180 }],
};

interface Turn {
  customer: string;
  /** Checks applied to this turn's draft. */
  check?: (r: {
    reply: string;
    state: Awaited<ReturnType<typeof runGeneration>>['state'];
  }) => string[];
}

const ASKS_TO_CONFIRM =
  /confirm (that )?you (want|would like|wish)|would you like (me )?to proceed|do you (still )?(want|wish) to (return|proceed)|can you confirm (that )?you/i;
const ASKS_UNUSED =
  /\b(is|was|has)\s+(it|the (item|table|product))\s+(been\s+)?(un)?used\b|\bhave you used\b|\bconfirm\b[^.?!]{0,40}\bunused\b/i;
const ASKS_PACKAGING =
  /\b(is|was)\s+(it|the (item|table|product))\b[^.?!]{0,30}\boriginal packaging\b|\bconfirm\b[^.?!]{0,40}\bpackaging\b/i;
const PROMISE =
  /\bwe will refund\b|\bi('| wi)ll refund\b|\bi have refunded\b|\byou will (receive|get) a refund\b|\brefund has been\b/i;
const INVENTED = /\b(return label|prepaid label|return portal|rma|qr code|drop[- ]?off)\b/i;

const noPromise = (r: { reply: string }) =>
  PROMISE.test(r.reply) ? ['promised or claimed a refund'] : [];
const stillAsks = (r: { reply: string }) => [
  ...(ASKS_TO_CONFIRM.test(r.reply) ? ['asked the customer to confirm again'] : []),
  ...(ASKS_UNUSED.test(r.reply) ? ['asked again whether the item is unused'] : []),
  ...(ASKS_PACKAGING.test(r.reply) ? ['asked again about the original packaging'] : []),
];
const final = (r: { reply: string; state: Parameters<NonNullable<Turn['check']>>[0]['state'] }) => {
  const f: string[] = [...stillAsks(r), ...noPromise(r)];
  const c = r.state.caseState!;
  for (const fact of ['item_unused', 'original_packaging', 'customer_ordered_wrong_item'] as const)
    if (!c.confirmed_facts.includes(fact)) f.push(`forgot fact: ${fact}`);
  if (c.desired_resolution !== 'return_and_refund' || !c.resolution_confirmed)
    f.push('lost the confirmed return+refund decision');
  if (
    r.state.derived?.next_action !== 'provide_next_step' &&
    r.state.derived?.next_action !== 'handoff_to_human'
  )
    f.push(`next action was ${r.state.derived?.next_action}`);
  if (r.state.orderFacts?.order_number !== 'NL-20077') f.push('did not use the verified order');
  if (INVENTED.test(r.reply)) f.push('invented a return procedure');
  if (r.state.fallbackUsed) f.push('fell back to the holding message');
  if (!/team|colleague|follow up|instructions|next step/i.test(r.reply))
    f.push('gave no next step or handoff');
  return f;
};

const scenarios: { name: string; turns: Turn[] }[] = [
  {
    name: 'Emma / Oak Side Table (six messages)',
    turns: [
      { customer: "I purchased an Oak Side Table, but it doesn't look like what I ordered." },
      { customer: 'I think I ordered the wrong product.', check: (r) => noPromise(r) },
      {
        customer: 'Yes, it is unused.',
        check: (r) => [...stillAsks(r).filter((x) => /unused/.test(x)), ...noPromise(r)],
      },
      {
        customer: 'It is in the original packaging too.',
        check: (r) => [...stillAsks(r).filter((x) => /packaging|unused/.test(x)), ...noPromise(r)],
      },
      {
        customer: 'I want to return it and get a refund.',
        check: (r) => [...stillAsks(r), ...noPromise(r)],
      },
      { customer: 'I already confirmed. What is the next step?', check: final },
    ],
  },
  {
    name: 'Emma / reported transcript (facts given together, then asked twice)',
    turns: [
      { customer: "I purchased an Oak Side Table, but it doesn't look like what I ordered." },
      { customer: 'I think I ordered the wrong product.' },
      {
        customer: 'Yes, it is unused and in the original packaging.',
        check: (r) => [...stillAsks(r), ...noPromise(r)],
      },
      {
        customer: 'I want to return it and get a refund.',
        check: (r) => [...stillAsks(r), ...noPromise(r)],
      },
      { customer: 'I already confirmed. What is the next step?', check: final },
      {
        customer: 'I already confirmed. What is the next step?',
        check: (r) => [...final(r), ...(r.reply.length < 20 ? ['empty reply'] : [])],
      },
    ],
  },
];

function ports(
  messages: ConversationContext['messages'],
  saved: GenerationRecord[],
): GenerationPorts {
  const ctx: ConversationContext = {
    conversation: {
      id: 'eval-conv',
      brand_id: NORDIC,
      customer_id: 'eval-customer',
      order_id: 'eval-order',
      status: 'open',
    },
    brand: {
      id: NORDIC,
      name: 'Nordic Living',
      voice: {
        tone: settings!.tone,
        communication_style: settings!.communication_style,
        greeting_preference: settings!.greeting_preference,
        sign_off: settings!.sign_off,
        supported_languages: settings!.supported_languages,
      },
    },
    customer: { id: 'eval-customer', name: 'Emma Larsen', preferred_language: 'en' },
    messages,
  };
  return {
    loadConversation: async () => ({ ...ctx, messages: [...messages] }),
    loadOrder: async () => order,
    loadPolicies: real.loadPolicies,
    loadPreviousCaseState: async () =>
      [...saved].reverse().find((r) => r.case_state)?.case_state ?? null,
    search: createKbSearchPort(db),
    listOtherBrandNames: real.listOtherBrandNames,
    loadImages: async () => [],
    saveGeneration: async (r) => {
      saved.push(r);
      return `gen-${saved.length}`;
    },
    createEscalation: async () => undefined,
  };
}

interface TurnLog {
  customer: string;
  reply: string;
  intent: string | null;
  effective: string | null;
  next: string | null;
  facts: string[];
  escalate: boolean;
  attempts: number;
  failures: string[];
}

async function runScenario(s: (typeof scenarios)[number]): Promise<TurnLog[]> {
  const messages: ConversationContext['messages'] = [];
  const saved: GenerationRecord[] = [];
  const p = ports(messages, saved);
  const logs: TurnLog[] = [];
  let n = 0;
  for (const t of s.turns) {
    messages.push({
      id: `c${++n}`,
      sender_type: 'customer',
      body: t.customer,
      created_at: new Date().toISOString(),
      attachments: [],
    });
    const { state } = await runGeneration(
      { ports: p, llm, config, embeddings },
      {
        conversationId: 'eval-conv',
        brandId: NORDIC,
        customerId: 'eval-customer',
        orderId: 'eval-order',
        requestedBy: null,
      },
    );
    const reply = state.proposedResponse ?? '';
    const blocked = state.guardrails.filter(
      (g) => !g.passed && g.severity !== 'info' && g.check !== 'safe_fallback',
    );
    const failures = state.error
      ? [`error: ${state.error.message}`]
      : [
          ...(t.check?.({ reply, state }) ?? []),
          ...(state.fallbackUsed
            ? [
                `guardrail: ${blocked
                  .map((g) => `${g.check} (${g.detail})`)
                  .join(' | ')
                  .slice(0, 300)}`,
              ]
            : []),
        ];
    logs.push({
      customer: t.customer,
      reply,
      intent: state.understanding?.intent ?? null,
      effective: state.effectiveIntent,
      next: state.derived?.next_action ?? null,
      facts: state.caseState?.confirmed_facts ?? [],
      escalate: state.escalate,
      attempts: state.attempts,
      failures,
    });
    messages.push({
      id: `a${++n}`,
      sender_type: 'agent',
      body: reply,
      created_at: new Date().toISOString(),
      attachments: [],
    });
  }
  return logs;
}

const results: { scenario: string; run: number; logs: TurnLog[] }[] = [];
for (const s of scenarios) {
  for (let r = 1; r <= RUNS; r++) {
    process.stdout.write(`${s.name} run ${r}/${RUNS} ... `);
    const logs = await runScenario(s);
    results.push({ scenario: s.name, run: r, logs });
    console.log(logs.every((l) => l.failures.length === 0) ? 'pass' : 'FAIL');
  }
}

const passed = results.filter((r) => r.logs.every((l) => l.failures.length === 0));
const example = results.find((r) => r.scenario.startsWith('Emma / reported'))!;
const md = `# Conversation-intelligence evaluation (real model)

_Generated ${new Date().toISOString()} · \`${config.chatModel}\` · ${scenarios.length} scenarios x ${RUNS} runs · Nordic Living knowledge base, Emma's Oak Side Table delivered 12 days ago (30-day window)_

Each run feeds the customer messages one at a time through the production workflow; after every message the draft is "sent" by the agent and the next customer message follows. Checks are code-based (regexes and case-state assertions), not model-graded.

**Runs passing every turn check: ${passed.length}/${results.length}**

| Scenario | Run | Result | First failing turn |
|---|---|---|---|
${results
  .map((r) => {
    const bad = r.logs.findIndex((l) => l.failures.length);
    return `| ${r.scenario} | ${r.run} | ${bad < 0 ? 'pass' : 'FAIL'} | ${bad < 0 ? '' : `turn ${bad + 1}: ${r.logs[bad]!.failures.join('; ')}`} |`;
  })
  .join('\n')}

## Example run (${example.scenario}, run ${example.run})

${example.logs
  .map(
    (l, i) =>
      `**Customer ${i + 1}:** ${l.customer}\n\n_intent ${l.intent} → ${l.effective}, next action ${l.next}, known facts: ${l.facts.join(', ') || 'none'}, attempts ${l.attempts}${l.escalate ? ', escalation suggested' : ''}${l.failures.length ? `, FAILED: ${l.failures.join('; ')}` : ''}_\n\n> ${l.reply.replace(/\n+/g, '\n> ')}\n`,
  )
  .join('\n')}
`;
writeFileSync('docs/eval-conversation.md', md);
console.log(`\nPassed ${passed.length}/${results.length} runs. Report: docs/eval-conversation.md`);
if (passed.length < results.length) process.exitCode = 1;
