import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  noExternal: ['@rocket.chat/api-client'],
  external: ['better-sqlite3'],
});
