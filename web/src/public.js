// A public page: /public/<handle> lists the notes that account published (`publish: true`), /public/<handle>/<path>
// shows one through the same read-only editor as share links. Bare /public is the owner's page.

import { createEditor } from './editor.js';
import { loadPlugins } from './plugin-api.js';
import { bundledPlugins } from './plugins/index.js';
import { esc, inlineHtml } from './util.js';

const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = dark() ? 'dark' : 'light';
const $ = (id) => document.getElementById(id);
const getJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);

const noteUrl = (handle, path) => `/public/${handle}/${path.replace(/\.md$/i, '').split('/').map(encodeURIComponent).join('/')}`;

/** A [[link]] to another published note, by path, file name or title as Obsidian would; private notes aren't in the list. */
function findNote(notes, target) {
  const want = target.split(/[#|]/)[0].trim().toLowerCase().replace(/\.md$/, '');
  return notes.find((n) => {
    const path = n.path.toLowerCase().replace(/\.md$/, '');
    return path === want || path.split('/').pop() === want || n.title.toLowerCase() === want;
  });
}

function showList(handle, notes) {
  document.title = handle;
  if (!notes.length) return ($('public-empty').hidden = false);
  $('public-list').innerHTML = notes
    .sort((a, b) => b.mtime - a.mtime)
    .map(
      (n) => `<li><a href="${esc(noteUrl(handle, n.path))}"><h2>${esc(n.title)}</h2>${n.excerpt ? `<p>${inlineHtml(n.excerpt)}</p>` : ''}
<time datetime="${new Date(n.mtime).toISOString()}">${new Date(n.mtime).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</time></a></li>`,
    )
    .join('');
  $('public-list').hidden = false;
}

async function showNote(handle, notes, path) {
  const base = `/api/public/pages/${encodeURIComponent(handle)}`;
  const note = await getJson(`${base}/note?path=${encodeURIComponent(path)}`);
  if (!note) return ($('share-missing').hidden = false);
  document.title = `${note.title} · ${handle}`;
  const attachment = (name) => `${base}/attachment?path=${encodeURIComponent(note.path)}&name=${encodeURIComponent(name)}`;
  await loadPlugins(
    {
      list: async () => [{ id: 'diagrams', bundled_client: true }, { id: 'math', bundled_client: true }],
      url: (p) => p,
      fetch: () => Promise.reject(new Error('not available on a public page')),
      dark,
    },
    bundledPlugins,
  );
  createEditor({
    parent: $('editor'),
    // Links to notes that aren't published become their plain text, so they don't look like links that go nowhere.
    doc: note.content.replace(/(?<!!)\[\[([^\]\n]+)\]\]/g, (link, inner) =>
      findNote(notes, inner) ? link : (inner.split('|')[1] ?? inner.split(/[#|]/)[0]).trim(),
    ),
    readOnly: true,
    onOpenLink: (target) => {
      if (/^https?:/i.test(target)) return window.open(target, '_blank', 'noopener,noreferrer');
      const to = findNote(notes, target);
      if (to) location.href = noteUrl(handle, to.path);
    },
    resolveEmbed: attachment,
    resolveImage: (src) => (/^(https?:|data:)/i.test(src) ? src : attachment(decodeURIComponent(src).replace(/^(\.\.\/)+/, '').split('/').pop())),
    linkTargets: () => [],
  });
}

async function show() {
  let [, , handle, ...rest] = location.pathname.split('/').map((p) => decodeURIComponent(p));
  if (!handle) {
    handle = (await getJson('/api/public/pages/owner'))?.handle;
    if (!handle) return ($('share-missing').hidden = false);
    history.replaceState(null, '', `/public/${handle}`);
  }
  const page = await getJson(`/api/public/pages/${encodeURIComponent(handle)}`);
  if (!page) return ($('share-missing').hidden = false);
  $('public-home').textContent = handle;
  $('public-home').href = `/public/${handle}`;
  if (rest.filter(Boolean).length) await showNote(handle, page.notes, `${rest.join('/')}.md`);
  else showList(handle, page.notes);
}

show();
