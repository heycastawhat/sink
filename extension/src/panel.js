// Only the components the panel uses, as in the web app's main.js.
import '@m3e/web/theme';
import '@m3e/web/button';
import '@m3e/web/icon';
import '@m3e/web/icon-button';
import '@m3e/web/form-field';
import '@m3e/web/search';
import '@m3e/web/snackbar';
import '../../web/src/fonts.css';
import { createEditor } from '../../web/src/editor.js';
import { decodeLink } from '../../web/src/util.js';
import { demoApi } from './demo.js';
import { grab } from './grab.js';
import './panel.css';

const $ = (id) => document.getElementById(id);
const SAVE_DELAY = 800;

// demo: the panel talks to demo.js, a stand-in server in the extension, instead of a real one.
let cfg = { server: '', token: '', folder: 'Inbox', demo: false };
let notes = [];
// The note being edited; path is null until a new note has some words.
let note = { path: null, hash: null, saved: '' };
let editor = null;
let timer = null;
let saving = null;

// ---------- server ----------

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `HTTP ${status}`);
    Object.assign(this, { status, body });
  }
}

async function api(path, { method = 'GET', body } = {}) {
  if (cfg.demo) return demoApi(path, { method, body });
  const res = await fetch(`${cfg.server}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    await signOut();
    throw new ApiError(401, { error: 'Signed out' });
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Signs in in a tab: the server hands a one-time code back to its own /api/auth/extension page, which this watches for
 * (the extension may see that address once it has the server's permission). The code is useless without `verifier`.
 */
async function signIn(origin) {
  // A server from before the extension existed would answer the sign-in with an error page in the tab.
  const probe = await fetch(`${origin}/api/auth/extension`).catch(() => null);
  if (!probe) throw new Error(`Can't reach ${origin}.`);
  if (!probe.ok) throw new Error('This Sink server is too old for the extension. Update it, then sign in again.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const tab = await chrome.tabs.create({ url: `${origin}/api/auth/oidc/start?client=extension&challenge=${challenge}` });
  const code = await new Promise((resolve, reject) => {
    const updated = (id, info) => {
      if (id !== tab.id || !info.url) return;
      const url = new URL(info.url);
      if (url.origin !== origin || url.pathname !== '/api/auth/extension') return;
      done();
      chrome.tabs.remove(id);
      resolve(url.searchParams.get('code'));
    };
    const removed = (id) => id === tab.id && (done(), reject(new Error('The sign-in tab was closed.')));
    const done = () => {
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
    };
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
  });
  const res = await fetch(`${origin}/api/auth/oidc/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, verifier }),
  });
  if (!res.ok) throw new Error("The server didn't accept the sign-in. Try again.");
  const { token } = await res.json();
  cfg = { ...cfg, server: origin, token };
  await chrome.storage.local.set({ cfg });
}

async function signOut() {
  // Revoke the token too, so it doesn't linger in Settings → Devices.
  if (cfg.token && !cfg.demo) await fetch(`${cfg.server}/api/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${cfg.token}` } }).catch(() => {});
  cfg = { ...cfg, token: '', demo: false };
  await chrome.storage.local.set({ cfg });
  show();
}

// ---------- notes ----------

const fileName = (path) => path.split('/').pop().replace(/\.md$/i, '');
const folderOf = (path) => path.split('/').slice(0, -1).join('/');
const blank = (text) => !text.replace(/(^|\s)\/[\w-]*$/, '').replace(/^#+[ \t]*$/gm, '').trim();

async function loadNotes() {
  notes = (await api('/notes')).notes ?? [];
}

function mount(text, path) {
  editor?.destroy();
  editor = createEditor({
    parent: $('editor'),
    doc: text,
    path,
    onChange: () => {
      clearTimeout(timer);
      setStatus('Editing…');
      timer = setTimeout(save, SAVE_DELAY);
    },
    onOpenLink: openLink,
    resolveEmbed: (ref) => image(attachmentUrl(ref)),
    resolveImage: (src) => (/^(https?:|data:)/i.test(src) ? src : image(attachmentUrl(decodeLink(src).replace(/^(\.\.\/)+/, '')))),
    linkTargets: () => notes.filter((n) => !/\.excalidraw\.md$/i.test(n.path)).map((n) => ({ label: fileName(n.path), detail: folderOf(n.path) })),
    loadEmbed: async (target) => {
      const hit = findLinked(target);
      return hit ? api(`/notes/file?path=${encodeURIComponent(hit.path)}`).catch(() => null) : null;
    },
    placeholder: 'Write a note…',
  });
  $('note-name').textContent = path ? fileName(path) : 'New note';
}

// An <img> can't send the token, so images are fetched with it and shown from a blob URL. One promise per image: the
// editor redraws an image only when its source changes, and a new promise would count as a change.
const images = new Map();
function image(url) {
  if (!images.has(url)) {
    const loaded = fetch(url, { headers: { authorization: `Bearer ${cfg.token}` } })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((blob) => URL.createObjectURL(blob));
    // A failure (offline, not uploaded yet) is tried again the next time the image is drawn.
    loaded.catch(() => images.delete(url));
    images.set(url, loaded);
  }
  return images.get(url);
}

const attachmentUrl = (ref) => `${cfg.server}/api/notes/attachment?${ref.includes('/') ? 'path' : 'name'}=${encodeURIComponent(ref)}`;

function findLinked(target) {
  const lower = target.split('#')[0].replace(/\.md$/i, '').trim().toLowerCase();
  return (
    notes.find((n) => n.path.toLowerCase() === `${lower}.md`) ??
    notes.find((n) => fileName(n.path).toLowerCase() === lower.split('/').pop()) ??
    notes.find((n) => n.title?.toLowerCase() === lower)
  );
}

async function openLink(target, { external } = {}) {
  if (external || /^https?:/i.test(target)) return chrome.tabs.create({ url: target });
  const hit = findLinked(target);
  if (hit) return openNote(hit.path);
  toast(`No note called ${target}`);
}

async function openNote(path) {
  await flush();
  await load(path);
}

async function load(path) {
  try {
    const n = await api(`/notes/file?path=${encodeURIComponent(path)}`);
    note = { path: n.path, hash: n.hash, saved: n.content };
    mount(n.content, n.path);
    setStatus('');
    await chrome.storage.local.set({ last: n.path });
  } catch (err) {
    toast(err.message);
  }
}

async function newNote() {
  await flush();
  note = { path: null, hash: null, saved: '' };
  mount('', null);
  setStatus('');
  await chrome.storage.local.set({ last: null });
  editor.focus(true);
}

function save() {
  clearTimeout(timer);
  const run = (saving ?? Promise.resolve()).then(doSave).finally(() => {
    if (saving === run) saving = null;
  });
  return (saving = run);
}

const flush = () => (timer || saving ? save() : Promise.resolve());

async function doSave() {
  timer = null;
  if (!editor) return;
  const text = editor.getText();
  if (text === note.saved) return setStatus(note.path ? 'Saved' : '');
  if (!note.path && blank(text)) return setStatus('');
  setStatus('Saving…');
  try {
    if (!note.path) {
      const heading = /^#\s+(.+)$/m.exec(text)?.[1];
      const title = heading ?? text.trim().split('\n')[0].replace(/^[-*+]\s+(\[.\]\s+)?|^#+\s+/g, '').slice(0, 60);
      const created = await api('/notes', { method: 'POST', body: { folder: cfg.folder, title, content: text } });
      note = { path: created.path, hash: created.hash, saved: text };
      $('note-name').textContent = fileName(created.path);
      notes.push(created);
      await chrome.storage.local.set({ last: created.path });
    } else {
      const saved = await api(`/notes/file?path=${encodeURIComponent(note.path)}`, { method: 'PUT', body: { content: text, base_hash: note.hash } });
      note = { ...note, hash: saved.hash, saved: text };
    }
    setStatus(editor.getText() === note.saved ? 'Saved' : 'Editing…');
  } catch (err) {
    // Changed elsewhere since it was opened: never overwrite. Keep this text as its own note and show theirs.
    if (err.status === 409 && note.path) {
      // load(), not openNote(): openNote flushes, which would queue behind this very save and never finish.
      // If the copy can't be made, fall through and retry: the retry meets the same conflict and tries again.
      const copy = await api('/notes', { method: 'POST', body: { folder: folderOf(note.path), title: `${fileName(note.path)} (conflict)`, content: text } }).catch(() => null);
      if (copy) {
        toast(`This note changed elsewhere. Your version is in "${fileName(copy.path)}".`);
        return load(note.path);
      }
    }
    setStatus(navigator.onLine ? "Can't save, retrying" : 'Offline, will save', 'error');
    timer = setTimeout(save, 5000);
  }
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').dataset.kind = kind;
}

// Inserts markdown at the cursor as its own paragraph.
function insert(text) {
  const view = editor.view;
  const at = view.state.selection.main.head;
  const doc = view.state.doc;
  const before = doc.sliceString(Math.max(0, at - 2), at);
  const lead = at === 0 || before === '\n\n' ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const insert = `${lead}${text}\n`;
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, scrollIntoView: true });
  view.focus();
}

const mdLink = (page) => `[${(page.title || page.url).replace(/([[\]\\])/g, '\\$1')}](${page.url.replace(/[()\s]/g, encodeURIComponent)})`;

// ---------- the page ----------

async function currentPage() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const page = tab?.id ? await grab(tab.id) : null;
  if (!page) {
    toast("Sink can't read this page from here. Right-click it and pick Sink's menu, or allow clipping from the panel in Settings (⋮).");
    return null;
  }
  if (!/^https?:/i.test(page.url)) {
    toast('Only web pages can be clipped.');
    return null;
  }
  return page;
}

async function clipPage(page) {
  toast('Clipping…');
  try {
    const created = await api('/clip', { method: 'POST', body: { url: page.url, html: page.html, folder: cfg.folder } });
    notes.push(created);
    await openNote(created.path);
    toast(`Clipped to ${created.path}`);
  } catch (err) {
    toast(`Couldn't clip that page: ${err.message}`);
  }
}

async function addSelection(page) {
  if (!page.selection) return toast('Select some text on the page first.');
  try {
    const { markdown } = await api('/clip', { method: 'POST', body: { url: page.url, html: page.selection, selection: true } });
    insert(`${markdown}\n\n${mdLink(page)}`);
  } catch (err) {
    toast(err.message);
  }
}

// A right-click or the shortcut, sent over by the background worker.
async function runJob(job) {
  if (!job || Date.now() - job.at > 60_000 || !(cfg.token || cfg.demo)) return;
  await chrome.storage.session.remove('job');
  if (job.kind === 'unreadable') return toast("Sink can't read this page (browser pages and the Web Store are off limits).");
  if (job.kind === 'page') return clipPage(job);
  if (job.kind === 'selection') return addSelection(job);
  if (job.kind === 'link') return insert(mdLink(job));
}

// ---------- find ----------

let findGen = 0;
async function find() {
  const q = $('find').value.trim();
  const gen = ++findGen;
  let items;
  if (!q) items = [...notes].sort((a, b) => b.mtime - a.mtime).slice(0, 8);
  else {
    try {
      items = (await api(`/notes?q=${encodeURIComponent(q)}&limit=12`)).items ?? [];
    } catch {
      items = [];
    }
  }
  if (gen !== findGen) return;
  const box = $('results');
  box.replaceChildren(
    ...items.map((n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'result';
      b.dataset.path = n.path;
      const icon = document.createElement('m3e-icon');
      icon.setAttribute('name', /\.excalidraw\.md$/i.test(n.path) ? 'draw' : 'description');
      const text = document.createElement('span');
      const title = document.createElement('b');
      title.textContent = n.title || fileName(n.path);
      const where = document.createElement('small');
      where.textContent = folderOf(n.path) || 'Notes';
      text.append(title, where);
      b.append(icon, text);
      return b;
    }),
  );
  if (!items.length && q) box.innerHTML = '<div class="empty">No notes found.</div>';
  box.hidden = !q && !items.length;
}

// ---------- ui ----------

// The web app's snackbar, inside <m3e-theme> so it takes the theme's colours.
let bar = null;
function toast(text) {
  bar?.remove();
  bar = Object.assign(document.createElement('m3e-snackbar'), { duration: 4000 });
  bar.append(text);
  bar.addEventListener('toggle', (e) => e.newState === 'closed' && setTimeout(() => e.target.remove(), 300));
  $('theme').append(bar);
  bar.open = true;
}

async function show() {
  const signedIn = !!cfg.token || cfg.demo;
  $('setup').hidden = signedIn;
  $('main').hidden = !signedIn;
  if (!signedIn) {
    $('server').value = cfg.server;
    return $('server').focus();
  }
  $('signed-in').textContent = cfg.demo ? 'the demo. Its notes stay in this browser.' : cfg.server;
  $('sign-out-label').textContent = cfg.demo ? 'Leave the demo' : 'Sign out';
  $('folder').value = cfg.folder;
  try {
    await loadNotes();
  } catch (err) {
    if (err.status === 401) return;
    toast(`Can't reach ${cfg.server}: ${err.message}`);
  }
  const { last } = await chrome.storage.local.get('last');
  if (last && notes.some((n) => n.path === last)) await openNote(last);
  else await newNote();
  runJob((await chrome.storage.session.get('job')).job);
}

$('setup').addEventListener('submit', (e) => {
  e.preventDefault();
  $('setup-error').hidden = true;
  let origin;
  try {
    origin = new URL($('server').value.trim()).origin;
  } catch {
    $('setup-error').textContent = "That isn't a web address.";
    $('setup-error').hidden = false;
    return;
  }
  // Asked in the click itself: Chrome only shows the prompt for a user's gesture.
  chrome.permissions.request({ origins: [`${origin}/*`] }).then(async (granted) => {
    try {
      if (!granted) throw new Error('Sink needs permission to reach your server.');
      await signIn(origin);
      await show();
    } catch (err) {
      $('setup-error').textContent = err.message;
      $('setup-error').hidden = false;
    }
  });
});

$('setup-more').addEventListener('click', () => {
  $('setup-menu').hidden = !$('setup-menu').hidden;
  $('setup-more').setAttribute('aria-expanded', String(!$('setup-menu').hidden));
});
$('demo').addEventListener('click', async () => {
  $('setup-menu').hidden = true;
  cfg = { ...cfg, demo: true };
  await chrome.storage.local.set({ cfg, last: 'Welcome.md' });
  show();
});

$('new').addEventListener('click', newNote);
$('find').addEventListener('input', find);
$('find').addEventListener('focus', find);
$('find-bar').addEventListener('clear', find);
$('find').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('find').value = '';
    $('results').hidden = true;
    editor?.focus();
  }
  if (e.key === 'Enter') $('results').querySelector('.result')?.click();
});
$('results').addEventListener('click', (e) => {
  const b = e.target.closest('.result');
  if (!b) return;
  $('find').value = '';
  $('results').hidden = true;
  openNote(b.dataset.path);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#results, #find-bar')) $('results').hidden = true;
  if (!e.target.closest('#setup-menu, #setup-more')) $('setup-menu').hidden = true;
  if (!e.target.closest('#settings, #more')) {
    $('settings').hidden = true;
    $('more').setAttribute('aria-expanded', 'false');
  }
});
$('more').addEventListener('click', () => {
  $('settings').hidden = !$('settings').hidden;
  $('more').setAttribute('aria-expanded', String(!$('settings').hidden));
});
$('folder').addEventListener('change', async () => {
  cfg = { ...cfg, folder: $('folder').value.trim().replace(/^\/+|\/+$/g, '') };
  await chrome.storage.local.set({ cfg });
});
$('allow-all').addEventListener('click', async () => {
  const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
  toast(granted ? 'The panel can clip any page now.' : 'Not allowed: use the right-click menu to clip.');
});
$('sign-out').addEventListener('click', signOut);

$('clip').addEventListener('click', async () => {
  const page = await currentPage();
  if (page) clipPage(page);
});
$('add-selection').addEventListener('click', async () => {
  const page = await currentPage();
  if (page) addSelection(page);
});
$('add-link').addEventListener('click', async () => {
  const page = await currentPage();
  if (page) insert(mdLink(page));
});

$('todo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('todo').value.trim();
  if (!text) return;
  try {
    const added = await api('/todos', { method: 'POST', body: { text, natural: true } });
    $('todo').value = '';
    toast(`Todo added${added.due ? ` for ${added.due}${added.time ? ` ${added.time}` : ''}` : ''}.`);
  } catch (err) {
    toast(err.message);
  }
});

chrome.storage.session.onChanged.addListener((changes) => changes.job?.newValue && runJob(changes.job.newValue));
// Closing the panel mid-edit: save what's there.
addEventListener('pagehide', () => flush());

const stored = (await chrome.storage.local.get('cfg')).cfg;
if (stored) cfg = { ...cfg, ...stored };
show();
