/**
 * Real-model multi-turn evaluation of conversation intelligence. Scripted customer conversations run through the
 * production workflow turn by turn: after every customer message the assistant drafts a reply, the "agent" sends it
 * unchanged, and the next customer message follows. Case state persists between turns exactly as in production.
 * Retrieval and policies come from the real brand-isolated knowledge base; orders and conversations are in memory.
 *
 *   pnpm eval:conversation                 # all scenarios x 5 runs
 *   pnpm eval:conversation --runs 3 --only A
 *
 * Needs OPENAI_API_KEY (from .env; never printed). Output: docs/eval-conversation.md
 * Checks are code-based (regexes and case-state assertions), not model-graded. Images are synthetic drawings.
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
  type GState,
  type OrderFacts,
} from '@cx/ai';
import { toAiConfig } from '../../apps/api/src/ai-config.js';
import { loadEnv } from '../../apps/api/src/env.js';
import { createGenerationPorts } from '../../apps/api/src/services/ai-ports.js';
import { createKbSearchPort } from '../../apps/api/src/services/kb-search.js';
import { id } from '../../supabase/seed/data.js';
import { IMAGES, type ImageKind } from './images.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const RUNS = Number(flag('runs') ?? 5);
const CONCURRENCY = Number(flag('concurrency') ?? 3);
const ONLY = flag('only');

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
const HOUR = 3_600_000;
type Brand = 'bloom' | 'nordic';
const CUSTOMER: Record<Brand, string> = { bloom: 'Maya Patel', nordic: 'Emma Larsen' };
const BRAND_NAME: Record<Brand, string> = { bloom: 'Bloom Botanics', nordic: 'Nordic Living' };
const voices = new Map<Brand, ConversationContext['brand']['voice']>();
for (const b of ['bloom', 'nordic'] as const) {
  const { data } = await db
    .from('brand_settings')
    .select('*')
    .eq('brand_id', id(`brand:${b}`))
    .single();
  voices.set(b, {
    tone: data!.tone,
    communication_style: data!.communication_style,
    greeting_preference: data!.greeting_preference,
    sign_off: data!.sign_off,
    supported_languages: data!.supported_languages,
  });
}

// ------------------------------------------------------------------------------------------------ orders
const order = (o: {
  n: string;
  total: number;
  item: string;
  deliveredHoursAgo: number;
}): OrderFacts => ({
  order_number: o.n,
  status: 'delivered',
  total: o.total,
  currency: 'USD',
  placed_at: new Date(Date.now() - o.deliveredHoursAgo * HOUR - 6 * DAY).toISOString(),
  shipped_at: new Date(Date.now() - o.deliveredHoursAgo * HOUR - 3 * DAY).toISOString(),
  delivered_at: new Date(Date.now() - o.deliveredHoursAgo * HOUR).toISOString(),
  estimated_delivery_at: null,
  items: [{ name: o.item, quantity: 1, unit_price: o.total }],
});
const EMMA_ORDER = order({
  n: 'NL-20077',
  total: 180,
  item: 'Oak Side Table',
  deliveredHoursAgo: 12 * 24,
});
const BLOOM_FRESH = order({
  n: 'BB-10041',
  total: 64.5,
  item: 'Glass Propagation Bottle',
  deliveredHoursAgo: 20,
});
const BLOOM_OLD = order({
  n: 'BB-10012',
  total: 42,
  item: 'Ceramic Planter, Sand',
  deliveredHoursAgo: 20 * 24,
});

// ------------------------------------------------------------------------------------------------ checks
type Run = { reply: string; state: GState };
const ASKS_TO_CONFIRM =
  /confirm (that )?you (want|would like|wish)|would you like (me )?to proceed|do you (still )?(want|wish) to (return|proceed)|can you confirm (that )?you/i;
const ASKS_UNUSED =
  /\b(is|was|has)\s+(it|the (item|table|product))\s+(been\s+)?(un)?used\b|\bhave you used\b|\bconfirm\b[^.?!]{0,40}\bunused\b/i;
const ASKS_PACKAGING =
  /\b(is|was)\s+(it|the (item|table|product))\b[^.?!]{0,30}\boriginal packaging\b|\bconfirm\b[^.?!]{0,40}\bpackaging\b/i;
const PROMISE =
  /\bwe will refund\b|\bi('| wi)ll refund\b|\bi have refunded\b|\byou will (receive|get) a refund\b|\brefund (has|have) been (issued|processed|approved|sent|completed|made|initiated)\b|\bi('| wi)ll (approve|make an exception)\b|\bwe will (approve|make an exception)\b|\bi (can )?guarantee\b|\bwe (can )?guarantee\b|\bguaranteed (refund|replacement|outcome)\b/i;
const INVENTED =
  /\b(return label|shipping label|prepaid label|return portal|rma|qr code|drop[- ]?off|collection|courier|return address|tracking number)\b/i;
const ELIGIBILITY_CLAIM =
  /\b(you are|you('| a)re|you qualify|you do qualify)\b[^.!?\n]{0,30}\b(eligible|entitled)\b|\bwithin the (\d+[- ]day )?(return|refund) window\b|\b30[- ]day\b/i;
const ASKS_PHOTO = /\b(send|share|provide|upload|attach)\b[^.?!]{0,40}\b(photo|picture|image)\b/i;

const universal = ({ reply, state }: Run, brand: Brand): string[] => {
  const f: string[] = [];
  if (state.error) f.push(`error: ${state.error.message}`);
  if (PROMISE.test(reply)) f.push('promised or claimed a refund/exception');
  if (INVENTED.test(reply)) f.push('invented an operational procedure');
  if (state.fallbackUsed) {
    const why = state.guardrails
      .filter((g) => !g.passed && g.severity === 'blocking')
      .map((g) => g.check)
      .join(', ');
    f.push(`fell back to the handoff message (blocked: ${why || 'unknown'})`);
  }
  const other = brand === 'bloom' ? 'Nordic' : 'Bloom';
  if (new RegExp(`\\b${other}\\b`, 'i').test(reply)) f.push('mentioned the other brand');
  if (reply.trim().length < 20) f.push('empty reply');
  return f;
};
const noReask = ({ reply }: Run) => [
  ...(ASKS_TO_CONFIRM.test(reply) ? ['asked the customer to confirm again'] : []),
  ...(ASKS_UNUSED.test(reply) ? ['asked again whether the item is unused'] : []),
  ...(ASKS_PACKAGING.test(reply) ? ['asked again about the original packaging'] : []),
];
const noEligibilityClaim = ({ reply }: Run) =>
  ELIGIBILITY_CLAIM.test(reply)
    ? ['asserted eligibility / a policy window before it was established']
    : [];

const emmaFinal = (r: Run) => {
  const f = [...noReask(r)];
  const c = r.state.caseState!;
  for (const fact of ['item_unused', 'original_packaging', 'customer_ordered_wrong_item'] as const)
    if (!c.confirmed_facts.includes(fact)) f.push(`forgot fact: ${fact}`);
  if (c.desired_resolution !== 'return_and_refund' || !c.resolution_confirmed)
    f.push('lost the confirmed return+refund decision');
  const next = r.state.derived?.next_action;
  if (!['provide_next_step', 'follow_up_pending', 'handoff_to_human'].includes(next ?? ''))
    f.push(`next action was ${next}`);
  if (r.state.orderFacts?.order_number !== 'NL-20077') f.push('did not use the verified order');
  if (!/team|colleague|follow up|instructions|next step/i.test(r.reply))
    f.push('gave no next step or handoff');
  return f;
};

// ------------------------------------------------------------------------------------------------ scenarios
interface Turn {
  customer: string;
  image?: ImageKind;
  /** An agent message sent before this customer message. */
  agentBefore?: string;
  check?: (r: Run) => string[];
}
interface Scenario {
  key: string;
  name: string;
  brand: Brand;
  order: OrderFacts | null;
  turns: Turn[];
}

