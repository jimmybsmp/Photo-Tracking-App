import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Emit a classic `<script>` tag rather than `type="module"`.
 *
 * Vite tags the entry as a module regardless of the rollup output format,
 * and Chromium refuses to fetch a module script from a `file://` page —
 * "blocked by CORS policy ... origin 'null'". The desktop app loads exactly
 * that way, so the module tag makes the renderer silently never execute and
 * the window shows only its background colour. The bundle below is already
 * built as an IIFE, so a plain script tag runs it correctly.
 *
 * `defer` is not optional here. Vite puts the entry in `<head>`, and a
 * classic script there executes synchronously during head parsing — before
 * `<body>` and `#root` exist, so `main.tsx` finds no mount point and does
 * nothing, silently. `type="module"` was providing that deferral implicitly;
 * dropping it means asking for it explicitly.
 */
function classicScriptTag(): Plugin {
  return {
    name: 'phototrack-classic-script',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/ type="module"/g, ' defer').replace(/ crossorigin/g, '');
    },
  };
}

export default defineConfig({
  plugins: [react(), classicScriptTag()],
  /**
   * Relative asset paths, not absolute.
   *
   * The desktop app loads this build off disk through Electron's
   * `loadFile()`, so the page's origin is `file://`. Vite's default base of
   * '/' emits `src="/assets/app.js"`, which under `file://` resolves to the
   * root of the user's disk rather than the app bundle — nothing loads, and
   * the window shows only its own background colour. './' keeps the paths
   * relative to index.html, which is correct both on disk and when served.
   */
  base: './',
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    /**
     * A classic IIFE bundle, not an ES module, for the same reason: a module
     * script is fetched under CORS rules and a `file://` page has an opaque
     * origin, so a `type="module"` entry can silently refuse to execute off
     * disk. The standalone build already does this (see
     * vite.standalone.config.ts); the desktop build needs it for the same
     * reason, since it loads from `file://` too.
     */
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
});
