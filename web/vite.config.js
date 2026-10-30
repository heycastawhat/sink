import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: {
    rollupOptions: {
      // editor.html is the bare editor the Android app shows in a WebView.
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        editor: resolve(import.meta.dirname, 'editor.html'),
        // share.html is a shared note's read-only page (/s/<id>).
        share: resolve(import.meta.dirname, 'share.html'),
      },
    },
  },
});
