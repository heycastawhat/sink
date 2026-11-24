import { beforeEach, expect, mock, test } from 'bun:test';

let plugins;
let sequence = 0;
let sink;
let type;
let change;
const create = (options) => {
  let text = options.doc ?? options.text;
  type = (value) => { text = value; options.onChange(value); };
  return { getText: () => text, setText: (value) => (text = value), destroy() {} };
};
mock.module('./editor.js', () => ({ createEditor: create }));
mock.module('./board.js', () => ({ createBoard: create }));
const pluginApi = await import('./plugin-api.js');
mock.module('./plugin-api.js', () => ({ ...pluginApi, loadPlugins: () => plugins() }));
mock.module('./plugins/index.js', () => ({ bundledPlugins: {} }));
mock.module('./backlinks.js', () => ({ backlinksHtml() {}, mentionsHtml() {}, onLinkMention() {} }));

beforeEach(async () => {
  plugins = async () => {};
  const element = { addEventListener() {}, style: { setProperty() {} }, classList: { add() {} } };
  globalThis.document = { getElementById: () => element, documentElement: { dataset: {}, style: element.style }, body: element };
  globalThis.window = { SinkBridge: { ready() {}, changed: (text) => change?.(text) } };
  change = null;
  await import(`./embed-editor.js?test=${++sequence}`);
  sink = window.sink;
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

test('reading without flushing leaves the pending change notification scheduled', async () => {
  expect(sink.textOrNull({ flush: false })).toBeNull();
  await sink.load({ text: original });
  const changed = new Promise((resolve) => { change = resolve; });
  type(pinned);
  expect(sink.textOrNull({ flush: false })).toBe(pinned);
  expect(await changed).toBe(pinned);
});
