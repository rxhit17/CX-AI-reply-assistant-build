import { defineConfig } from 'tsup';

// Workspace packages ship TypeScript source, so they are bundled into the server build.
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  noExternal: [/^@cx\//],
});
