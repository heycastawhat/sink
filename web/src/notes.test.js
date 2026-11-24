import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { ChangeSet, EditorState } from '@codemirror/state';

const realLiveSession = (await import('./live.js')).liveSession;
let useLive;
let livePlugin;
let liveView;

let editor;
const create = (options) => {
  let text = options.doc;
  if (useLive) {
    liveView = {
      state: EditorState.create({ doc: text, extensions: options.extensions }),
      dispatch(spec) {
        const transaction = this.state.update(spec);
        this.state = transaction.state;
        livePlugin.update({ docChanged: transaction.docChanged, selectionSet: transaction.selection != null });
        if (transaction.docChanged) options.onChange?.(this.state.doc.toString());
      },
    };
    livePlugin = options.extensions.at(-1).create(liveView);
  }
  editor = {
    getText: () => useLive ? liveView.state.doc.toString() : text,
    setText(value) {
      if (useLive) return liveView.dispatch({ changes: { from: 0, to: liveView.state.doc.length, insert: value } });
      text = value;
      options.onChange?.(value);
    },
    focus() {},
    destroy() { if (useLive) livePlugin.destroy(); },
  };
  return editor;
};
mock.module('./editor.js', () => ({ createEditor: create }));
// Most tests cover fallback saving; live tests drive the real session with a headless CodeMirror view.
mock.module('./live.js', () => ({
  liveSession: (options) => useLive ? realLiveSession({
    ...options,
    onStatus(text, kind) {
      statuses.push(text);
      options.onStatus(text, kind);
    },
  }) : ({ extension: [], started: false, unavailable: false, start() {}, destroy() {} }),
  renderPeople() {},
}));

let notes;
let current;
let copies;
let failCopy;
let messages;
let storage;
const nativeFetch = globalThis.fetch;
let stream;
let firstCreate;
let statuses;
let rejoins;
let rejoinStatus;
const path = 'N23 Journal.md';
const original = '# N23 Journal\n\nOriginal body';
const pinned = '---\npinned: true\n---\n' + original;
const latest = pinned + '\nLATESTFROMANDROID';

