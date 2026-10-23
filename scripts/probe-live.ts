/** Runs the real model over the seeded conversations and prints the drafts. Saves then deletes its generations. */
import { createClient } from '@supabase/supabase-js';
import { createEmbeddingService, createLlm, runGeneration } from '@cx/ai';
import { toAiConfig } from '../apps/api/src/ai-config.js';
import { loadEnv } from '../apps/api/src/env.js';
import { createGenerationPorts } from '../apps/api/src/services/ai-ports.js';
import { id } from '../supabase/seed/data.js';

const env = loadEnv();
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const config = toAiConfig(env);
const llm = createLlm(config);
const embeddings = createEmbeddingService(config);
const only = process.argv[2];

for (const key of ['maya', 'liam', 'sofia', 'arjun', 'emma', 'oliver', 'helene', 'noah']) {
  if (only && only !== key) continue;
  const { data: conv } = await db
    .from('conversations')
    .select('*')
    .eq('id', id(`conversation:${key}`))
    .single();
  const t0 = Date.now();
  const { generationId, state } = await runGeneration(
    { ports: createGenerationPorts(db), llm, config, embeddings },
    {
      conversationId: conv.id,
      brandId: conv.brand_id,
      customerId: conv.customer_id,
      orderId: conv.order_id,
      requestedBy: null,
    },
  );
  const bad = state.guardrails.filter((g) => !g.passed);
  console.log(
    `\n=== ${key} | intent=${state.understanding?.intent} lang=${state.replyLanguage} route=${state.route} attempts=${state.attempts} fallback=${state.fallbackUsed} escalate=${state.escalate} ${Date.now() - t0}ms tok=${state.inputTokens}/${state.outputTokens}`,
  );
  console.log(
    'eligibility:',
    state.eligibility.map((e) => `${e.kind}:${e.outcome}`).join(', ') || '-',
    '| sources:',
    state.sources.map((s) => s.title).join('; ') || '-',
  );
  if (state.error) console.log('ERROR', state.error);
  console.log(
    'guardrail failures:',
    bad.map((g) => `${g.severity}/${g.check}: ${g.detail}`).join(' || ') || 'none',
  );
  console.log('--- draft ---\n' + state.proposedResponse);
  if (generationId) {
    await db.from('escalation_requests').delete().eq('generation_id', generationId);
    await db.from('ai_generations').delete().eq('id', generationId);
  }
}
