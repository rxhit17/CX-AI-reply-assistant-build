/**
 * Real-model evaluation. Each labelled case runs through the production LangGraph workflow with the real LLM,
 * real embeddings and the real brand-isolated KB search; only the conversation/order fixtures are in memory.
 * Every case is run several times to expose nondeterminism. Scoring is code-based (packages/ai/src/eval).
 *
 *   pnpm eval                    # all cases x 3 runs
 *   pnpm eval --runs 5 --only dmg-01-no-photo
 *   pnpm eval --category multilingual
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import {
  casePassed,
  createEmbeddingService,
  createLlm,
  evaluate,
  runGeneration,
  type CheckResult,
  type ConversationContext,
  type GenerationPorts,
  type GenerationRecord,
  type Metric,
  type OrderFacts,
} from '@cx/ai';
import { toAiConfig } from '../../apps/api/src/ai-config.js';
import { loadEnv } from '../../apps/api/src/env.js';
import { createGenerationPorts } from '../../apps/api/src/services/ai-ports.js';
import { createKbSearchPort } from '../../apps/api/src/services/kb-search.js';
import { id } from '../../supabase/seed/data.js';
import { cases, type EvalCase, type OrderSpec } from './cases.js';
import { IMAGES, type ImageKind } from './images.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const RUNS = Number(flag('runs') ?? 3);
const CONCURRENCY = Number(flag('concurrency') ?? 4);
const only = flag('only');
const onlyCategory = flag('category');

const env = loadEnv();
const config = toAiConfig(env);
if (config.llmMode !== 'openai') throw new Error('The evaluation must run against the real model (LLM_MODE=openai)');
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const llm = createLlm(config);
const embeddings = createEmbeddingService(config);
const realPorts = createGenerationPorts(db);

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.now();
const CUSTOMER = { bloom: { id: 'cust-bloom', name: 'Maya Patel' }, nordic: { id: 'cust-nordic', name: 'Emma Larsen' } };

const { data: kbRows } = await db.from('knowledge_base').select('id, brand_id');
const kbBrand = new Map((kbRows ?? []).map((r) => [r.id as string, r.brand_id as string]));
const { data: brandRows } = await db.from('brands').select('id, name');
const brandName = new Map((brandRows ?? []).map((b) => [b.id as string, b.name as string]));
const voices = new Map<string, ConversationContext['brand']['voice']>();
for (const b of ['bloom', 'nordic'] as const) {
  const { data } = await db.from('brand_settings').select('*').eq('brand_id', id(`brand:${b}`)).single();
  voices.set(b, { tone: data!.tone, communication_style: data!.communication_style, greeting_preference: data!.greeting_preference, sign_off: data!.sign_off, supported_languages: data!.supported_languages });
}

function orderFacts(spec: OrderSpec): OrderFacts {
  const delivered = spec.deliveredHoursAgo !== undefined ? NOW - spec.deliveredHoursAgo * HOUR : spec.deliveredDaysAgo !== undefined ? NOW - spec.deliveredDaysAgo * DAY : null;
  const shipped = spec.shippedDaysAgo !== undefined ? NOW - spec.shippedDaysAgo * DAY : delivered ? delivered - 3 * DAY : null;
  return {
    order_number: 'EV-10001',
    status: spec.status,
    total: spec.total,
    currency: 'USD',
    placed_at: new Date((shipped ?? NOW) - 2 * DAY).toISOString(),
    shipped_at: shipped ? new Date(shipped).toISOString() : null,
    delivered_at: spec.status === 'delivered' && delivered ? new Date(delivered).toISOString() : null,
    estimated_delivery_at: spec.etaInDays !== undefined ? new Date(NOW + spec.etaInDays * DAY).toISOString() : null,
    items: [{ name: spec.item, quantity: 1, unit_price: spec.total }],
  };
}

function buildPorts(c: EvalCase, saved: GenerationRecord[]): GenerationPorts {
  const brandId = id(`brand:${c.brand}`);
  const hidden = new Set(c.withoutPolicies ?? []);
  const images = new Map<string, ImageKind>();
  const messages: ConversationContext['messages'] = c.messages.map((m, i) => {
    const attachments = m.image ? [{ id: `img-${i}`, mime_type: 'image/png' }] : [];
    if (m.image) images.set(`img-${i}`, m.image);
    return { id: `m${i}`, sender_type: m.from, body: m.body, created_at: new Date(NOW - (c.messages.length - i) * 60_000).toISOString(), attachments };
  });
  const order = c.order ? orderFacts(c.order) : null;
  const ctx: ConversationContext = {
    conversation: { id: 'eval-conv', brand_id: brandId, customer_id: CUSTOMER[c.brand].id, order_id: order ? 'eval-order' : null, status: 'open' },
    brand: { id: brandId, name: brandName.get(brandId)!, voice: voices.get(c.brand)! },
    customer: { id: CUSTOMER[c.brand].id, name: CUSTOMER[c.brand].name, preferred_language: 'en' },
    messages,
  };
  const realSearch = createKbSearchPort(db);
  return {
    loadConversation: async () => ctx,
    loadOrder: async () => order,
    loadPolicies: async (b) => (await realPorts.loadPolicies(b)).filter((p) => !hidden.has(p.category)),
    search: { search: async (p) => (await realSearch.search(p)).filter((r) => !hidden.has(r.category)) },
    listOtherBrandNames: realPorts.listOtherBrandNames,
    loadImages: async ({ attachmentIds }) => attachmentIds.flatMap((aid) => (images.has(aid) ? [{ id: aid, dataUrl: `data:image/png;base64,${IMAGES[images.get(aid)!].toString('base64')}` }] : [])),
    saveGeneration: async (r) => {
      saved.push(r);
      return 'eval-generation';
    },
    createEscalation: async () => undefined,
  };
}

interface RunResult {
  caseId: string;
  category: string;
  run: number;
  passed: boolean;
  checks: CheckResult[];
  reply: string;
  latencyMs: number;
  tokens: number;
  attempts: number;
  error?: string;
}

async function runOne(c: EvalCase, run: number): Promise<RunResult> {
  const saved: GenerationRecord[] = [];
  const t0 = Date.now();
  try {
    const { state } = await runGeneration(
      { ports: buildPorts(c, saved), llm, config, embeddings },
      { conversationId: 'eval-conv', brandId: id(`brand:${c.brand}`), customerId: CUSTOMER[c.brand].id, orderId: c.order ? 'eval-order' : null, requestedBy: null },
    );
    const brandId = id(`brand:${c.brand}`);
    const checks = evaluate(c.expect, {
      reply: state.proposedResponse ?? '',
      intent: state.understanding?.intent ?? null,
      eligibility: state.eligibility,
      escalate: state.escalate,
      guardrails: state.guardrails,
      fallbackUsed: state.fallbackUsed,
      injectionSuspected: state.injectionSuspected,
      sourceBrandIds: state.sources.map((s) => kbBrand.get(s.id) ?? 'unknown'),
      expectedBrandId: brandId,
      brandSignOff: voices.get(c.brand)!.sign_off,
      otherBrandNames: [...brandName].filter(([bid]) => bid !== brandId).map(([, n]) => n),
      failed: Boolean(state.error),
    });
    return { caseId: c.id, category: c.category, run, passed: casePassed(checks), checks, reply: state.proposedResponse ?? '', latencyMs: Date.now() - t0, tokens: state.inputTokens + state.outputTokens, attempts: state.attempts, error: state.error?.message };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { caseId: c.id, category: c.category, run, passed: false, checks: [{ metric: 'safety', name: 'generation_completed', passed: false, detail: message }], reply: '', latencyMs: Date.now() - t0, tokens: 0, attempts: 0, error: message };
  }
}

// ------------------------------------------------------------------------------------------------ run
const selected = cases.filter((c) => (!only || c.id === only) && (!onlyCategory || c.category === onlyCategory));
const jobs = selected.flatMap((c) => Array.from({ length: RUNS }, (_, r) => ({ c, r: r + 1 })));
console.log(`Evaluating ${selected.length} cases x ${RUNS} runs = ${jobs.length} generations (concurrency ${CONCURRENCY}) with ${config.chatModel}`);

const results: RunResult[] = [];
let next = 0;
let done = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const res = await runOne(job.c, job.r);
      results.push(res);
      done++;
      if (done % 10 === 0 || done === jobs.length) console.log(`  ${done}/${jobs.length}`);
    }
  }),
);

// ------------------------------------------------------------------------------------------------ report
const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
const byCase = new Map<string, RunResult[]>();
for (const r of results) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);

const caseRows = selected.map((c) => {
  const rs = byCase.get(c.id)!.sort((a, b) => a.run - b.run);
  const passes = rs.filter((r) => r.passed).length;
  return { c, rs, passes };
});
const totalRuns = results.length;
const passedRuns = results.filter((r) => r.passed).length;
const stable = caseRows.filter((r) => r.passes === RUNS).length;
const flaky = caseRows.filter((r) => r.passes > 0 && r.passes < RUNS);
const failing = caseRows.filter((r) => r.passes === 0);

const metricNames: Metric[] = ['intent', 'eligibility', 'escalation', 'groundedness', 'policy_compliance', 'brand', 'language', 'content', 'style', 'safety'];
const metricTable = metricNames.map((m) => {
  const checks = results.flatMap((r) => r.checks.filter((x) => x.metric === m));
  return `| ${m} | ${checks.filter((x) => x.passed).length}/${checks.length} | ${pct(checks.filter((x) => x.passed).length, checks.length)} |`;
});

const categories = [...new Set(selected.map((c) => c.category))];
const catTable = categories.map((cat) => {
  const rs = results.filter((r) => r.category === cat);
  return `| ${cat} | ${selected.filter((c) => c.category === cat).length} | ${rs.filter((r) => r.passed).length}/${rs.length} | ${pct(rs.filter((r) => r.passed).length, rs.length)} |`;
});

const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const tokens = results.reduce((n, r) => n + r.tokens, 0);
const retried = results.filter((r) => r.attempts > 1).length;

const failureDetail = [...failing, ...flaky].map(({ c, rs, passes }) => {
  const worst = rs.find((r) => !r.passed)!;
  const reasons = [...new Set(rs.flatMap((r) => r.checks.filter((x) => !x.passed).map((x) => `${x.name}${x.detail ? ` (${x.detail})` : ''}`)))];
  return `### ${c.id}: ${passes}/${RUNS} runs passed\n- Failed checks: ${reasons.join('; ')}\n- Example reply from a failing run:\n\n> ${worst.reply.replace(/\n+/g, '\n> ') || '(no reply)'}\n`;
});

const report = `# AI evaluation results

_Generated ${new Date().toISOString()} · model \`${config.chatModel}\` (judge \`${config.judgeModel}\`, vision \`${config.visionModel}\`, embeddings \`${config.embeddingModel}\`) · ${selected.length} cases × ${RUNS} runs = ${totalRuns} generations_

Scoring is code-based (see \`packages/ai/src/eval/checks.ts\`); no model grades another model. Cases run through the production LangGraph workflow with real retrieval from the brand-isolated knowledge base. Images are synthetic drawings, so image results measure pipeline behaviour, **not** vision accuracy on real photographs.

## Summary
| | |
|---|---|
| Runs passing every check | **${passedRuns}/${totalRuns} (${pct(passedRuns, totalRuns)})** |
| Cases passing in all ${RUNS} runs | ${stable}/${selected.length} |
| Flaky cases (passed some runs, failed others) | ${flaky.length} |
| Cases failing in every run | ${failing.length} |
| Runs that needed the corrective retry | ${retried} (${pct(retried, totalRuns)}) |
| Runs ending in the safe fallback | ${results.filter((r) => r.checks.some((x) => x.name === 'no_fallback' && !x.passed)).length} |
| Latency p50 / p95 | ${latencies[Math.floor(latencies.length * 0.5)]} ms / ${latencies[Math.floor(latencies.length * 0.95)]} ms |
| Tokens (all runs) | ${tokens.toLocaleString()} |

## By metric (individual checks across all runs)
| Metric | Passed | Rate |
|---|---|---|
${metricTable.join('\n')}

## By category (runs)
| Category | Cases | Passed | Rate |
|---|---|---|---|
${catTable.join('\n')}

## Per case
| Case | Passed runs |
|---|---|
${caseRows.map(({ c, passes }) => `| ${c.id} | ${passes}/${RUNS}${passes === RUNS ? '' : passes === 0 ? ' ❌' : ' ⚠️'} |`).join('\n')}

## Failures and flaky cases
${failureDetail.length ? failureDetail.join('\n') : 'None.'}
`;
mkdirSync('docs/eval', { recursive: true });
writeFileSync('docs/eval-results.md', report);
writeFileSync('docs/eval/eval-results.json', JSON.stringify({ generatedAt: new Date().toISOString(), runs: RUNS, results }, null, 2));
console.log(report.split('## By metric')[0]);
console.log(`Full report: docs/eval-results.md (${failing.length} failing, ${flaky.length} flaky)`);
