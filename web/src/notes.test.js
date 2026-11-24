import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

let editor;
const create = (options) => {
  let text = options.doc;
  editor = {
    getText: () => text,
    setText(value) {
      text = value;
      options.onChange?.(value);
    },
    focus() {},
    destroy() {},
  };
  return editor;
};
mock.module('./editor.js', () => ({ createEditor: create }));
// Live editing needs a real CodeMirror view to connect; without one these tests cover saving the usual way.
mock.module('./live.js', () => ({
  liveSession: () => ({ extension: [], started: false, unavailable: false, start() {}, destroy() {} }),
  renderPeople() {},
}));

let notes;
let current;
let copies;
let failCopy;
let messages;
let storage;
const path = 'N23 Journal.md';
const original = '# N23 Journal\n\nOriginal body';
const pinned = '---\npinned: true\n---\n' + original;
const latest = pinned + '\nLATESTFROMANDROID';

beforeEach(async () => {
  storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
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
    const copy = { ...input, path: input.title + '.md', hash: 'copy' };
    copies.push(copy);
    return copy;
  };
  notes = await import(`./notes.js?test=${Math.random()}`);
  notes.initNotes({ toast: (message) => messages.push(message) });
});

afterEach(async () => {
  await notes.closeNote();
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
