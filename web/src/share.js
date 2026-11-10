// A shared note (/s/<id>), through the same editor so it looks the way it does in Sink. The note comes from
// /api/public/share/<id>, and so do the images it embeds. Diagrams and maths render with the bundled plugins.
// If the owner lets the link edit, a visitor gives a name and their changes autosave back to the note.

import { createEditor } from './editor.js';
import { loadPlugins } from './plugin-api.js';
import { bundledPlugins } from './plugins/index.js';
import { decodeLink } from './util.js';

const id = location.pathname.split('/').pop();
const base = `/api/public/share/${encodeURIComponent(id)}`;
const attachment = (name) => `${base}/attachment?name=${encodeURIComponent(name)}`;
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = dark() ? 'dark' : 'light';
const $ = (id) => document.getElementById(id);
const SAVE_DELAY = 1000;
const POLL_MS = 10_000;

let editor;
const state = { hash: null, saved: '', saving: null, timer: null, mine: null };

function mount(doc, readOnly) {
  editor?.view.destroy();
  editor = createEditor({
    parent: $('editor'),
    doc,
    readOnly,
    onChange: () => {
      // Someone else's text put in by refresh or a conflict is already saved: no save, and the notice stays.
      if (!dirty()) return;
      clearTimeout(state.timer);
      state.timer = setTimeout(save, SAVE_DELAY);
      status('Editing…');
    },
    // Links to other notes go nowhere for a reader; web links open in a new tab.
    onOpenLink: (target) => {
      if (/^https?:/i.test(target)) window.open(target, '_blank', 'noopener,noreferrer');
    },
    resolveEmbed: attachment,
    resolveImage: (src) => (/^(https?:|data:)/i.test(src) ? src : attachment(decodeLink(src).replace(/^(\.\.\/)+/, '').split('/').pop())),
    linkTargets: () => [],
  });
}

function status(text) {
  $('share-status').textContent = `Editing as ${localStorage.getItem('sink-share-name')} · ${text}`;
}

const dirty = () => editor.getText() !== state.saved;

function save() {
  clearTimeout(state.timer);
  if (state.saving) {
    state.timer = setTimeout(save, SAVE_DELAY);
    return;
  }
  state.saving = doSave().finally(() => (state.saving = null));
}

async function doSave() {
  const text = editor.getText();
  if (text === state.saved) return status('Saved');
  status('Saving…');
  const res = await fetch(base, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: text, base_hash: state.hash, name: localStorage.getItem('sink-share-name') }),
  }).catch(() => null);
  const body = await res?.json().catch(() => null);
  if (res?.ok) {
    Object.assign(state, { hash: body.hash, saved: text });
    status(dirty() ? 'Editing…' : 'Saved');
    if (dirty()) state.timer = setTimeout(save, SAVE_DELAY);
  } else if (res?.status === 409 && body?.current) {
    // Someone else saved first: their text wins, and ours stays copyable so nothing is lost.
    Object.assign(state, { hash: body.current.hash, saved: body.current.content });
    if (body.current.content === text) {
      if (dirty()) state.timer = setTimeout(save, SAVE_DELAY);
      return status('Saved');
    }
    // Everything in the editor, including what was typed while the save was out.
    state.mine = editor.getText();
    editor.setText(body.current.content);
    status('Someone else changed this note, so your last edit wasn’t saved');
    $('share-copy').hidden = false;
  } else if (res?.status === 404) {
    status('Editing was turned off, or the note isn’t shared any more');
    mount(editor.getText(), true);
  } else {
    status('Can’t save, retrying');
    state.timer = setTimeout(save, 5000);
  }
}

/** Picks up other people's edits while this page sits untouched. */
async function refresh() {
  if (dirty() || state.saving || document.hidden) return;
  const before = state.hash;
  const note = await fetch(base).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // A save that landed while this was out is newer than what came back.
  if (note?.hash && note.hash !== state.hash && state.hash === before && !dirty() && !state.saving) {
    Object.assign(state, { hash: note.hash, saved: note.content });
    editor.setText(note.content);
  }
}

function startEditing(note) {
  Object.assign(state, { hash: note.hash, saved: note.content });
  $('share-name').hidden = true;
  $('share-editing').hidden = false;
  status('Saved');
  mount(note.content, false);
  setInterval(refresh, POLL_MS);
  addEventListener('beforeunload', (e) => {
    if (dirty()) e.preventDefault();
  });
}

async function show() {
  const res = await fetch(base).catch(() => null);
  if (!res?.ok) {
    $('share-missing').hidden = false;
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
  mount(note.content, true);
  if (!note.editable) return;
  $('share-copy').addEventListener('click', () => navigator.clipboard?.writeText(state.mine).then(() => ($('share-copy').hidden = true)));
  if (localStorage.getItem('sink-share-name')) return startEditing(note);
  // A name first, so the owner can see who changed their note.
  const form = $('share-name');
  form.hidden = false;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) return;
    localStorage.setItem('sink-share-name', name.slice(0, 60));
    startEditing(note);
  });
}

show();