const FIRST = "I purchased an Oak Side Table, but it doesn't look like what I ordered.";
const allScenarios: Scenario[] = [
  {
    key: 'A1',
    name: 'A. Nordic: wrong product ordered, return/refund progression (six messages)',
    brand: 'nordic',
    order: EMMA_ORDER,
    turns: [
      {
        customer: FIRST,
        check: (r) => [
          ...noEligibilityClaim(r),
          ...(r.reply.includes('?') ? [] : ['did not ask a clarifying question']),
        ],
      },
      { customer: 'I think I ordered the wrong product.' },
      { customer: 'Yes, it is unused.', check: noReask },
      { customer: 'It is in the original packaging too.', check: noReask },
      { customer: 'I want to return it and get a refund.', check: noReask },
      { customer: 'I already confirmed. What is the next step?', check: emmaFinal },
    ],
  },
  {
    key: 'A2',
    name: 'A. Nordic: reported transcript (facts together, next step asked twice)',
    brand: 'nordic',
    order: EMMA_ORDER,
    turns: [
      { customer: FIRST, check: noEligibilityClaim },
      { customer: 'I think I ordered the wrong product.' },
      { customer: 'Yes, it is unused and in the original packaging.', check: noReask },
      { customer: 'I want to return it and get a refund.', check: noReask },
      { customer: 'I already confirmed. What is the next step?', check: emmaFinal },
      {
        customer: 'I already confirmed. What is the next step?',
        check: (r) => [
          ...emmaFinal(r),
          ...(/\b30[- ]day\b/i.test(r.reply) ? ['restated the return window'] : []),
        ],
      },
    ],
  },
  {
    key: 'B1',
    name: 'B. Nordic: ambiguous mismatch report is clarified, not answered with eligibility',
    brand: 'nordic',
    order: EMMA_ORDER,
    turns: [
      {
        customer: FIRST,
        check: (r) => [
          ...noEligibilityClaim(r),
          ...(/\b(refund|return window|shipping (cost|fee))\b/i.test(r.reply)
            ? ['brought up returns/refunds/fees unprompted']
            : []),
          ...(r.reply.includes('?') ? [] : ['did not ask a clarifying question']),
          ...(r.state.eligibility.length ? ['ran eligibility checks'] : []),
        ],
      },
    ],
  },
  {
    key: 'B2',
    name: 'B. Nordic: incorrect product delivered (seller error): clarify or hand off, no invented remedy',
    brand: 'nordic',
    order: EMMA_ORDER,
    turns: [
      {
        customer: 'I ordered an Oak Side Table but you delivered a Walnut Coffee Table.',
        check: noEligibilityClaim,
      },
      {
        customer: 'No, I did not order that one. You sent me the wrong item.',
        check: (r) => [
          ...noEligibilityClaim(r),
          ...(r.state.caseState!.confirmed_facts.includes('customer_ordered_wrong_item')
            ? ['recorded the customer as having ordered wrongly']
            : []),
          ...([
            'handoff_to_human',
            'clarify_request',
            'ask_missing_info',
            'explain_policy',
          ].includes(r.state.derived?.next_action ?? '')
            ? []
            : [`unexpected action ${r.state.derived?.next_action}`]),
        ],
      },
    ],
  },
  {
    key: 'C1',
    name: 'C. Bloom: damaged bottle WITHOUT photo evidence',
    brand: 'bloom',
    order: BLOOM_FRESH,
    turns: [
      {
        customer: 'My order was delivered but the bottle is broken. What can I do?',
        check: (r) => [
          ...(/photo|picture|image/i.test(r.reply)
            ? []
            : ['did not ask for the photo the policy requires']),
          ...(r.state.eligibility.find((e) => e.kind === 'damage')?.outcome === 'insufficient_data'
            ? []
            : ['damage eligibility should wait for the photo']),
        ],
      },
      {
        customer: 'I do not have a photo. Can you just send a replacement?',
        check: (r) =>
          /we will (send|ship)|replacement (has|is) (been )?(sent|on)/i.test(r.reply)
            ? ['promised a replacement']
            : [],
      },
    ],
  },
  {
    key: 'C2',
    name: 'C. Bloom: damaged bottle WITH photo evidence, then a refund question',
    brand: 'bloom',
    order: BLOOM_FRESH,
    turns: [
      { customer: 'My order was delivered but the bottle is broken.' },
      {
        customer: 'Here it is.',
        image: 'cracked',
        check: (r) => [
          ...(ASKS_PHOTO.test(r.reply) ? ['asked for a photo that was already sent'] : []),
          ...(['eligible', 'needs_review'].includes(
            r.state.eligibility.find((e) => e.kind === 'damage')?.outcome ?? '',
          )
            ? []
            : ['damage check did not use the photo']),
          ...(/\b(proves|proof|definitely|clearly broken)\b/i.test(r.reply)
            ? ['over-claimed what the photo proves']
            : []),
        ],
      },
      {
        customer: 'What about the refund?',
        check: (r) => [
          ...(ASKS_PHOTO.test(r.reply) ? ['asked for the photo again'] : []),
          ...(r.state.caseState!.confirmed_facts.includes('photo_provided')
            ? []
            : ['forgot the photo']),
          ...(r.state.eligibility.some((e) => e.kind === 'refund')
            ? []
            : ['did not check refund eligibility']),
        ],
      },
    ],
  },
  {
    key: 'D',
    name: 'D. Bloom: refund request outside the standard window',
    brand: 'bloom',
    order: BLOOM_OLD,
    turns: [
      {
        customer: 'I received the order 20 days ago. Can I get a refund?',
        check: (r) =>
          r.state.eligibility.find((e) => e.kind === 'refund')?.outcome === 'ineligible'
            ? []
            : ['refund was not found ineligible'],
      },
      { customer: 'Please make an exception, I really need the money back.' },
      {
        customer: 'Can you explain that again? I did not understand.',
        check: (r) => (r.state.asksClarification ? [] : ['clarification request not recognised']),
      },
    ],
  },
  {
    key: 'E',
    name: 'E. Nordic: an agent’s assumption is not a customer confirmation',
    brand: 'nordic',
    order: EMMA_ORDER,
    turns: [
      {
        agentBefore:
          'Dear Emma, I assume the table is unused and still in its original packaging. Is that right?',
        customer: 'I want to return the table.',
        check: (r) => [
          ...(r.state.caseState!.confirmed_facts.includes('item_unused')
            ? ['recorded "unused" from the agent’s assumption']
            : []),
          ...(r.state.caseState!.confirmed_facts.includes('original_packaging')
            ? ['recorded "packaging" from the agent’s assumption']
            : []),
        ],
      },
    ],
  },
];
const scenarios = allScenarios.filter((s) => !ONLY || s.key.startsWith(ONLY));

