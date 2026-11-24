import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [
    {
      name: 'sink-app-shell',
      apply: 'build',
      generateBundle: {
        order: 'post',
        handler(_, bundle) {
          // Vite's generated HTML lists the entry, its static module preloads and styles, not lazy editor chunks.
          const html = String(bundle['index.html'].source);
          const assets = [...new Set(Array.from(html.matchAll(/\b(?:src|href)="(\/assets\/[^"]+)"/g), ([, url]) => url))];
          const publicFiles = ['/favicon.svg', '/manifest.webmanifest'];
          const worker = readFileSync(resolve(import.meta.dirname, 'src/sw.js'), 'utf8');
          const hash = createHash('sha256').update(html).update(worker);
          for (const file of publicFiles) hash.update(readFileSync(resolve(import.meta.dirname, `public${file}`)));
          // A deploy can switch between fetching the worker and its HTML. A missing versioned file makes install
          // fail instead of pairing a different build's index.html with these assets.
          const build = hash.digest('hex').slice(0, 16);
          const shell = `assets/sink-shell-${build}.html`;
          this.emitFile({ type: 'asset', fileName: shell, source: html });
          this.emitFile({
            type: 'asset',
            fileName: 'sw.js',
            source: `const BUILD = ${JSON.stringify(build)};\nconst SHELL_URL = ${JSON.stringify(`/${shell}`)};\nconst SHELL_ASSETS = ${JSON.stringify([...assets, ...publicFiles])};\n${worker}`,
          });
        },
      },
    },
  ],
  server: {
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
  build: {
    rollupOptions: {
      // editor.html is the bare editor the Android app shows in a WebView.
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        editor: resolve(import.meta.dirname, 'editor.html'),
        // share.html is a shared note's read-only page (/s/<id>).
        share: resolve(import.meta.dirname, 'share.html'),
        // public.html is an account's public page (/public/<handle>) and its published notes.
        public: resolve(import.meta.dirname, 'public.html'),
      },
    },
  },
});
