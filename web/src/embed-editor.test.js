import { beforeEach, expect, mock, test } from 'bun:test';
import { EditorState } from '@codemirror/state';

let plugins;
let sequence = 0;
let sink;
let rootStyles;
let type;
let change;
let created;
const create = (options) => {
  created = options;
  const asEditorText = (text) => options.doc == null ? text : EditorState.create({ doc: text }).doc.toString();
  let text = asEditorText(options.doc ?? options.text);
  type = (value) => {
    text = asEditorText(value);
    options.onChange?.(text);
  };
  return { getText: () => text, setText: type, destroy() {} };
};
mock.module('./editor.js', () => ({ createEditor: create }));
mock.module('./board.js', () => ({ createBoard: create }));
const pluginApi = await import('./plugin-api.js');
mock.module('./plugin-api.js', () => ({ ...pluginApi, loadPlugins: () => plugins() }));
mock.module('./plugins/index.js', () => ({ bundledPlugins: {} }));
mock.module('./backlinks.js', () => ({ backlinksHtml() {}, mentionsHtml() {}, onLinkMention() {} }));

beforeEach(async () => {
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

test('an image pasted into the page goes to the app to upload, and its embed comes back', async () => {
  const sent = [];
  window.SinkBridge.uploadImage = (...args) => sent.push(args);
  await sink.load({ text: original });
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
  const upload = created.uploadFile(new File([bytes], 'image.png', { type: 'image/png' }));
  await new Promise((resolve) => setTimeout(resolve));
  const [[id, name, mime, base64]] = sent;
  expect([name, mime]).toEqual(['image.png', 'image/png']);
  expect(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))).toEqual(bytes);
  sink.uploaded(id, '![[image.png]]');
  expect(await upload).toBe('![[image.png]]');
});

test('a failed upload rejects with the app\u2019s reason', async () => {
  const sent = [];
  window.SinkBridge.uploadImage = (...args) => sent.push(args);
  await sink.load({ text: original });
  const upload = created.uploadFile(new File([new Uint8Array([1])], '', { type: '' }));
  await new Promise((resolve) => setTimeout(resolve));
  expect(sent[0].slice(1, 3)).toEqual(['image', 'image/png']);
  sink.uploaded(sent[0][0], null, 'Upload failed');
  await expect(upload).rejects.toThrow('Upload failed');
});

test('an app that cannot upload gets no uploader, so a pasted image is left to the browser', async () => {
  await sink.load({ text: original });
  expect(created.uploadFile).toBeUndefined();
});
