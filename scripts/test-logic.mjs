#!/usr/bin/env node
/**
 * Bundle tests/logic.test.ts with esbuild (already installed with Vite) and
 * run it in Node. esbuild reads the `@/` paths from tsconfig.json, so the
 * tests import app modules exactly as the app does.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'phototrack-test-')), 'logic.test.mjs');

await build({
  entryPoints: [resolve(root, 'tests/logic.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  tsconfig: resolve(root, 'tsconfig.json'),
  logLevel: 'error',
});

const run = spawnSync(process.execPath, [out], { stdio: 'inherit' });
process.exit(run.status ?? 1);
