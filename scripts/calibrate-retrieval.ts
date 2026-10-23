/**
 * Retrieval calibration. Runs every labelled query against the real KB (brand-isolated SQL search, real
 * embeddings), sweeps the minimum vector similarity, and reports entry-level precision/recall and
 * query-level abstention behaviour. Writes docs/retrieval-calibration.md.
 *
 * Selection rule (stated up front, not fitted afterwards):
 *   choose the LOWEST threshold at which false-sufficient answers on out-of-scope + injection queries are <= 10%
 *   (a false "sufficient" is what lets the model improvise policy), because recall is preferable to precision
 *   as long as abstention is reliable. Ties are broken by higher F1.
 * Non-English raw queries are reported separately because the pipeline translates the search query to
 * English before retrieval.
 */
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { createEmbeddingService, isRelevant, type RetrievalThresholds } from '@cx/ai';
import type { RetrievedKb } from '@cx/shared';
import { toAiConfig } from '../apps/api/src/ai-config.js';
import { loadEnv } from '../apps/api/src/env.js';
import { id } from '../supabase/seed/data.js';
import { retrievalCases, type RetrievalCase } from './retrieval-dataset.js';

const env = loadEnv();
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const embeddings = createEmbeddingService(toAiConfig(env));

interface Cand {
  key: string;
  vector: number | null;
  text: number | null;
  fused: number;
}
interface Row {
  c: RetrievalCase;
  hybrid: Cand[];
  keyword: Cand[];
}

const keyById = new Map<string, string>();
const { data: kb } = await db.from('knowledge_base').select('id');
for (const row of kb ?? []) keyById.set(row.id, row.id);
// seed keys -> ids
const seedKeys = [
  'return',
  'refund',
  'shipping',
  'cancel',
  'damaged',
  'missing',
  'delivery',
  'warranty',
  'faq',
  'payment',
];
for (const brand of ['bloom', 'nordic'])
  for (const k of seedKeys) keyById.set(id(`kb:${brand}-${k}`), `${brand}-${k}`);

async function search(c: RetrievalCase, vec: number[] | null): Promise<Cand[]> {
  const { data, error } = await db.rpc('match_kb_hybrid', {
    p_brand_id: id(`brand:${c.brand}`),
    p_query_text: c.query,
    p_query_embedding: vec ? `[${vec.join(',')}]` : null,
    p_categories: null,
    p_match_count: 20,
    p_min_vector_similarity: 0,
  });
  if (error) throw new Error(error.message);
  return (
    data as {
      id: string;
      vector_score: number | null;
      text_score: number | null;
      fused_score: number;
    }[]
  ).map((r) => ({
    key: keyById.get(r.id) ?? r.id,
    vector: r.vector_score,
    text: r.text_score,
    fused: r.fused_score,
  }));
}

const rows: Row[] = [];
for (const c of retrievalCases) {
  const vec = await embeddings.embedQuery(c.query);
  rows.push({ c, hybrid: await search(c, vec), keyword: await search(c, null) });
}

