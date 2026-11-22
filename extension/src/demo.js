// The demo: a stand-in for a Sink server inside the extension, for trying it (and reviewing it) without one. Notes live
// in the extension's storage. Quick todos and clipping use the server's own code, so they behave as a real server does.
import { Readability } from '@mozilla/readability';
import { htmlToMarkdown, pageText } from '../../server/src/html.ts';
import { parseQuick, todoLine } from '../../server/src/todos.ts';

const KEY = 'demo';
const TODO = 'Todo.md';

const SAMPLE = {
  'Welcome.md': `# Welcome to the Sink demo

This is a demo vault kept in your browser. Everything works as it does with your own Sink server, but nothing leaves this browser.

## Try it

- [ ] Write in this note: it saves as you type
- [ ] Open a page and press **Clip page** below, or right-click the page → *Clip page to Sink*
- [ ] Select some text on a page and press **Selection**
- [ ] Add a todo in plain words below, like "call mum tomorrow 6pm"
- [ ] Find a note with the search bar, or follow a link: [[Wellington weekend]]

> [!tip] Your own server
> Sink is a self-hosted notes app. To use your own, open ⋮ → Leave the demo, and sign in.
`,
  'Trips/Wellington weekend.md': `# Wellington weekend

Ferry over on Friday night, back Sunday afternoon.

## Before we go

- [x] Book the ferry
- [ ] Pack the rain jacket
- [ ] Charge the camera

| Day | Plan |
| --- | --- |
| Friday | Ferry, dinner on Cuba St |
| Saturday | Te Papa, cable car |
| Sunday | Markets, ferry home |
`,
  'Todo.md': '# Todo\n\n- [ ] Renew the library books\n',
};

class DemoError extends Error {
  constructor(status, body) {
    super(body.error);
    Object.assign(this, { status, body });
  }
}

const load = async () => (await chrome.storage.local.get(KEY))[KEY] ?? { files: Object.fromEntries(Object.entries(SAMPLE).map(([p, c]) => [p, { content: c, mtime: Date.now() }])) };
const store = (vault) => chrome.storage.local.set({ [KEY]: vault });
export const resetDemo = () => chrome.storage.local.remove(KEY);

async function hash(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// As the server's parseNote and fileNameFor have it: the first heading, else the file name.
const titleOf = (path, content) => /^#\s+(.+)$/m.exec(content.replace(/^---\n[\s\S]*?\n---\n/, ''))?.[1].trim() ?? path.split('/').pop().replace(/\.md$/i, '');
const fileNameFor = (title) => title.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 100).trim() || 'Untitled';

async function meta(path, file) {
  return { path, title: titleOf(path, file.content), mtime: file.mtime, size: file.content.length, hash: await hash(file.content) };
}

async function create(vault, folder, title, content) {
  const dir = folder.replace(/^\/+|\/+$/g, '');
  const name = fileNameFor(title);
  let path;
  for (let n = 0; ; n++) {
    path = `${dir ? `${dir}/` : ''}${n ? `${name} ${n}` : name}.md`;
    if (!vault.files[path]) break;
  }
  vault.files[path] = { content, mtime: Date.now() };
  await store(vault);
  return meta(path, vault.files[path]);
}

const today = () => new Date().toLocaleDateString('en-CA');

function article(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const pageTitle = doc.title?.trim();
  const found = new Readability(doc).parse();
  const title = (found?.title || pageTitle || new URL(url).hostname).replace(/\s+/g, ' ').trim();
  let markdown = found?.content
    ? htmlToMarkdown(new DOMParser().parseFromString(`<html><body>${found.content}</body></html>`, 'text/html').body, url)
    : pageText(html).replace(/^Title: .*\n*/, '');
  const first = markdown.match(/^# (.*)\n*/);
  if (first && first[1].trim().toLowerCase() === title.toLowerCase()) markdown = markdown.slice(first[0].length);
  return { title, markdown };
}

/** The API calls the panel makes, answered from the demo vault: same paths, bodies and errors as the server. */
export async function demoApi(path, { method = 'GET', body } = {}) {
  const vault = await load();
  const url = new URL(path, 'https://demo.invalid/');
  const route = `${method} ${url.pathname}`;
  const q = url.searchParams;

  if (route === 'GET /notes' && !q.get('q')) {
    const notes = await Promise.all(Object.entries(vault.files).map(([p, f]) => meta(p, f)));
    return { notes: notes.sort((a, b) => b.mtime - a.mtime) };
  }
  if (route === 'GET /notes') {
    const words = q.get('q').toLowerCase().split(/\s+/).filter(Boolean);
    const hits = Object.entries(vault.files).filter(([p, f]) => words.every((w) => `${p}\n${f.content}`.toLowerCase().includes(w)));
    return { items: await Promise.all(hits.slice(0, Number(q.get('limit') ?? 40)).map(([p, f]) => meta(p, f))) };
  }
  if (route === 'GET /notes/file') {
    const file = vault.files[q.get('path')];
    if (!file) throw new DemoError(404, { error: 'note not found' });
    return { ...(await meta(q.get('path'), file)), content: file.content };
  }
  if (route === 'PUT /notes/file') {
    const p = q.get('path');
    const file = vault.files[p];
    // Never an overwrite: a stale hash is a conflict, as on the server.
    if (file && (await hash(file.content)) !== body.base_hash) throw new DemoError(409, { error: 'note changed since it was read', current: { ...(await meta(p, file)), content: file.content } });
    vault.files[p] = { content: body.content, mtime: Date.now() };
    await store(vault);
    return meta(p, vault.files[p]);
  }
  if (route === 'POST /notes') return create(vault, body.folder ?? '', body.title ?? '', body.content ?? '');
  if (route === 'POST /todos') {
    const { text, due, time, every } = body.natural ? parseQuick(body.text, today()) : body;
    const line = todoLine(text, due, time, every);
    const base = vault.files[TODO]?.content ?? '# Todo\n\n';
    vault.files[TODO] = { content: `${base}${base.endsWith('\n') ? '' : '\n'}${line}\n`, mtime: Date.now() };
    await store(vault);
    return { ok: true, path: TODO, raw: line, due: due ?? null, time: time ?? null };
  }
  if (route === 'POST /clip') {
    if (!/^https?:\/\//i.test(body.url) || body.html === undefined) throw new DemoError(400, { error: 'only http and https pages can be clipped' });
    if (body.selection) return { markdown: htmlToMarkdown(new DOMParser().parseFromString(`<html><body>${body.html}</body></html>`, 'text/html').body, body.url) };
    const { title, markdown } = article(body.html, body.url);
    const content = `---\nsource: ${JSON.stringify(body.url)}\nclipped: ${today()}\n---\n\n# ${title}\n\n${markdown}\n`;
    return create(vault, body.folder ?? '', title, content);
  }
  throw new DemoError(404, { error: 'not in the demo' });
}
