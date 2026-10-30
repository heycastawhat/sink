// A shared note (/s/<id>): read-only, through the same editor so it looks the way it does in Sink. The note comes
// from /api/public/share/<id>, and so do the images it embeds. Diagrams and maths render with the bundled plugins.

import { createEditor } from './editor.js';
import { loadPlugins } from './plugin-api.js';
import { bundledPlugins } from './plugins/index.js';

const id = location.pathname.split('/').pop();
const base = `/api/public/share/${encodeURIComponent(id)}`;
const attachment = (name) => `${base}/attachment?name=${encodeURIComponent(name)}`;
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = dark() ? 'dark' : 'light';

async function show() {
  const res = await fetch(base).catch(() => null);
  if (!res?.ok) {
    document.getElementById('share-missing').hidden = false;
    return;
  }
  const note = await res.json();
  document.title = note.title;
  await loadPlugins(
    {
      // Only the bundled ones: a reader isn't signed in, so the server's plugin list (and plugin files) aren't theirs.
      list: async () => [{ id: 'diagrams', bundled_client: true }, { id: 'math', bundled_client: true }],
      url: (path) => path,
      fetch: () => Promise.reject(new Error('not available on a shared page')),
      dark,
    },
    bundledPlugins,
  );
  createEditor({
    parent: document.getElementById('editor'),
    doc: note.content,
    readOnly: true,
    // Links to other notes go nowhere for a reader; web links open in a new tab.
    onOpenLink: (target) => {
      if (/^https?:/i.test(target)) window.open(target, '_blank', 'noopener,noreferrer');
    },
    resolveEmbed: attachment,
    resolveImage: (src) => (/^(https?:|data:)/i.test(src) ? src : attachment(decodeURIComponent(src).replace(/^(\.\.\/)+/, '').split('/').pop())),
    linkTargets: () => [],
  });
}

show();
