// The note editor on its own, for the Android app's WebView. The app owns loading, saving and the network;
// this page only edits text and talks through `window.SinkBridge` (a JavascriptInterface):
//   SinkBridge.ready()                      page loaded, send a note
//   SinkBridge.changed(text)                text edited (debounced)
//   SinkBridge.openLink(target)             [[wikilink]] or url tapped
//   SinkBridge.linkMention(src, hash, start, text)   "Link" pressed on an unlinked mention; reply with sink.backlinks/mentions again
//   SinkBridge.pickImage()                  user wants to attach an image; reply with sink.insert(text)
//   SinkBridge.pickTemplate()               /template: user wants a template; reply with sink.template(text or null)
// The app drives it with:
//   sink.load({ text, dark, colors, links, line, plugins, board })   colors: { '--md-sys-color-primary': '#...', ... }
//     board: the text is an Excalidraw board (.excalidraw.md); it opens in Excalidraw instead of the text editor.
//     plugins: GET /api/plugins' list. Built-in ones are bundled here (so they work offline); others load from
//     https://sink.server/plugins/<id>/…, which the app fetches from the server with its token.
//   sink.setText(text)  sink.insert(text)  sink.getText()  sink.focus()
//   sink.format(kind)   the bar above the keyboard: heading, h1, h2, h3, task, bullet, numbered, quote, bold, italic, strike,
//                       code, link, indent, outdent, undo, redo (see editor.js format)
//   sink.backlinks(items)   GET /api/notes/backlinks' items, shown under the note; tapping one calls openLink(path)
//   sink.mentions(items)   GET /api/notes/mentions' items: unlinked mentions, a collapsed section after the backlinks
//   sink.inset(px)      how much of the page's bottom the app's floating toolbar covers; the cursor stays above it
// Images (`![[x.png]]`) load from https://sink.attachment/<name>, which the app serves with its token.

import { EditorView } from '@codemirror/view';
import { backlinksHtml, mentionsHtml, onLinkMention } from './backlinks.js';
import { createEditor } from './editor.js';
import { loadPlugins } from './plugin-api.js';
import { bundledPlugins } from './plugins/index.js';

const bridge = window.SinkBridge ?? {
  ready() {},
  changed() {},
  openLink() {},
  linkMention() {},
  pickImage() {},
};

// /template's answer from the app: the filled-in text, or null if the picker was closed.
let templateReply = null;
const pickTemplate = () =>
  new Promise((resolve) => {
    templateReply?.(null);
    templateReply = resolve;
    bridge.pickTemplate();
  });

let editor = null;
let links = [];
let timer = null;
let inset = 0;

const attachment = (ref) => `https://sink.attachment/${ref.split('/').map(encodeURIComponent).join('/')}`;

window.sink = {
  async load({ text = '', dark = false, colors = {}, links: targets = [], line = null, plugins = [], board = false } = {}) {
    if (board) return loadBoard(text, dark, colors);
    await loadPlugins(
      {
        list: async () => plugins,
        url: (path) => `https://sink.server${path}`,
        fetch: (path, init) => fetch(`https://sink.server${path}`, init),
        dark: () => dark,
      },
      bundledPlugins,
    );
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    for (const [k, v] of Object.entries(colors)) document.documentElement.style.setProperty(k, v);
    links = targets;
    editor?.destroy();
    editor = createEditor({
      parent: document.getElementById('editor'),
      doc: text,
      onChange: (t) => {
        clearTimeout(timer);
        timer = setTimeout(() => bridge.changed(t), 250);
      },
      onOpenLink: (target) => bridge.openLink(target),
      resolveEmbed: attachment,
      resolveImage: (src) => (/^(https?:|data:)/i.test(src) ? src : attachment(decodeURIComponent(src).replace(/^(\.\.\/)+/, ''))),
      linkTargets: () => links,
      bottomMargin: () => inset,
      // Only when the app can pick one (an older app has no pickTemplate, so the command stays hidden).
      pickTemplate: bridge.pickTemplate ? pickTemplate : undefined,
    });
    if (line != null) editor.goToLine(line);
    else if (!text.trim()) editor.focus(true);
  },
  setText(text) {
    editor?.setText(text);
  },
  insert(text) {
    if (!editor) return;
    const view = editor.view;
    const at = view.state.selection.main.head;
    const line = view.state.doc.lineAt(at);
    const insert = (line.length && at === line.to ? '\n' : '') + text + '\n';
    view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } });
    view.focus();
  },
  /** Flushes the pending change now (the app calls this before leaving the screen). */
  getText() {
    clearTimeout(timer);
    return editor?.getText() ?? '';
  },
  focus() {
    editor?.focus(true);
  },
  format(kind) {
    editor?.format(kind);
  },
  pickImage() {
    bridge.pickImage();
  },
  template(text) {
    templateReply?.(text);
    templateReply = null;
  },
  inset(px) {
    inset = px;
    // The toolbar comes back as the keyboard goes down, over where the cursor may be: bring it back into sight once
    // the page has its new height.
    const view = editor?.view;
    if (!view?.hasFocus) return;
    requestAnimationFrame(() => view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest' }) }));
  },
  backlinks(items = []) {
    linked = items;
    drawLinks();
  },
  mentions(items = []) {
    unlinked = items;
    drawLinks();
  },
};

let linked = [];
let unlinked = [];
function drawLinks() {
  const box = document.getElementById('links');
  const href = () => '#';
  box.innerHTML = (linked.length ? backlinksHtml(linked, { href }) : '') + mentionsHtml(unlinked, { href, open: box.querySelector('.unlinked')?.open });
  box.hidden = !box.innerHTML;
}

// Excalidraw and React only download (here: load from the APK) when a board opens. Its fonts are bundled too, bar
// the large CJK one, which falls back to the system's.
async function loadBoard(text, dark, colors) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  for (const [k, v] of Object.entries(colors)) document.documentElement.style.setProperty(k, v);
  document.body.classList.add('board');
  window.EXCALIDRAW_ASSET_PATH = '/excalidraw/';
  const { createBoard } = await import('./board.js');
  editor?.destroy();
  editor = createBoard({
    parent: document.getElementById('editor'),
    text,
    dark,
    attachmentUrl: attachment,
    // Boards only change on a stroke's end, and serializing the scene isn't free: send it a little less often.
    onChange: () => {
      clearTimeout(timer);
      timer = setTimeout(() => bridge.changed(editor.getText()), 500);
    },
  });
}

onLinkMention(document.getElementById('links'), (m) => bridge.linkMention(m.src, m.hash, m.start, m.text));
document.getElementById('links').addEventListener('click', (e) => {
  const a = e.target.closest('[data-path]');
  if (!a) return;
  e.preventDefault();
  bridge.openLink(a.dataset.path);
});

bridge.ready();
