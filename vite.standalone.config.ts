import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Build for the single-file offline app.
 *
 * Differs from the normal build in one way that matters: the output is a
 * classic IIFE script, not an ES module. A module script is fetched under CORS
 * rules, and a page opened from `file://` has an opaque origin — so the module
 * build silently refuses to run when the HTML is double-clicked off a USB
 * stick, which is exactly how this build is meant to be used.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    /**
     * Array form, because order decides the match: the font sheet has to be
     * redirected before the generic '@' alias rewrites it into a real path.
     *
     * The portable single file keeps the system font stack. Bundling the
     * typeface would inline base64 into a file whose whole point is being
     * small enough to carry anywhere.
     */
    alias: [
      { find: '@/styles/fonts.css', replacement: resolve(__dirname, 'src/styles/fonts.empty.css') },
      { find: '@', replacement: resolve(__dirname, 'src') },
    ],
  },
  build: {
    outDir: 'dist-standalone',
    /**
     * The offline file gets opened in whatever browser the machine has,
     * including Safari 13.1 on macOS 10.13. esbuild down-compiles the syntax
     * to match; the runtime APIs those browsers lack are shimmed in
     * src/lib/compat.ts.
     */
    target: ['safari12', 'chrome64', 'firefox67', 'edge79'],
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
});
