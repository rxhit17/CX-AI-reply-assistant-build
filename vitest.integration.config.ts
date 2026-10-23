import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile('.env');
} catch {
  // CI provides real environment variables instead of a .env file
}

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