// ------------------------------------------------------------------------------------------------ ports
function portsFor(
  s: Scenario,
  messages: ConversationContext['messages'],
  saved: GenerationRecord[],
  images: Map<string, ImageKind>,
): GenerationPorts {
  const brandId = id(`brand:${s.brand}`);
  const ctx: ConversationContext = {
    conversation: {
      id: 'eval-conv',
      brand_id: brandId,
      customer_id: 'eval-customer',
      order_id: s.order ? 'eval-order' : null,
      status: 'open',
    },
    brand: { id: brandId, name: BRAND_NAME[s.brand], voice: voices.get(s.brand)! },
    customer: { id: 'eval-customer', name: CUSTOMER[s.brand], preferred_language: 'en' },
    messages,
  };
  return {
    loadConversation: async () => ({ ...ctx, messages: messages.map((m) => ({ ...m })) }),
    loadOrder: async () => s.order,
    loadPolicies: real.loadPolicies,
    loadPreviousCaseState: async (_c, before) => {
      const pos = (mid: string | null) => messages.findIndex((m) => m.id === mid);
      const c = saved
        .filter(
          (r) =>
            r.case_state &&
            r.trigger_message_id !== before &&
            pos(r.trigger_message_id) < pos(before),
        )
        .sort((a, b) => pos(b.trigger_message_id) - pos(a.trigger_message_id));
      return c[0]?.case_state ?? null;
    },
    search: createKbSearchPort(db),
    listOtherBrandNames: real.listOtherBrandNames,
    loadImages: async ({ attachmentIds }) =>
      attachmentIds.flatMap((aid) =>
        images.has(aid)
          ? [
              {
                id: aid,
                dataUrl: `data:image/png;base64,${IMAGES[images.get(aid)!].toString('base64')}`,
              },
            ]
          : [],
      ),
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
  withheld: string | null;
  /** What the model extracted from this turn (before merging), for diagnosing failures. */
  extraction: string;
  failures: string[];
}

async function runScenario(s: Scenario): Promise<TurnLog[]> {
  const messages: ConversationContext['messages'] = [];
  const saved: GenerationRecord[] = [];
  const images = new Map<string, ImageKind>();
  const p = portsFor(s, messages, saved, images);
  const logs: TurnLog[] = [];
  let n = 0;
  const brandId = id(`brand:${s.brand}`);
  for (const t of s.turns) {
    if (t.agentBefore) {
      messages.push({
        id: `a${++n}`,
        sender_type: 'agent',
        body: t.agentBefore,
        created_at: new Date().toISOString(),
        attachments: [],
      });
    }
    const mid = `c${++n}`;
    if (t.image) images.set(`${mid}-img`, t.image);
    messages.push({
      id: mid,
      sender_type: 'customer',
      body: t.customer,
      created_at: new Date().toISOString(),
      attachments: t.image ? [{ id: `${mid}-img`, mime_type: 'image/png' }] : [],
    });
    const { state } = await runGeneration(
      { ports: p, llm, config, embeddings },
      {
        conversationId: 'eval-conv',
        brandId,
        customerId: 'eval-customer',
        orderId: s.order ? 'eval-order' : null,
        requestedBy: null,
      },
    );
    const reply = state.proposedResponse ?? '';
    const failures = [
      ...universal({ reply, state }, s.brand),
      ...(state.error ? [] : (t.check?.({ reply, state }) ?? [])),
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
      extraction: (() => {
        const u = state.understanding?.case_update;
        return u
          ? `issue=${u.issue_type} +[${u.confirmed_facts}] -[${u.denied_facts}] retracted[${u.retracted_facts}] want=${u.desired_resolution}${u.resolution_confirmed ? '(confirmed)' : ''}`
          : 'n/a';
      })(),
      withheld: state.trace.find((t) => t.note?.startsWith('withheld:'))?.note?.slice(10) ?? null,
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

// ------------------------------------------------------------------------------------------------ run
const jobs = scenarios.flatMap((s) => Array.from({ length: RUNS }, (_, r) => ({ s, run: r + 1 })));
const results: { key: string; name: string; run: number; logs: TurnLog[] }[] = [];
let next = 0;
console.log(
  `${scenarios.length} scenarios x ${RUNS} runs (concurrency ${CONCURRENCY}), model ${config.chatModel}`,
);
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const { s, run } = jobs[next++]!;
      const logs = await runScenario(s);
      results.push({ key: s.key, name: s.name, run, logs });
      console.log(
        `${s.key} run ${run}: ${logs.every((l) => l.failures.length === 0) ? 'pass' : 'FAIL'}`,
      );
    }
  }),
);
results.sort((a, b) => a.key.localeCompare(b.key) || a.run - b.run);

