import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { EditorState, Facet } from '@codemirror/state';
import * as Y from 'yjs';

const liveModule = await import('./live.js?android-test');
const livePlugin = Facet.define({ combine: (plugins) => plugins[0] });
let useLive = false;

let plugins;
let sequence = 0;
let sink;
let rootStyles;
let type;
let change;
const create = (options) => {
  if (useLive) {
    const view = {
      state: EditorState.create({ doc: options.doc, extensions: options.extensions }),
      dispatch(spec) {
        const previous = this.state.facet(livePlugin);
        const tr = this.state.update(spec);
        this.state = tr.state;
        const next = this.state.facet(livePlugin);
        if (previous !== next) {
          plugin?.destroy();
          plugin = next?.create(this);
        } else plugin?.update({ transactions: [tr], docChanged: tr.docChanged, selectionSet: tr.selection != null });
      },
    };
    let plugin = view.state.facet(livePlugin)?.create(view);
    const getText = () => view.state.doc.toString();
    type = (insert) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert } });
    return { view, getText, setText: type, destroy: () => plugin?.destroy() };
  }
  const asEditorText = (text) => options.doc == null ? text : EditorState.create({ doc: text }).doc.toString();
  let text = asEditorText(options.doc ?? options.text);
  type = (value) => {
    text = asEditorText(value);
    options.onChange?.(text);
  };
  return { getText: () => text, setText: type, destroy() {} };
};
mock.module('./board.js', () => ({ createBoard: create }));
const pluginApi = await import('./plugin-api.js');
mock.module('./plugin-api.js', () => ({ ...pluginApi, loadPlugins: () => plugins() }));
mock.module('./plugins/index.js', () => ({ bundledPlugins: {} }));
mock.module('./backlinks.js', () => ({ backlinksHtml() {}, mentionsHtml() {}, onLinkMention() {} }));

beforeEach(async () => {
  mock.module('./editor.js', () => ({ createEditor: create }));
  useLive = false;
  plugins = async () => {};
  rootStyles = new Map();
  const element = { addEventListener() {}, style: { setProperty: (key, value) => rootStyles.set(key, value) }, classList: { add() {} } };
  globalThis.document = { getElementById: () => element, documentElement: { dataset: {}, style: element.style }, body: element };
  globalThis.window = Object.assign(new EventTarget(), {
    innerHeight: 800,
    SinkBridge: { ready() {}, changed: (text) => change?.(text) },
  });
  change = null;
  await import(`./embed-editor.js?test=${++sequence}`);
  sink = window.sink;
});

afterEach(() => {
  if (useLive) sink.retireLive();
});

test('image height follows the measured viewport, ignoring transient zero-height resizes', () => {
  const cap = '--editor-image-max-height';
  expect(rootStyles.get(cap)).toBe('560px');

  window.innerHeight = 0;
  window.dispatchEvent(new Event('resize'));
  expect(rootStyles.get(cap)).toBe('560px');

  window.innerHeight = 400;
  window.dispatchEvent(new Event('resize'));
  expect(rootStyles.get(cap)).toBe('280px');
});

const original = '---\ncolor: green\n---\nRemember to walk today.\n';
const pinned = '---\ncolor: green\npinned: true\n---\nRemember to walk today.\n';
const blue = '---\ncolor: blue\n---\nRemember to walk today.\n';

async function delayed(updates) {
  let finish;
  plugins = () => new Promise((resolve) => (finish = resolve));
  const loading = sink.load({ text: original });
  expect(sink.textOrNull()).toBeNull();
  for (const text of updates) sink.setText(text);
  finish();
  await loading;
  return sink.textOrNull();
}

test('pin changed while plugins load is the text the editor starts with', async () => {
  expect(await delayed([pinned])).toBe(pinned);
});

test('colour changed while plugins load survives initialization', async () => {
  expect(await delayed([blue])).toBe(blue);
});

test('the latest replacement wins, including an intentionally empty note', async () => {
  expect(await delayed([pinned, blue, ''])).toBe('');
});

test('a replacement received before load is not overwritten by its payload', async () => {
  sink.setText(blue);
  await sink.load({ text: original });
  expect(sink.getText()).toBe(blue);
});

test('a ready editor still accepts replacements and the next load has its own text', async () => {
  await sink.load({ text: original });
  sink.setText(pinned);
  expect(sink.textOrNull()).toBe(pinned);
  await sink.load({ text: blue });
  expect(sink.textOrNull()).toBe(blue);
});

test('a board awaiting its lazy import keeps replacement frontmatter too', async () => {
  const loading = sink.load({ text: original, board: true });
  sink.setText(pinned);
  await loading;
  expect(sink.textOrNull()).toBe(pinned);
});

test('a failed initialization does not consume the pending replacement', async () => {
  plugins = async () => { throw new Error('initialization failed'); };
  const loading = sink.load({ text: original });
  sink.setText(blue);
  await expect(loading).rejects.toThrow('initialization failed');
  plugins = async () => {};
  await sink.load({ text: original });
  expect(sink.textOrNull()).toBe(blue);
});