beforeEach(async () => {
  useLive = false;
  firstCreate = false;
  statuses = [];
  rejoins = [];
  rejoinStatus = 200;
  storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.sessionStorage = globalThis.localStorage;
  globalThis.history = { replaceState(_state, _title, hash) { location.hash = hash; } };
  const elements = new Map();
  const element = () => ({
    hidden: false,
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {},
    querySelector: () => element(),
    querySelectorAll: () => [],
  });
  globalThis.document = {
    getElementById(id) {
      if (id === 'notes') return null;
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    body: element(),
    querySelectorAll: () => [],
    addEventListener() {},
    dispatchEvent() {},
  };
  globalThis.ResizeObserver = class { disconnect() {} };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.location = { hash: '#/n/N23%20Journal.md' };
  current = { path, content: original, hash: 'original', mtime: Date.now() };
  copies = [];
  failCopy = false;
  messages = [];
  const { api } = await import('./api.js');
  api.note = async () => ({ ...current });
  api.notes = async () => ({ notes: [current, ...copies], folders: [] });
  api.backlinks = api.mentions = async () => ({ items: [] });
  api.noteMeta = async () => {
    current = { ...current, content: pinned, hash: 'pinned', pinned: true };
    return current;
  };
  api.createNote = async (input) => {
    if (failCopy) throw new Error('offline');
    if (firstCreate) {
      firstCreate = false;
      current = { ...current, content: input.content };
      return current;
    }
    const copy = { ...input, path: input.title + '.md', hash: 'copy' };
    copies.push(copy);
    return copy;
  };
  notes = await import(`./notes.js?test=${Math.random()}`);
  notes.initNotes({ toast: (message) => messages.push(message) });
});

afterEach(async () => {
  await notes.closeNote();
  globalThis.fetch = nativeFetch;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function liveStream() {
  globalThis.fetch = async (url, options = {}) => {
    if (url.startsWith('/api/live?')) {
      return new Response(new ReadableStream({
        start(controller) {
          stream = controller;
          options.signal.addEventListener('abort', () => controller.close(), { once: true });
        },
      }));
    }
    if (url === '/api/live/rejoin') {
      rejoins.push(JSON.parse(options.body));
      return new Response(null, { status: rejoinStatus });
    }
    return Response.json({ hash: current.hash, dirty: false });
  };
}
function hello() {
  stream.enqueue(new TextEncoder().encode('event: hello\ndata: ' + JSON.stringify({
    type: 'init', conn: 'connection', epoch: 'room', version: 0,
    hash: current.hash, dirty: false, text: current.content,
  }) + '\n\n'));
}

test('connected live updates and saved notifications still replace the note without making a draft', async () => {
  useLive = true;
  liveStream();
  await notes.openNote(path);
  hello();
  await tick();
  const addition = '\nCo-edited';
  const changes = ChangeSet.of({ from: original.length, insert: addition }, original.length).toJSON();
  stream.enqueue(new TextEncoder().encode('event: update\ndata: ' + JSON.stringify({
    version: 1, dirty: true, updates: [{ clientID: 'another-editor', changes }],
  }) + '\n\n'));
  await tick();
  expect(notes.openNoteInfo().text).toBe(original + addition);
  expect(statuses.at(-1)).toBe('Saving…');
  stream.enqueue(new TextEncoder().encode('event: saved\ndata: ' + JSON.stringify({ hash: 'co-edited', dirty: false }) + '\n\n'));
  await tick();
  expect(statuses.at(-1)).toBe('Saved');
  expect(storage.has('sink:unsaved:' + path)).toBe(false);
});

test('a newly saved plain live note leaves no draft when Android later saves offline edits', async () => {
  useLive = true;
  firstCreate = true;
  liveStream();
  await notes.openDraft();
  editor.setText(original);
  await notes.saveForReload();
  hello();
  await tick();
  expect(statuses.at(-1)).toBe('Saved');
  await notes.closeNote();
  current = { ...current, content: original + '\nLATESTFROMANDROID', hash: 'android' };
  await notes.openNote(path);
  expect(notes.openNoteInfo().text).toBe(current.content);
  expect(copies).toHaveLength(0);
  expect(storage.has('sink:unsaved:' + path)).toBe(false);
});

test('leaving a newly saved live note before the first connection keeps no saved draft', async () => {
  useLive = true;
  firstCreate = true;
  liveStream();
  await notes.openDraft();
  editor.setText(original);
  await notes.saveForReload();
  await notes.closeNote();
  expect(storage.has('sink:unsaved:' + path)).toBe(false);
  current = { ...current, content: original + '\nAndroid', hash: 'android' };
  await notes.openNote(path);
  hello();
  await tick();
  expect(copies).toHaveLength(0);
  expect(notes.openNoteInfo().text).toBe(current.content);
});

test('a remote edit before the first live hello does not rejoin the already saved creation text', async () => {
  useLive = true;
  firstCreate = true;
  liveStream();
  await notes.openDraft();
  editor.setText(original);
  await notes.saveForReload();
  current = { ...current, content: original + '\nAndroid', hash: 'android' };
  rejoinStatus = 409;
  hello();
  await tick();
  expect(rejoins).toEqual([]);
  expect(copies).toHaveLength(0);
  expect(notes.openNoteInfo().text).toBe(current.content);
});

test('a genuine local edit before the first connection still conflicts with a remote edit', async () => {
  useLive = true;
  liveStream();
  await notes.openNote(path);
  const mine = original + '\nLocal';
  editor.setText(mine);
  expect(JSON.parse(storage.get('sink:unsaved:' + path)).text).toBe(mine);
  current = { ...current, content: original + '\nAndroid', hash: 'android' };
  rejoinStatus = 409;
  hello();
  await tick();
  expect(rejoins).toEqual([{ conn: 'connection', base_hash: 'original', text: mine }]);
  expect(copies).toHaveLength(1);
  expect(copies[0].content).toBe(mine);
  expect(notes.openNoteInfo().text).toBe(current.content);
});

test('typing during the first REST save remains an unsaved live draft', async () => {
  useLive = true;
  firstCreate = true;
  liveStream();
  await notes.openDraft();
  editor.setText(original);
  const saving = notes.saveForReload();
  const mine = original + '\nTyped during save';
  editor.setText(mine);
  await saving;
  expect(JSON.parse(storage.get('sink:unsaved:' + path)).text).toBe(mine);
  expect(current.content).toBe(original);
  rejoinStatus = 409;
  current = { ...current, content: original + '\nAndroid', hash: 'android' };
  hello();
  await tick();
  expect(rejoins[0].text).toBe(mine);
  expect(copies[0].content).toBe(mine);
});

test('a clean first hello clears an offline draft that the server already saved', async () => {
  useLive = true;
  liveStream();
  const mine = original + '\nLocal';
  storage.set('sink:unsaved:' + path, JSON.stringify({ base: current.hash, text: mine }));
  await notes.openNote(path);
  current = { ...current, content: mine, hash: 'saved-offline' };
  hello();
  await tick();
  expect(statuses.at(-1)).toBe('Saved');
  expect(rejoins).toEqual([]);
  expect(storage.has('sink:unsaved:' + path)).toBe(false);
});

test('a clean live hello and later saved event retain a failed conflict copy for retry', async () => {
  useLive = true;
  liveStream();
  const stash = JSON.stringify({ base: 'original', text: original + '\nUnsaved offline edit' });
  storage.set('sink:unsaved:' + path, stash);
  current = { ...current, content: latest, hash: 'android' };
  failCopy = true;
  await notes.openNote(path);
  expect(storage.get('sink:unsaved:' + path)).toBe(stash);
  hello();
  await tick();
  expect(notes.openNoteInfo().text).toBe(latest);
  expect(storage.get('sink:unsaved:' + path)).toBe(stash);
  stream.enqueue(new TextEncoder().encode('event: saved\ndata: ' + JSON.stringify({ hash: current.hash, dirty: false }) + '\n\n'));
  await tick();
  expect(storage.get('sink:unsaved:' + path)).toBe(stash);
  await notes.closeNote();
  failCopy = false;
  await notes.openNote(path);
  expect(copies).toHaveLength(1);
  expect(copies[0].content).toBe(JSON.parse(stash).text);
});

test('pin then leave and reopen after an Android edit does not resurrect a saved body', async () => {
  await notes.openNote(path);
  await notes.setOpenMeta({ pinned: true });
  await notes.closeNote();
  current = { ...current, content: latest, hash: 'android' };
  await notes.openNote(path);
  expect(notes.openNoteInfo().text).toBe(latest);
  expect(copies).toHaveLength(0);
  expect(messages).toEqual([]);
  expect(storage.has('sink:unsaved:' + path)).toBe(false);
});

test('a genuinely edited stale draft still becomes a conflict copy', async () => {
  const mine = original + '\nUnsaved local edit';
  storage.set('sink:unsaved:' + path, JSON.stringify({ base: 'original', text: mine }));
  current = { ...current, content: latest, hash: 'android' };
  await notes.openNote(path);
  expect(copies).toHaveLength(1);
  expect(copies[0].content).toBe(mine);
  expect(notes.openNoteInfo().text).toBe(latest);
  expect(storage.has('sink:unsaved:' + path)).toBe(false);
});

test('a failed conflict copy keeps the genuine draft for retry', async () => {
  const stash = JSON.stringify({ base: 'original', text: original + '\nUnsaved' });
  storage.set('sink:unsaved:' + path, stash);
  current = { ...current, content: latest, hash: 'android' };
  failCopy = true;
  await notes.openNote(path);
  expect(copies).toHaveLength(0);
  expect(notes.openNoteInfo().text).toBe(latest);
  expect(storage.get('sink:unsaved:' + path)).toBe(stash);
});

test('reverting an edit to saved text removes the draft, including an empty note', async () => {
  current = { ...current, content: '' };
  await notes.openNote(path);
  editor.setText('temporary edit');
  expect(storage.has('sink:unsaved:' + path)).toBe(true);
  editor.setText('');
  expect(storage.has('sink:unsaved:' + path)).toBe(false);
});