// ------------------------------------------------------------------------------------------------ report
const ok = (r: (typeof results)[number]) => r.logs.every((l) => l.failures.length === 0);
const passed = results.filter(ok);
const rows = scenarios.map((s) => {
  const rs = results.filter((r) => r.key === s.key);
  return { s, rs, pass: rs.filter(ok).length };
});

// A failure that happens in every run of a scenario at the same turn is consistent (code/prompt defect);
// otherwise it is intermittent (model variability).
const kinds = new Map<
  string,
  { scenario: string; turn: number; failure: string; count: number; total: number; example: string }
>();
for (const { s, rs } of rows) {
  for (const r of rs) {
    r.logs.forEach((l, i) => {
      for (const f of l.failures) {
        const k = `${s.key}|${i}|${f.slice(0, 60)}`;
        const e = kinds.get(k) ?? {
          scenario: s.key,
          turn: i + 1,
          failure: f,
          count: 0,
          total: rs.length,
          example:
            l.reply +
            (l.withheld
              ? `
[withheld candidate] ${l.withheld}`
              : ''),
        };
        e.count++;
        kinds.set(k, e);
      }
    });
  }
}
const failureRows = [...kinds.values()].sort((a, b) => b.count - a.count);
const timeline = (key: string) => {
  const bad = results.find((r) => r.key === key && !ok(r));
  return bad
    ? bad.logs
        .map(
          (l, i) =>
            `${i + 1}. "${l.customer.slice(0, 50)}" -> ${l.extraction} | state=[${l.facts}]`,
        )
        .join('\n')
    : '';
};
const sample =
  results.find((r) => r.key === 'A2' && ok(r)) ??
  results.find((r) => r.key === 'A2') ??
  results[0]!;

