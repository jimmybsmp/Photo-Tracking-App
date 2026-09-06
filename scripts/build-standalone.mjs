#!/usr/bin/env node
/**
 * Produce one self-contained .html file that runs offline by double-clicking.
 *
 * No installer, no runtime, no architecture to match — it opens in whatever
 * browser the machine already has, on macOS 10.13 through Apple Silicon
 * alike. That portability is the point of this build: it's the one that
 * works on a machine that can't or shouldn't run the packaged app.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = resolve(root, 'dist-standalone');

const js = readFileSync(resolve(built, 'app.js'), 'utf8');
const css = readFileSync(resolve(built, 'app.css'), 'utf8');

const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const stamp = new Date().toISOString().slice(0, 10);

// A closing </script> anywhere in the bundle would end the tag early.
const safeJs = js.replace(/<\/script>/gi, '<\\/script>');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>PhotoTrack</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${safeJs}</script>
</body>
</html>
`;

mkdirSync(resolve(root, 'release'), { recursive: true });
const out = resolve(root, 'release', `PhotoTrack-${version}-${stamp}.html`);
writeFileSync(out, html, 'utf8');

const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
console.log(`Standalone build: ${out}`);
console.log(`Size: ${mb} MB — open it by double-clicking; no install, no network.`);
console.log('Note: WoodWing Elvis sync is not available in this build — it needs the desktop app.');
