import { defineConfig, devices } from '@playwright/test';

try {
  process.loadEnvFile('.env');
} catch {
  // CI supplies real environment variables
}

// Dedicated ports on 127.0.0.1 so the run never collides with other local apps (3001/5173 are common).
const API_PORT = 3201;
const WEB_PORT = 5373;
const HOST = '127.0.0.1';

/**
 * Deterministic end-to-end run: the API uses the mock LLM (LLM_MODE=mock) with keyword retrieval so the UI
 * behaviour is stable. Database, auth, storage and realtime are the real Supabase project.
 * Real-model quality is measured separately by `pnpm eval`.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://${HOST}:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @cx/api exec tsx --env-file=../../.env src/server.ts',
      url: `http://${HOST}:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        LLM_MODE: 'mock',
        PORT: String(API_PORT),
        LOG_LEVEL: 'warn',
        CORS_ORIGINS: `http://${HOST}:${WEB_PORT}`,
        RATE_LIMIT_AI_PER_AGENT_PER_MIN: '1000',
        RATE_LIMIT_AI_PER_CONVERSATION_PER_MIN: '1000',
      },
    },
    {
      command: `pnpm --filter @cx/web exec vite --host ${HOST} --port ${WEB_PORT} --strictPort`,
      url: `http://${HOST}:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_API_URL: `http://${HOST}:${API_PORT}` },
    },
  ],
});