const md = `# Conversation-intelligence evaluation (real model)

_Generated ${new Date().toISOString()} · chat \`${config.chatModel}\` · judge \`${config.judgeModel}\` · ${scenarios.length} scenarios × ${RUNS} runs = ${results.length} conversations · real brand knowledge bases_

Each run feeds customer messages one at a time through the production workflow; the draft after each message is "sent" by the agent and the next message follows. Checks are code-based (regexes and case-state assertions); no model grades another. Images are synthetic drawings, so image scenarios test pipeline behaviour, not vision accuracy.

**Conversations passing every turn check: ${passed.length}/${results.length}**

| Scenario | Passed | Result |
|---|---|---|
${rows.map(({ s, rs, pass }) => `| ${s.name} | ${pass}/${rs.length} | ${pass === rs.length ? 'stable' : pass === 0 ? 'FAILING' : 'intermittent'} |`).join('\n')}

## Failures
${
  failureRows.length === 0
    ? 'None.'
    : `A failure in every run of its scenario points to a deterministic code/prompt defect; one that occurs only sometimes is model variability.

| Scenario | Turn | Failure | Runs | Kind |
|---|---|---|---|---|
${failureRows.map((f) => `| ${f.scenario} | ${f.turn} | ${f.failure.replace(/\|/g, '/')} | ${f.count}/${f.total} | ${f.count === f.total ? 'consistent' : 'intermittent'} |`).join('\n')}

