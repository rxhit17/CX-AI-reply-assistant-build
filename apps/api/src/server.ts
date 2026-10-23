import { createClient } from '@supabase/supabase-js';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

const env = loadEnv();

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const app = await buildApp({
  db: admin,
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