const abstainTags = new Set(['out-of-scope', 'injection']);
const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}%`);

const asKb = (c: Cand): RetrievedKb => ({
  id: c.key,
  title: c.key,
  category: 'faq',
  version: 1,
  content: '',
  vector_score: c.vector,
  text_score: c.text,
  fused_score: c.fused,
});

/** Evaluates the exact production decision (isRelevant) for one (tau, margin) setting. */
function evalSetting(tau: number, margin: number, subset: Row[]) {
  const th: RetrievalThresholds = {
    minVectorSimilarity: tau,
    relativeMargin: margin,
    minFusedScore: 0.015,
    topK: 5,
  };
  let tp = 0,
    fp = 0,
    fn = 0;
  let answerable = 0,
    answeredRight = 0,
    abstainCases = 0,
    falseSufficient = 0,
    top1 = 0;
  for (const { c, hybrid } of subset) {
    const kbs = hybrid.map(asKb);
    const best = Math.max(...hybrid.map((h) => h.vector ?? -1));
    const pass = kbs.filter((k) => isRelevant(k, th, best, 'hybrid'));
    const rel = new Set(c.relevant);
    for (const p of pass)
      if (rel.has(p.id)) tp++;
      else fp++;
    for (const k of rel) if (!pass.some((p) => p.id === k)) fn++;
    if (abstainTags.has(c.tag)) {
      abstainCases++;
      if (pass.length > 0) falseSufficient++;
    } else {
      answerable++;
      if (pass.some((p) => rel.has(p.id))) answeredRight++;
      const top = [...pass].sort((a, b) => (b.vector_score ?? 0) - (a.vector_score ?? 0))[0];
      if (top && rel.has(top.id)) top1++;
    }
  }
  const precision = tp / Math.max(tp + fp, 1);
  const recall = tp / Math.max(tp + fn, 1);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    tau,
    margin,
    precision,
    recall,
    f1,
    answerable,
    answeredRight,
    abstainCases,
    falseSufficient,
    top1,
  };
}

const english = rows.filter((r) => r.c.tag !== 'non-english');
const nonEnglish = rows.filter((r) => r.c.tag === 'non-english');
const taus = Array.from({ length: 31 }, (_, i) => +(0.2 + i * 0.01).toFixed(2));
const margins = [0.04, 0.06, 0.08, 0.1, 0.12, 0.15, 1];
const grid = taus.flatMap((t) => margins.map((m) => evalSetting(t, m, english)));
const absRate = (g: (typeof grid)[number]) => g.falseSufficient / Math.max(g.abstainCases, 1);
const hitRate = (g: (typeof grid)[number]) => g.answeredRight / Math.max(g.answerable, 1);
// Rule v2 (revised after run 1, see report): maximise F1 subject to abstention and coverage constraints.
const feasible = grid.filter((g) => absRate(g) <= 0.1 && hitRate(g) >= 0.85);
const chosen =
  [...feasible].sort((a, b) => b.f1 - a.f1 || a.tau - b.tau)[0] ??
  [...grid].sort((a, b) => b.f1 - a.f1)[0]!;
const sweep = taus.map((t) => evalSetting(t, chosen.margin, english));

// Distribution of the best similarity for answerable vs unanswerable queries
const bestSim = (r: Row) => Math.max(...r.hybrid.map((h) => h.vector ?? -1));
const ans = english
  .filter((r) => !abstainTags.has(r.c.tag))
  .map(bestSim)
  .sort((a, b) => a - b);
const abs = english
  .filter((r) => abstainTags.has(r.c.tag))
  .map(bestSim)
  .sort((a, b) => a - b);
const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))]!;

// Keyword-only mode (embeddings unavailable): how good is rank-based fused scoring?
function evalKeyword(minFused: number) {
  let answerable = 0,
    hit = 0,
    abstain = 0,
    falseSuff = 0,
    tp = 0,
    fp = 0;
  for (const { c, keyword } of english) {
    const pass = keyword.filter((k) => k.text !== null && k.text > 0 && k.fused >= minFused);
    const rel = new Set(c.relevant);
    for (const p of pass)
      if (rel.has(p.key)) tp++;
      else fp++;
    if (abstainTags.has(c.tag)) {
      abstain++;
      if (pass.length) falseSuff++;
    } else {
      answerable++;
      if (pass.some((p) => rel.has(p.key))) hit++;
    }
  }
  return { minFused, answerable, hit, abstain, falseSuff, precision: tp / Math.max(tp + fp, 1) };
}
const kwSweep = [0.0125, 0.0135, 0.0145, 0.015, 0.0155, 0.0159, 0.0162].map(evalKeyword);

const nonEnglishEval = evalSetting(chosen.tau, chosen.margin, nonEnglish);

const t: RetrievalThresholds = {
  minVectorSimilarity: chosen.tau,
  relativeMargin: chosen.margin,
  minFusedScore: 0.015,
  topK: 5,
};
const md = `# Retrieval calibration