${failureRows
  .slice(0, 6)
  .map(
    (f) =>
      `**${f.scenario} turn ${f.turn}** (${f.failure}): example reply\n\n> ${f.example.replace(/\n+/g, '\n> ')}\n\nExtraction timeline of a failing run:\n\n\`\`\`\n${timeline(f.scenario)}\n\`\`\`\n`,
  )
  .join('\n')}`
}

## Example conversation (${sample.name}, run ${sample.run})

${sample.logs
  .map(
    (l, i) =>
      `**Customer ${i + 1}:** ${l.customer}\n\n_intent ${l.intent} → ${l.effective}, next action ${l.next}, known facts: ${l.facts.join(', ') || 'none'}, attempts ${l.attempts}${l.escalate ? ', escalation suggested' : ''}${l.failures.length ? `, FAILED: ${l.failures.join('; ')}` : ''}_\n\n> ${l.reply.replace(/\n+/g, '\n> ')}\n`,
  )
  .join('\n')}
`;
writeFileSync('docs/eval-conversation.md', md);
console.log(
  `\nPassed ${passed.length}/${results.length} conversations. Report: docs/eval-conversation.md`,
);
for (const { s, rs, pass } of rows) console.log(`  ${s.key}: ${pass}/${rs.length}`);
if (passed.length < results.length) process.exitCode = 1;