test('back without edits reads the original CRLF bytes, but a real edit is returned', async () => {
  const crlf = original.replaceAll('\n', '\r\n');
  await sink.load({ text: crlf });
  expect(sink.textOrNull({ flush: false })).toBe(crlf);
  expect(sink.textOrNull()).toBe(crlf);
  type(original + 'Another line.\n');
  expect(sink.textOrNull()).toBe(original + 'Another line.\n');
});

test('replacing an open note with CRLF text does not report a line-ending-only edit', async () => {
  await sink.load({ text: original });
  const crlf = pinned.replaceAll('\n', '\r\n');
  const sent = new Promise((resolve) => { change = resolve; });
  sink.setText(crlf);
  expect(await sent).toBe(crlf);
  expect(sink.textOrNull()).toBe(crlf);
});

test('reading without flushing leaves the pending change notification scheduled', async () => {
  expect(sink.textOrNull({ flush: false })).toBeNull();
  await sink.load({ text: original });
  const changed = new Promise((resolve) => { change = resolve; });
  type(pinned);
  expect(sink.textOrNull({ flush: false })).toBe(pinned);
  expect(await changed).toBe(pinned);
});

const path = 'Scratch note.md';
const args = { path, saved: original, hash: 'before-trash' };
async function openLive() {
  useLive = true;
  mock.module('./live.js', () => ({
    ...liveModule,
    liveSession(options) {
      const session = liveModule.liveSession(options);
      session.extension.push(livePlugin.of(session.extension.at(-1)));
      return session;
    },
  }));
  globalThis.location = { href: 'https://sink.editor/editor.html' };
  globalThis.WebSocket = { OPEN: 1 };
  const states = [];
  const urls = [];
  const frames = [];
  Object.assign(window.SinkBridge, {
    live: (raw) => states.push(JSON.parse(raw)),
    liveOpen: (url) => urls.push(url),
    liveClose() {},
    liveSend() {},
    liveSendBinary: (b64) => frames.push(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
  });
  await sink.load({ path, text: original, live: args });
  const room = new Y.Doc({ guid: 'original-note' });
  room.getText('t').insert(0, original);
  const hello = (guid, hash = args.hash) => {
    sink.live.opened();
    sink.live.text(JSON.stringify({ t: 'hello', guid, hash, dirty: false, editor: true }));
  };
  const receive = (tag, payload) => sink.live.binary(btoa(String.fromCharCode(tag, ...payload)));
  hello(room.guid);
  receive(1, Y.encodeStateAsUpdate(room));
  expect(states.at(-1)).toMatchObject({ bound: true, status: 'Saved' });
  return { room, hello, receive, states, urls, frames };
}

test('an open Android editor is deleted while in Trash and rejoins the same live document after restore', async () => {
  const { room, hello, receive, states, urls, frames } = await openLive();
  sink.live.text('{"t":"gone"}');
  expect(states.at(-1)).toMatchObject({ gone: true, canResume: true, status: 'Deleted elsewhere' });
  sink.retireLive();
  expect(sink.getText()).toBe(original);
  sink.resumeLive(args);
  await Promise.resolve();
  expect(urls).toEqual(Array(2).fill('/api/live?path=Scratch%20note.md'));
  const restored = original + 'Changed before rejoining\n';
  room.getText('t').insert(original.length, 'Changed before rejoining\n');
  hello(room.guid, 'restored');
  receive(1, Y.encodeStateAsUpdate(room));
  expect(states.at(-1)).toMatchObject({ gone: false, bound: true, status: 'Saved', hash: 'restored', saved: restored });

  const vector = Y.encodeStateVector(room);
  room.getText('t').insert(restored.length, 'From the web\n');
  receive(2, Y.encodeStateAsUpdate(room, vector));
  expect(sink.getText()).toBe(restored + 'From the web\n');
  type(sink.getText() + 'From Android\n');
  Y.applyUpdate(room, frames.at(-1).subarray(1));
  expect(room.getText('t').toString()).toBe(restored + 'From the web\nFrom Android\n');
});

test('the Android editor does not sync with a replacement, or probe after typing has already resumed', async () => {
  const { hello, states, urls, frames } = await openLive();
  sink.live.text('{"t":"gone"}');
  sink.retireLive();
  sink.resumeLive(args);
  await Promise.resolve();
  const sent = frames.length;
  hello('replacement-note');
  expect(states.at(-1)).toMatchObject({ gone: true, status: 'Deleted elsewhere' });
  expect(frames).toHaveLength(sent);
  sink.retireLive();
  type(original + 'New typing');
  sink.resumeLive(args);
  expect(states.at(-1).gone).toBe(true);
  expect(sink.getText()).toBe(original + 'New typing');
  expect(urls).toHaveLength(2);
});