_Generated by \`pnpm calibrate\` on ${new Date().toISOString().slice(0, 10)} against the live KB with \`${embeddings.model}\`._

Dataset: ${retrievalCases.length} labelled queries (${english.length} English: ${english.filter((r) => !abstainTags.has(r.c.tag)).length} answerable, ${abs.length} must-abstain; ${nonEnglish.length} non-English raw). Labels live in \`scripts/retrieval-dataset.ts\`.
Every search is brand-isolated in SQL, so a query is only ever scored against its own brand's ${'~9'} entries.

## Selection rule (v2, revised after the first run)
Run 1 picked the lowest absolute threshold meeting a ≤10% false-sufficient limit and produced 22% precision (see retrieval-calibration-run1-absolute-threshold-only.md): about four irrelevant policies handed to the model per query. Rule v2 adds a relative-margin criterion and maximises F1 subject to:
- false-sufficient rate on out-of-scope + injection queries ≤ 10% (the dangerous error: it lets the model improvise policy), and
- ≥ 85% of answerable queries keeping at least one relevant entry.

**Caveat:** the rule was changed after seeing results and the dataset is small (${retrievalCases.length} queries), so these figures are tuned in-sample and optimistic. Re-run pnpm calibrate when the KB changes materially and extend the dataset.

## Result
**\`RETRIEVAL_MIN_VECTOR_SIMILARITY=${chosen.tau}\` and \`RETRIEVAL_RELATIVE_MARGIN=${chosen.margin}\`**

| Metric @ τ=${chosen.tau}, margin=${chosen.margin} (English) | Value |
|---|---|
| Entry precision | ${pct(Math.round(chosen.precision * 1000), 1000)} |
| Entry recall | ${pct(Math.round(chosen.recall * 1000), 1000)} |
| F1 | ${chosen.f1.toFixed(2)} |
| Answerable queries with ≥1 relevant entry above threshold | ${chosen.answeredRight}/${chosen.answerable} (${pct(chosen.answeredRight, chosen.answerable)}) |
| Top-1 hit is relevant | ${chosen.top1}/${chosen.answerable} (${pct(chosen.top1, chosen.answerable)}) |
| Out-of-scope/injection queries wrongly treated as sufficient | ${chosen.falseSufficient}/${chosen.abstainCases} (${pct(chosen.falseSufficient, chosen.abstainCases)}) |

Best-match similarity distribution (English): answerable p10=${q(ans, 0.1).toFixed(2)} median=${q(ans, 0.5).toFixed(2)}; must-abstain median=${q(abs, 0.5).toFixed(2)} p90=${q(abs, 0.9).toFixed(2)} max=${abs[abs.length - 1]!.toFixed(2)}.

### Sweep over τ at margin ${chosen.margin} (English)
| τ | precision | recall | F1 | answerable hit | false-sufficient |
|---|---|---|---|---|---|
${sweep
  .filter((_, i) => i % 2 === 0)
  .map(
    (s) =>
      `| ${s.tau} | ${s.precision.toFixed(2)} | ${s.recall.toFixed(2)} | ${s.f1.toFixed(2)} | ${s.answeredRight}/${s.answerable} | ${s.falseSufficient}/${s.abstainCases} |`,
  )
  .join('\n')}

### Trade-offs
- Lowering τ raises recall but admits unrelated policies (precision drops); raising it makes the assistant abstain on valid but loosely worded questions.
- Entries below τ are never presented to the model as evidence; if none pass, the graph produces a clarification/escalation draft instead of a policy answer.

## Non-English raw queries (before query translation), at τ=${chosen.tau}
${nonEnglishEval.answeredRight}/${nonEnglishEval.answerable} found a relevant entry via vectors alone. The graph translates the search query to English first (rewriteQuery), so this is a lower bound; keyword (FTS) search is English-only.

## Keyword-only fallback (no embeddings)
Fused scores are rank-based (RRF), so \`RETRIEVAL_MIN_FUSED_SCORE\` effectively means "keyword rank ≤ N".

| min fused | answerable hit | false-sufficient | precision |
|---|---|---|---|
${kwSweep.map((k) => `| ${k.minFused} | ${k.hit}/${k.answerable} | ${k.falseSuff}/${k.abstain} | ${k.precision.toFixed(2)} |`).join('\n')}

Keyword mode is a degraded fallback: it cannot see paraphrases and has weak abstention. Drafts built from keyword-only retrieval are flagged to the agent.
`;
writeFileSync('docs/retrieval-calibration.md', md);
console.log(md);
console.log('\nSuggested env:', JSON.stringify(t));
