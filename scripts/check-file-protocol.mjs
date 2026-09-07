#!/usr/bin/env node
/**
 * Assert the built renderer can actually load from `file://`.
 *
 * The desktop app opens dist/index.html through Electron's `loadFile()`, so
 * the page origin is `file://`. Two Vite defaults break that silently — and
 * silently is the problem: the window opens, shows its background colour,
 * and reports nothing.
 *
 *   1. `base: '/'` emits `src="/assets/app.js"`, which under file:// points
 *      at the root of the user's disk, not the app bundle.
 *   2. `type="module"` is fetched under CORS rules, and a file:// page has
 *      an opaque origin — Chromium blocks it outright.
 *
 * And once the module tag is gone, the script needs `defer`: Vite puts the
 * entry in <head>, where a classic script runs before <body> exists, so the
 * app finds no #root to mount into.
 *
 * This runs as part of `npm run build`, so a config change that reintroduces
 * any of the three fails the build instead of shipping a black window.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = resolve(root, 'dist', 'index.html');

if (!existsSync(indexPath)) {
  console.error(`✗ ${indexPath} not found — run the build first.`);
  process.exit(1);
}

const html = readFileSync(indexPath, 'utf8');
const problems = [];

for (const [, attr, url] of html.matchAll(/\b(src|href)="([^"]+)"/g)) {
  if (url.startsWith('/')) {
    problems.push(
      `absolute ${attr}="${url}" — under file:// this resolves to the root of the ` +
        `disk, not the app bundle. Set \`base: './'\` in vite.config.ts.`,
    );
  }
}

if (/type="module"/.test(html)) {
  problems.push(
    'type="module" on the entry script — a module script is fetched under CORS ' +
      'rules and a file:// page has an opaque origin, so Chromium blocks it. ' +
      'See the classicScriptTag plugin in vite.config.ts.',
  );
}

const headEnd = html.indexOf('</head>');
for (const match of html.matchAll(/<script\b([^>]*)>/g)) {
  const attrs = match[1];
  if (!/\bsrc=/.test(attrs)) continue;
  const inHead = headEnd !== -1 && match.index < headEnd;
  if (inHead && !/\bdefer\b/.test(attrs) && !/type="module"/.test(attrs)) {
    problems.push(
      'entry script sits in <head> without `defer` — it executes before <body> ' +
        'exists, so main.tsx finds no #root and mounts nothing, without erroring.',
    );
  }
}

if (problems.length > 0) {
  console.error('✗ dist/index.html will not load from file:// (the desktop app):\n');
  for (const p of problems) console.error(`  · ${p}\n`);
  process.exit(1);
}

console.log('✓ dist/index.html is file://-safe (relative paths, classic deferred script)');
