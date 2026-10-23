/**
 * Generates embeddings for KB entries that need them (pending/failed/stale). Entries whose content is
 * unchanged since their last embedding are skipped. Pass --force to re-embed everything.
 */
import { createClient } from '@supabase/supabase-js';
import { createEmbeddingService } from '@cx/ai';
import { toAiConfig } from '../apps/api/src/ai-config.js';
import { loadEnv } from '../apps/api/src/env.js';
import { embedEntry } from '../apps/api/src/services/kb.js';

const env = loadEnv();
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const aiConfig = toAiConfig(env);
const embeddings = createEmbeddingService(aiConfig);
const force = process.argv.includes('--force');

const { data, error } = await db
  .from('knowledge_base')
  .select(
    'id, brand_id, title, category, content, content_hash, version, embedded_hash, embedding_status, is_active, archived_at',
  )
  .is('archived_at', null);
if (error) throw new Error(error.message);

const tally = { embedded: 0, skipped: 0, failed: 0 };
for (const row of data ?? []) {
  const outcome = await embedEntry({ db, embeddings, aiConfig }, row as never, force);
  tally[outcome] += 1;
  console.log(`${outcome.padEnd(8)} ${row.title}`);
}
console.log(
  `Done: ${tally.embedded} embedded, ${tally.skipped} skipped, ${tally.failed} failed (model ${embeddings.model}).`,
);
if (tally.failed > 0) process.exit(1);
