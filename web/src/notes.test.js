import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import * as Y from 'yjs';

const realLiveSession = (await import('./live.js')).liveSession;
let useLive;
let livePlugin;
let liveView;

let editor;
const create = (options) => {
  let text = EditorState.create({ doc: options.doc }).doc.toString();
  if (useLive) {
    liveView = {
      state: EditorState.create({ doc: text, extensions: options.extensions }),
      dispatch(spec) {
        const transaction = this.state.update(spec);
        this.state = transaction.state;
        livePlugin.update({ transactions: [transaction], docChanged: transaction.docChanged, selectionSet: transaction.selection != null });
        if (transaction.docChanged) options.onChange?.(this.state.doc.toString());
      },
    };
    livePlugin = options.extensions.at(-1).create(liveView);
  }
  editor = {
    getText: () => useLive ? liveView.state.doc.toString() : text,
    setText(value) {
      if (useLive) return liveView.dispatch({ changes: { from: 0, to: liveView.state.doc.length, insert: value } });
      text = EditorState.create({ doc: value }).doc.toString();
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
let socket;
let room;
let firstCreate;
let statuses;
const path = 'N23 Journal.md';
const original = '# N23 Journal\n\nOriginal body';
const pinned = '---\npinned: true\n---\n' + original;
const latest = pinned + '\nLATESTFROMANDROID';

beforeEach(async () => {
  useLive = false;
  firstCreate = false;
  statuses = [];
  socket = room = null;
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
  globalThis.location = { hash: '#/n/N23%20Journal.md', href: 'http://localhost/' };
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
// The server end of the live socket: a Yjs document made from the note when the socket opens (`hello`).
class FakeSocket {
  static OPEN = 1;
  constructor() {
    this.readyState = 0;
    socket = this;
  }
  send(data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.t === 'save') toClient({ t: 'saved', hash: current.hash, dirty: false });
      return;
    }
    const payload = data.subarray(1);
    if (data[0] === 0) toClient(frame(1, Y.encodeStateAsUpdate(room, payload)));
    else {
      Y.applyUpdate(room, payload, 'client');
      toClient({ t: 'ack' });
    }
  }
  close() {
    this.readyState = 3;
  }
}
const frame = (type, payload) => new Uint8Array([type, ...payload]);
// Delivered in order, after whatever is running now (as a socket would).
function toClient(msg) {
  const data = msg instanceof Uint8Array ? msg.slice().buffer : JSON.stringify(msg);
  queueMicrotask(() => socket.readyState === 1 && socket.onmessage({ data }));
}
function liveStream() {
  globalThis.WebSocket = FakeSocket;
}
function hello() {
  room = new Y.Doc();
  room.getText('t').insert(0, current.content.replace(/\r\n?/g, '\n'));
  room.on('update', (update, origin) => origin !== 'client' && toClient(frame(2, update)));
  socket.readyState = 1;
  toClient({ t: 'hello', guid: room.guid, hash: current.hash, dirty: false, editor: true });
  toClient(frame(0, Y.encodeStateVector(room)));
}
/** Someone else's edit, through the server. */
function remoteInsert(at, text) {
  room.getText('t').insert(at, text);
  toClient({ t: 'dirty' });
}

test('connected live updates and saved notifications still replace the note without making a draft', async () => {
  useLive = true;
  liveStream();
  await notes.openNote(path);
  hello();
  await tick();
  const addition = '\nCo-edited';
  remoteInsert(original.length, addition);
  await tick();
  expect(notes.openNoteInfo().text).toBe(original + addition);
  expect(statuses.at(-1)).toBe('Saving…');
  toClient({ t: 'saved', hash: 'co-edited', dirty: false });
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

test('offline reopen keeps the last live save and its unsaved draft through Back until reconnect', async () => {
  useLive = true;
  liveStream();
  const { api } = await import('./api.js');
  await notes.openNote(path);
  hello();
  await tick();
  const added = '\nSaved while live';
  remoteInsert(original.length, added);
  await tick();
  current = { ...current, content: original + added, hash: 'live-save' };
  toClient({ t: 'saved', hash: current.hash, dirty: false });
  await tick();
  api.note = async () => { throw new TypeError('Failed to fetch'); };
  socket.close();
  socket.onclose();
  await notes.closeNote();
  await notes.openNote(path);
  expect(notes.openNoteInfo().text).toBe(current.content);

  const mine = current.content + '\nTyped offline';
  editor.setText(mine);
  await notes.closeNote();
  await notes.openNote(path);
  expect(notes.openNoteInfo().text).toBe(mine);
  await notes.closeNote();
  await notes.openNote(path);
  expect(notes.openNoteInfo().text).toBe(mine);
  expect(JSON.parse(storage.get('sink:unsaved:' + path))).toMatchObject({ base: current.hash, text: mine });

  hello();
  await tick();
  expect(room.getText('t').toString()).toBe(mine);
  toClient({ t: 'saved', hash: 'after-reconnect', dirty: false });
  await tick();
  expect(copies).toHaveLength(0);
  expect(storage.has('sink:unsaved:' + path)).toBe(false);
});

test('a note deleted on the server does not reopen from a previously saved revision', async () => {
  const { api, ApiError } = await import('./api.js');
  await notes.openNote(path);
  await notes.closeNote();
  api.note = async () => { throw new ApiError(404); };
  await notes.openNote(path);
  expect(notes.openNoteInfo().open).toBe(false);
  expect(messages.at(-1)).toBe('That note is gone');
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

test('a remote edit before the first live hello leaves the already saved creation text alone', async () => {
  useLive = true;
  firstCreate = true;
  liveStream();
  await notes.openDraft();
  editor.setText(original);
  await notes.saveForReload();
  current = { ...current, content: original + '\nAndroid', hash: 'android' };
  hello();
  await tick();
  expect(copies).toHaveLength(0);
  expect(notes.openNoteInfo().text).toBe(current.content);
});

test('a genuine local edit before the first connection is merged with a remote edit', async () => {
  useLive = true;
  liveStream();
  await notes.openNote(path);
  const mine = original + '\nLocal';
  editor.setText(mine);
  expect(JSON.parse(storage.get('sink:unsaved:' + path)).text).toBe(mine);
  current = { ...current, content: original + '\nAndroid', hash: 'android' };
  hello();
  await tick();
  expect(copies).toHaveLength(0);
  expect(notes.openNoteInfo().text).toBe(original + '\nLocal\nAndroid');
  expect(room.getText('t').toString()).toBe(original + '\nLocal\nAndroid');
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
  current = { ...current, content: original + '\nAndroid', hash: 'android' };
  hello();
  await tick();
  expect(room.getText('t').toString()).toBe(mine + '\nAndroid');
  expect(copies).toHaveLength(0);
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
  expect(room.getText('t').toString()).toBe(mine);
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
  toClient({ t: 'saved', hash: current.hash, dirty: false });
  await tick();
  expect(storage.get('sink:unsaved:' + path)).toBe(stash);
  await notes.closeNote();
  failCopy = false;
  await notes.openNote(path);
  expect(copies).toHaveLength(1);
  expect(copies[0].content).toBe(JSON.parse(stash).text);
});

test('saving typing over a live note keeps a failed conflict copy for retry', async () => {
  useLive = true;
  liveStream();
  const stash = JSON.stringify({ base: 'original', text: original + '\nUnsaved offline edit' });
  storage.set('sink:unsaved:' + path, stash);
  current = { ...current, content: latest, hash: 'android' };
  failCopy = true;
  await notes.openNote(path);
  hello();
  await tick();
  editor.setText(latest + '\nTyped live');
  await tick();
  expect(room.getText('t').toString()).toBe(latest + '\nTyped live');
  expect(await notes.saveForReload()).toBe(true);
  expect(storage.get('sink:unsaved:' + path)).toBe(stash);
});

test('a stash written over a failed conflict copy is cleared once live editing saves it', async () => {
  useLive = true;
  liveStream();
  storage.set('sink:unsaved:' + path, JSON.stringify({ base: 'original', text: original + '\nUnsaved offline edit' }));
  current = { ...current, content: latest, hash: 'android' };
  failCopy = true;
  await notes.openNote(path);
  hello();
  await tick();
  // What typing offline here stashes in its place.
  storage.set('sink:unsaved:' + path, JSON.stringify({ base: 'android', text: latest + '\nOffline here' }));
  toClient({ t: 'saved', hash: 'merged', dirty: false });
  await tick();
  expect(storage.has('sink:unsaved:' + path)).toBe(false);
});

test('an untouched CRLF note closed before hello leaves no draft or later conflict copy', async () => {
  useLive = true;
  liveStream();
  current = { ...current, content: original.replace(/\n/g, '\r\n') };
  await notes.openNote(path);
  expect(notes.openNoteInfo().text).toBe(original);
  await notes.closeNote();
  expect(storage.has('sink:unsaved:' + path)).toBe(false);
  current = { ...current, content: original + '\nAndroid', hash: 'android' };
  await notes.openNote(path);
  expect(copies).toHaveLength(0);
});

test('an untouched CRLF note takes a remote change made before hello as it is', async () => {
  useLive = true;
  liveStream();
  current = { ...current, content: original.replace(/\n/g, '\r\n') };
  await notes.openNote(path);
  current = { ...current, content: original + '\nAndroid', hash: 'android' };
  hello();
  await tick();
  expect(room.getText('t').toString()).toBe(current.content);
  expect(copies).toHaveLength(0);
  expect(notes.openNoteInfo().text).toBe(current.content);
});

test('fallback saving also treats an untouched CRLF note as clean', async () => {
  current = { ...current, content: original.replace(/\n/g, '\r\n') };
  const writes = [];
  const { api } = await import('./api.js');
  api.saveNote = async (_path, text) => {
    writes.push(text);
    return { hash: 'written' };
  };
  await notes.openNote(path);
  await notes.closeNote();
  expect(writes).toEqual([]);
  expect(storage.has('sink:unsaved:' + path)).toBe(false);
});

test('a saved LF stash equal to a CRLF server note is not a conflict', async () => {
  useLive = true;
  liveStream();
  current = { ...current, content: original.replace(/\n/g, '\r\n'), hash: 'crlf' };
  storage.set('sink:unsaved:' + path, JSON.stringify({ base: 'original', text: original }));
  await notes.openNote(path);
  expect(copies).toHaveLength(0);
  expect(storage.has('sink:unsaved:' + path)).toBe(false);
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
