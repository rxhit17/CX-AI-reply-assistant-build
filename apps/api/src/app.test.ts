import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

const env = loadEnv({
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  LOG_LEVEL: 'silent',
});

describe('system routes', () => {
  it('GET /health returns ok', async () => {
    const app = await buildApp({ env });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /ready returns 503 when a dependency fails', async () => {
    const app = await buildApp({
      env,
      readiness: [{ name: 'database', check: async () => Promise.reject(new Error('down')) }],
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks[0]).toEqual({ name: 'database', ok: false });
  });
});

describe('loadEnv', () => {
  it('rejects missing Supabase config', () => {
    expect(() => loadEnv({ NODE_ENV: 'test' })).toThrow(/SUPABASE_URL/);
  });
  it('requires OpenAI key in production unless mocked', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        SUPABASE_URL: 'http://x.co',
        SUPABASE_ANON_KEY: 'a',
        SUPABASE_SERVICE_ROLE_KEY: 's',
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });
});
