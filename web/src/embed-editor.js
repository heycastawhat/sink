// The note editor on its own, for the Android app's WebView. The app owns loading, saving and the network;
// this page only edits text and talks through `window.SinkBridge` (a JavascriptInterface):
//   SinkBridge.ready()                      page loaded, send a note
//   SinkBridge.changed(text)                text edited (debounced)
//   SinkBridge.openLink(target)             [[wikilink]] or url tapped
//   SinkBridge.pickImage()                  user wants to attach an image; reply with sink.insert(text)
// The app drives it with:
//   sink.load({ text, dark, colors, links, line, plugins })   colors: { '--md-sys-color-primary': '#...', ... }
//     plugins: GET /api/plugins' list. Built-in ones are bundled here (so they work offline); others load from
//     https://sink.server/plugins/<id>/…, which the app fetches from the server with its token.
//   sink.setText(text)  sink.insert(text)  sink.getText()  sink.focus()
// Images (`![[x.png]]`) load from https://sink.attachment/<name>, which the app serves with its token.

import { createEditor } from './editor.js';
import { loadPlugins } from './plugin-api.js';
import { bundledPlugins } from './plugins/index.js';

const bridge = window.SinkBridge ?? {
  ready() {},
  changed() {},
  openLink() {},
  pickImage() {},
};

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
  pickImage() {
    bridge.pickImage();
  },
};

bridge.ready();
