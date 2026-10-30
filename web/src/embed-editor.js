// The note editor on its own, for the Android app's WebView. The app owns loading, saving and the network;
// this page only edits text and talks through `window.SinkBridge` (a JavascriptInterface):
//   SinkBridge.ready()                      page loaded, send a note
//   SinkBridge.changed(text)                text edited (debounced)
//   SinkBridge.openLink(target)             [[wikilink]] or url tapped
//   SinkBridge.pickImage()                  user wants to attach an image; reply with sink.insert(text)
//   SinkBridge.pickTemplate()               /template: user wants a template; reply with sink.template(text or null)
// The app drives it with:
//   sink.load({ text, dark, colors, links, line, plugins })   colors: { '--md-sys-color-primary': '#...', ... }
//     plugins: GET /api/plugins' list. Built-in ones are bundled here (so they work offline); others load from
//     https://sink.server/plugins/<id>/…, which the app fetches from the server with its token.
//   sink.setText(text)  sink.insert(text)  sink.getText()  sink.focus()
//   sink.format(kind)   the bar above the keyboard: h1, h2, h3, task, bullet, numbered, quote, bold, italic, strike,
//                       code, link, indent, outdent, undo, redo (see editor.js format)
//   sink.backlinks(items)   GET /api/notes/backlinks' items, shown under the note; tapping one calls openLink(path)
// Images (`![[x.png]]`) load from https://sink.attachment/<name>, which the app serves with its token.

import { backlinksHtml } from './backlinks.js';
import { createEditor } from './editor.js';
import { loadPlugins } from './plugin-api.js';
import { bundledPlugins } from './plugins/index.js';

const bridge = window.SinkBridge ?? {
  ready() {},
  changed() {},
  openLink() {},
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

const attachment = (ref) => `https://sink.attachment/${ref.split('/').map(encodeURIComponent).join('/')}`;

window.sink = {
  async load({ text = '', dark = false, colors = {}, links: targets = [], line = null, plugins = [] } = {}) {
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
      placeholder: 'Note',
      onChange: (t) => {
        clearTimeout(timer);
        timer = setTimeout(() => bridge.changed(t), 250);
      },
      onOpenLink: (target) => bridge.openLink(target),
      resolveEmbed: attachment,
      resolveImage: (src) => (/^(https?:|data:)/i.test(src) ? src : attachment(decodeURIComponent(src).replace(/^(\.\.\/)+/, ''))),
      linkTargets: () => links,
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
  backlinks(items = []) {
    const box = document.getElementById('links');
    box.hidden = !items.length;
    box.innerHTML = items.length ? backlinksHtml(items, { href: () => '#' }) : '';
  },
};

document.getElementById('links').addEventListener('click', (e) => {
  const a = e.target.closest('[data-path]');
  if (!a) return;
  e.preventDefault();
  bridge.openLink(a.dataset.path);
});

bridge.ready();
