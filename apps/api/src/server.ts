import { createClient } from '@supabase/supabase-js';
import { createEmbeddingService } from '@cx/ai';
import { toAiConfig } from './ai-config.js';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { embedPendingEntries } from './services/kb.js';

const env = loadEnv();

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const aiConfig = toAiConfig(env);
// Mock mode (tests/CI) uses keyword retrieval: the stored KB vectors come from the real embedding model, so
// mock vectors would not be comparable to them.
const embeddings =
  aiConfig.llmMode === 'openai' && aiConfig.openaiApiKey ? createEmbeddingService(aiConfig) : null;

const app = await buildApp({
  db: admin,
  embeddings,
  env,
  readiness: [
    {
      name: 'database',
      check: async () => {
        const { error } = await admin
          .from('brands')
          .select('id', { head: true, count: 'exact' })
          .limit(1);
        if (error) throw new Error(error.message);
      },
    },
  ],
});

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Embed anything left pending/failed (provider outage, crash mid-save), now and every 10 minutes.
const sweep = () =>
  void embedPendingEntries({ db: admin, embeddings, aiConfig }).catch((err) =>
    app.log.warn({ err }, 'embedding sweep failed'),
  );
sweep();
setInterval(sweep, 10 * 60_000).unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
