import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.tsx'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  external: ['ink', 'react', 'yaml', 'zod'],
});
