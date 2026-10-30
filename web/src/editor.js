// Markdown editor shared by the web app and the Android note screen.
// CodeMirror edits the raw text (files are the truth, and Obsidian edits them too), with Obsidian-style live preview:
// markup hides on lines the cursor isn't on, checkboxes tick, `![[images]]` show, `[[links]]` open.

import { EditorState, RangeSetBuilder, StateField, Transaction } from '@codemirror/state';
import {
  EditorView,
  Decoration,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder as placeholderExt,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxTree, syntaxHighlighting, HighlightStyle, indentOnInput, indentUnit } from '@codemirror/language';
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, acceptCompletion } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import './editor.css';
import { registry } from './plugin-api.js';

const highlight = HighlightStyle.define([
  { tag: t.heading1, class: 'cm-h1' },
  { tag: t.heading2, class: 'cm-h2' },
  { tag: t.heading3, class: 'cm-h3' },
  { tag: t.heading4, class: 'cm-h4' },
  { tag: t.heading5, class: 'cm-h5' },
  { tag: t.heading6, class: 'cm-h6' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, class: 'cm-link' },
  { tag: t.url, class: 'cm-url' },
  { tag: t.monospace, class: 'cm-mono' },
  { tag: [t.processingInstruction, t.meta], class: 'cm-meta' },
  { tag: t.contentSeparator, class: 'cm-meta' },
]);

// Syntax nodes whose characters are markup, hidden when the cursor is elsewhere.
const HIDE = new Set(['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'QuoteMark']);

class CheckboxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }
  eq(other) {
    return other.checked === this.checked;
  }
  toDOM() {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-task';
    box.checked = this.checked;
    box.setAttribute('aria-label', this.checked ? 'Done' : 'To do');
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-bullet';
    s.textContent = '•';
    return s;
  }
}

class ImageWidget extends WidgetType {
  constructor(src, alt) {
    super();
    this.src = src;
    this.alt = alt;
  }
  eq(other) {
    return other.src === this.src;
  }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-embed';
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.loading = 'lazy';
    img.onerror = () => wrap.classList.add('broken');
    wrap.append(img);
    return wrap;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const hr = document.createElement('span');
    hr.className = 'cm-hr';
    return hr;
  }
}

const CALLOUT_ICONS = {
  note: 'edit', info: 'info', tip: 'lightbulb', hint: 'lightbulb', important: 'priority_high', success: 'check_circle',
  check: 'check_circle', done: 'check_circle', question: 'help', help: 'help', faq: 'help', warning: 'warning',
  caution: 'warning', attention: 'warning', failure: 'cancel', fail: 'cancel', missing: 'cancel', danger: 'bolt',
  error: 'bolt', bug: 'bug_report', example: 'list', quote: 'format_quote', cite: 'format_quote', abstract: 'summarize',
  summary: 'summarize', tldr: 'summarize', todo: 'check_box',
};

class CalloutLabel extends WidgetType {
  constructor(type, title) {
    super();
    this.type = type;
    this.title = title;
  }
  eq(other) {
    return other.type === this.type && other.title === this.title;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-callout-label';
    s.textContent = this.title;
    return s;
  }
}

/** Obsidian's Properties block: frontmatter shown as a small table until the cursor goes into it. */
class PropertiesWidget extends WidgetType {
  constructor(yaml) {
    super();
    this.yaml = yaml;
  }
  eq(other) {
    return other.yaml === this.yaml;
  }
  toDOM() {
    const box = document.createElement('div');
    box.className = 'cm-properties';
    const rows = [];
    for (const line of this.yaml.split('\n')) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line);
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (kv) rows.push([kv[1], kv[2] ? [kv[2]] : []]);
      else if (item && rows.length) rows[rows.length - 1][1].push(item[1]);
    }
    for (const [key, values] of rows) {
      const row = document.createElement('div');
      row.className = 'cm-prop';
      const k = document.createElement('span');
      k.className = 'cm-prop-key';
      k.textContent = key;
      const v = document.createElement('span');
      v.className = 'cm-prop-value';
      const list = values.length === 1 && /^\[.*\]$/.test(values[0]) ? values[0].slice(1, -1).split(',') : values;
      if (key === 'tags' || key === 'aliases' || list.length > 1) {
        for (const item of list.map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)) {
          const pill = document.createElement('span');
          pill.className = 'cm-prop-pill';
          pill.textContent = item;
          v.append(pill);
        }
      } else v.textContent = (list[0] ?? '').replace(/^["']|["']$/g, '');
      row.append(k, v);
      box.append(row);
    }
    if (!rows.length) box.textContent = 'Properties';
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

// Block widgets have to come from a state field, not a view plugin.
const properties = StateField.define({
  create: (state) => propertiesDeco(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? propertiesDeco(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

function propertiesDeco(state) {
  const end = frontmatterEnd(state);
  if (!end) return Decoration.none;
  // Editing inside it: show the raw YAML.
  if (state.selection.ranges.some((r) => r.from <= end)) return Decoration.none;
  const yaml = state.sliceDoc(state.doc.line(1).to + 1, state.doc.lineAt(end).from - 1);
  return Decoration.set([Decoration.replace({ widget: new PropertiesWidget(yaml), block: true }).range(0, end)]);
}

/** A code block a plugin renders (```mermaid, ```math…), shown in place of the fenced text while the cursor is away. */
class PluginBlockWidget extends WidgetType {
  constructor(lang, source) {
    super();
    this.lang = lang;
    this.source = source;
  }
  eq(other) {
    return other.lang === this.lang && other.source === this.source;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = `cm-plugin-block cm-plugin-${this.lang}`;
    el.title = 'Click to edit';
    const entry = registry.codeBlocks.get(this.lang);
    const dark = document.documentElement.dataset.theme === 'dark' || !!document.querySelector('m3e-theme[scheme="dark"]') ||
      (!document.querySelector('m3e-theme[scheme="light"]') && matchMedia('(prefers-color-scheme: dark)').matches);
    const fail = (err) => {
      el.classList.add('cm-plugin-error');
      el.textContent = `${this.lang}: ${err?.message ?? err}`;
    };
    try {
      Promise.resolve(entry?.render(this.source, el, { dark })).catch(fail);
    } catch (err) {
      fail(err);
    }
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

function pluginBlocksDeco(state) {
  if (!registry.codeBlocks.size) return Decoration.none;
  const ranges = [];
  const sel = state.selection.ranges;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return;
      let lang = '';
      let body = null;
      const c = node.node.cursor();
      if (c.firstChild()) {
        do {
          if (c.name === 'CodeInfo') lang = state.sliceDoc(c.from, c.to).trim().toLowerCase();
          if (c.name === 'CodeText') body = [c.from, c.to];
        } while (c.nextSibling());
      }
      if (!registry.codeBlocks.has(lang)) return false;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      // Editing inside it (or right at its edges): show the source.
      if (sel.some((r) => r.to >= from && r.from <= to)) return false;
      const source = body ? state.sliceDoc(body[0], body[1]) : '';
      ranges.push(Decoration.replace({ widget: new PluginBlockWidget(lang, source), block: true }).range(from, to));
      return false;
    },
  });
  return Decoration.set(ranges);
}

// Block widgets have to come from a state field; the parse tree growing in the background also refreshes it.
const pluginBlocks = StateField.define({
  create: (state) => pluginBlocksDeco(state),
  update: (deco, tr) =>
    tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? pluginBlocksDeco(tr.state) : deco,
  provide: (f) => EditorView.decorations.from(f),
});

/** What a slash command gets to work with. */
function commandContext(view, opts) {
  return {
    view,
    note: opts.note?.() ?? null,
    /** Inserts text at the cursor (on its own line if it starts with a block like ``` or - [ ]). */
    insert(text) {
      const at = view.state.selection.main.head;
      view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, scrollIntoView: true });
      view.focus();
    },
    text: () => view.state.doc.toString(),
  };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|heic)$/i;

/** Lines that hold a cursor or selection show their raw markup. */
function activeLines(state) {
  const lines = new Set();
  for (const r of state.selection.ranges) {
    const from = state.doc.lineAt(r.from).number;
    const to = state.doc.lineAt(r.to).number;
    for (let n = from; n <= to; n++) lines.add(n);
  }
  return lines;
}

function livePreview(opts) {
  const build = (view) => {
    const { state } = view;
    const active = view.hasFocus ? activeLines(state) : new Set();
    const ranges = [];
    const add = (from, to, deco) => ranges.push({ from, to, deco });
    const lineOf = (pos) => state.doc.lineAt(pos).number;

    // YAML frontmatter isn't markdown (its closing --- would read as a heading underline): show it as quiet properties.
    const fmEnd = frontmatterEnd(state);
    for (let pos = 0; pos < fmEnd; ) {
      const line = state.doc.lineAt(pos);
      add(line.from, line.from, Decoration.line({ class: 'cm-fm' }));
      pos = line.to + 1;
    }

    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({
        from: Math.max(from, fmEnd),
        to,
        enter(node) {
          const name = node.name;
          if (node.from < fmEnd) return;
          const onActive = active.has(lineOf(node.from));
          if (name === 'TaskMarker') {
            const checked = /\[[xX]\]/.test(state.sliceDoc(node.from, node.to));
            const line = state.doc.lineAt(node.from);
            if (checked) add(line.from, line.from, Decoration.line({ class: 'cm-task-done' }));
            add(node.from, node.to, Decoration.replace({ widget: new CheckboxWidget(checked) }));
            return;
          }
          if (name === 'FencedCode') {
            // A shaded box, with the ``` fences hidden unless the cursor is somewhere in the block.
            const first = lineOf(node.from);
            const last = lineOf(node.to);
            let blockActive = false;
            for (let n = first; n <= last; n++) if (active.has(n)) blockActive = true;
            for (let n = first; n <= last; n++) {
              const line = state.doc.line(n);
              const cls = `cm-codeblock${n === first ? ' cm-codeblock-first' : ''}${n === last ? ' cm-codeblock-last' : ''}`;
              add(line.from, line.from, Decoration.line({ class: cls }));
            }
            if (!blockActive) {
              const c = node.node.cursor();
              if (c.firstChild()) {
                do {
                  if (c.name === 'CodeMark' || c.name === 'CodeInfo') add(c.from, c.to, Decoration.replace({}));
                } while (c.nextSibling());
              }
            }
            return false;
          }
          if (name === 'Blockquote') {
            const first = state.doc.lineAt(node.from);
            const callout = /^>\s*\[!(\w+)\]([+-]?)\s*(.*)$/.exec(first.text);
            const lastLine = lineOf(node.to);
            for (let n = first.number; n <= lastLine; n++) {
              const line = state.doc.line(n);
              const type = callout && (CALLOUT_ICONS[callout[1].toLowerCase()] ? callout[1].toLowerCase() : 'note');
              const cls = callout
                ? `cm-callout cm-callout-${type}${n === first.number ? ' cm-callout-first' : ''}${n === lastLine ? ' cm-callout-last' : ''}`
                : 'cm-blockquote';
              add(line.from, line.from, Decoration.line({ class: cls }));
            }
            if (callout && !active.has(first.number)) {
              // `> [!warning] Title` -> the title, or the type's name when there isn't one.
              const markerStart = first.from + first.text.indexOf('[!');
              const markerEnd = first.from + first.text.indexOf(']', markerStart - first.from) + 1 + callout[2].length;
              const label = callout[3] ? '' : callout[1][0].toUpperCase() + callout[1].slice(1).toLowerCase();
              add(markerStart, Math.min(markerEnd + (callout[3] ? 1 : 0), first.to), label ? Decoration.replace({ widget: new CalloutLabel(callout[1], label) }) : Decoration.replace({}));
            }
            return;
          }
          if (onActive) return;
          if (name === 'HorizontalRule') {
            add(node.from, node.to, Decoration.replace({ widget: new RuleWidget() }));
            return false;
          }
          if (HIDE.has(name)) {
            // A heading's `# ` takes its trailing space with it.
            const end = name === 'HeaderMark' && state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            const endQ = name === 'QuoteMark' && state.sliceDoc(end, end + 1) === ' ' ? end + 1 : end;
            if (endQ > node.from) add(node.from, endQ, Decoration.replace({}));
            return;
          }
          if (name === 'ListMark') {
            const mark = state.sliceDoc(node.from, node.to);
            // A task's `-` stays out of the way; plain bullets become dots.
            const isTask = /^\s*\[[ xX]\]/.test(state.sliceDoc(node.to + 1, node.to + 5));
            if (isTask) add(node.from, Math.min(node.to + 1, state.doc.length), Decoration.replace({}));
            else if (/^[-*+]$/.test(mark)) add(node.from, node.to, Decoration.replace({ widget: new BulletWidget() }));
            return;
          }
          // `[[wikilink]]` parses as a link inside brackets; the wikilink pass below handles it.
          if (name === 'Link' && state.sliceDoc(node.from - 1, node.from) === '[' && state.sliceDoc(node.to, node.to + 1) === ']') return false;
          // A callout's `[!type]` reads as a link too; the Blockquote branch above deals with it.
          if (name === 'Link' && state.sliceDoc(node.from, node.from + 2) === '[!') return false;
          if (name === 'Link' || name === 'Image') {
            // [text](url): keep the text, hide the brackets and url.
            const marks = [];
            let url = null;
            const c = node.node.cursor();
            if (c.firstChild()) {
              do {
                if (c.name === 'LinkMark') marks.push([c.from, c.to]);
                if (c.name === 'URL') url = [c.from, c.to];
              } while (c.nextSibling());
            }
            if (name === 'Image' && url) {
              const src = state.sliceDoc(url[0], url[1]);
              const resolved = opts.resolveImage?.(src) ?? src;
              add(node.from, node.to, Decoration.replace({ widget: new ImageWidget(resolved, '') }));
              return false;
            }
            if (marks.length >= 2) {
              add(marks[0][0], marks[0][1], Decoration.replace({}));
              add(marks[1][0], node.to, Decoration.replace({}));
              add(marks[0][1], marks[1][0], Decoration.mark({ class: 'cm-link-text', attributes: url ? { 'data-href': state.sliceDoc(url[0], url[1]) } : {} }));
            }
            return false;
          }
        },
      });

      // Obsidian syntax CodeMirror doesn't parse: ![[embed]], [[wikilink|alias]], #tags, Tasks' dates.
      const base = Math.max(from, fmEnd);
      if (base >= to) continue;
      const text = state.sliceDoc(base, to);
      for (const m of text.matchAll(/(?:[📅⏳🛫✅➕❌]\uFE0F?\s*\d{4}-\d{2}-\d{2}|\(@\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?\)|[⏫🔼🔽🔺⏬]|🔁\uFE0F?\s*every[^📅⏳🛫✅➕❌\n]*)/gu)) {
        const start = base + m.index;
        if (!inCode(state, start)) add(start, start + m[0].length, Decoration.mark({ class: 'cm-taskfield' }));
      }
      for (const m of text.matchAll(/(!?)\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g)) {
        const start = base + m.index;
        const end = start + m[0].length;
        const target = m[2].trim();
        if (inCode(state, start)) continue;
        const onActive = active.has(lineOf(start));
        if (m[1] && IMAGE_EXT.test(target) && !onActive) {
          add(start, end, Decoration.replace({ widget: new ImageWidget(opts.resolveEmbed?.(target) ?? target, target) }));
        } else if (!m[1]) {
          if (!onActive) {
            add(start, start + 2, Decoration.replace({}));
            if (m[3]) add(start + 2, start + 3 + m[2].length, Decoration.replace({}));
            add(end - 2, end, Decoration.replace({}));
          }
          add(start, end, Decoration.mark({ class: 'cm-wikilink', attributes: { 'data-link': target } }));
        }
      }
      for (const m of text.matchAll(/==([^=\n]+)==/g)) {
        const start = base + m.index;
        if (inCode(state, start)) continue;
        if (!active.has(lineOf(start))) {
          add(start, start + 2, Decoration.replace({}));
          add(start + m[0].length - 2, start + m[0].length, Decoration.replace({}));
        }
        add(start, start + m[0].length, Decoration.mark({ class: 'cm-highlight' }));
      }
      for (const m of text.matchAll(/(^|[\s(])(#[\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu)) {
        const start = base + m.index + m[1].length;
        if (inCode(state, start) || state.sliceDoc(start, start + 2) === '# ') continue;
        add(start, start + m[2].length, Decoration.mark({ class: 'cm-tag' }));
      }
    }

    // RangeSetBuilder needs sorted, non-overlapping replaces; marks and lines may share positions.
    ranges.sort((a, b) => a.from - b.from || a.deco.startSide - b.deco.startSide || a.to - b.to);
    const builder = new RangeSetBuilder();
    let replacedTo = -1;
    for (const r of ranges) {
      const isReplace = r.deco.spec.widget !== undefined || (r.to > r.from && !r.deco.spec.class && !r.deco.spec.attributes);
      if (isReplace && r.from < replacedTo) continue;
      builder.add(r.from, r.to, r.deco);
      if (isReplace) replacedTo = r.to;
    }
    return builder.finish();
  };

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = build(view);
      }
      update(u) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** End of a leading `---` YAML block (just past its closing line), or 0. */
function frontmatterEnd(state) {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== '---') return 0;
  for (let n = 2; n <= Math.min(doc.lines, 200); n++) {
    if (doc.line(n).text.trimEnd() === '---') return doc.line(n).to;
  }
  return 0;
}

function inCode(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText'].includes(n.name)) return true;
  }
  return false;
}

/** Flips the `[ ]` at `pos` (a TaskMarker), as a normal undoable edit. */
function toggleTask(view, pos) {
  const marker = view.state.sliceDoc(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(marker)) return false;
  view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: marker[1] === ' ' ? 'x' : ' ' }, userEvent: 'input.toggle' });
  return true;
}

/**
 * Builds an editor in `parent`.
 *  doc            initial text
 *  onChange(text) every edit
 *  onOpenLink(target, {newTab})  [[wikilink]] or url clicked
 *  resolveEmbed(name) -> url     for ![[image.png]]
 *  resolveImage(src) -> url      for ![](relative/path.png)
 *  linkTargets() -> [{label, detail}]  for [[ completion
 *  uploadFile(file) -> Promise<string>  pasted/dropped file; returns the text to insert
 */
export function createEditor(opts) {
  const completeLinks = (ctx) => {
    const m = ctx.matchBefore(/\[\[[^\]\n]*/);
    if (!m || !opts.linkTargets) return null;
    return {
      from: m.from + 2,
      options: opts.linkTargets().map((o) => ({ label: o.label, detail: o.detail, apply: `${o.label}]]` })),
      validFor: /^[^\]\n]*$/,
    };
  };

  // Typing "/" at the start of a line or after a space offers plugin commands: /mermaid, /today, …
  const completeCommands = (ctx) => {
    const m = ctx.matchBefore(/(?:^|\s)\/[\w-]*$/);
    if (!m || !registry.commands.length) return null;
    const slash = m.from + m.text.indexOf('/');
    return {
      from: slash,
      options: registry.commands.map((c) => ({
        label: `/${c.id}`,
        detail: c.name,
        apply: (view, _completion, from, to) => {
          view.dispatch({ changes: { from, to, insert: '' } });
          Promise.resolve(c.run(commandContext(view, opts))).catch((err) => opts.onError?.(err));
        },
      })),
      validFor: /^\/[\w-]*$/,
    };
  };

  const insertFiles = async (view, files, pos) => {
    if (!opts.uploadFile || !files.length) return false;
    for (const file of files) {
      try {
        const text = await opts.uploadFile(file);
        const at = pos ?? view.state.selection.main.head;
        const line = view.state.doc.lineAt(at);
        const insert = (line.length && at === line.to ? '\n' : '') + text + '\n';
        view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } });
      } catch (err) {
        opts.onError?.(err);
      }
    }
    return true;
  };

  const view = new EditorView({
    parent: opts.parent,
    // The page sits in <m3e-theme>, and CodeMirror follows the slot into that element's shadow root, then looks
    // for focus and the selection there and never finds them: typing lands wherever the browser's caret was.
    root: document,
    state: EditorState.create({
      doc: opts.doc ?? '',
      extensions: [
        history(),
        // Tabs indent, as in Obsidian, so nested lists line up in both apps; editor.css makes each one wide enough to read.
        indentUnit.of('\t'),
        EditorState.tabSize.of(4),
        indentOnInput(),
        closeBrackets(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, addKeymap: true }),
        syntaxHighlighting(highlight),
        livePreview(opts),
        properties,
        pluginBlocks,
        autocompletion({ override: [completeLinks, completeCommands], icons: false }),
        placeholderExt(opts.placeholder ?? 'Note'),
        // Tab takes the highlighted suggestion ([[link]] or /command); with no menu open it indents as usual.
        keymap.of([{ key: 'Tab', run: acceptCompletion }]),
        keymap.of([...closeBracketsKeymap, ...markdownKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        // writingsuggestions: no macOS/Chrome predicted words greyed in after the cursor (they look like note text).
        EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'sentences', writingsuggestions: 'false', 'aria-label': 'Note text' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange?.(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          mousedown(e, view) {
            const el = e.target;
            const block = el.closest?.('.cm-plugin-block');
            if (block) {
              // Into the block's source, on its first line of code.
              e.preventDefault();
              const line = view.state.doc.lineAt(view.posAtDOM(block));
              const target = view.state.doc.line(Math.min(line.number + 1, view.state.doc.lines));
              view.dispatch({ selection: { anchor: target.to } });
              view.focus();
              return true;
            }
            if (el.closest?.('.cm-properties')) {
              e.preventDefault();
              view.dispatch({ selection: { anchor: view.state.doc.line(Math.min(2, view.state.doc.lines)).to } });
              view.focus();
              return true;
            }
            if (el instanceof HTMLInputElement && el.classList.contains('cm-task')) {
              e.preventDefault();
              return toggleTask(view, view.posAtDOM(el));
            }
            const link = el.closest?.('.cm-wikilink');
            const href = el.closest?.('.cm-link-text, .cm-url');
            // Plain click opens a link when its markup is hidden (Obsidian live preview); otherwise Ctrl/Cmd+click.
            const modifier = e.metaKey || e.ctrlKey;
            const lineActive = view.hasFocus && activeLines(view.state).has(view.state.doc.lineAt(view.posAtDOM(el)).number);
            if (link && (modifier || !lineActive)) {
              e.preventDefault();
              opts.onOpenLink?.(link.dataset.link ?? link.textContent, { newTab: e.shiftKey });
              return true;
            }
            if (href && (modifier || !lineActive)) {
              const url = href.dataset.href ?? href.textContent;
              if (/^(https?:|mailto:)/i.test(url)) {
                e.preventDefault();
                opts.onOpenLink?.(url, { external: true });
                return true;
              }
            }
            return false;
          },
          paste(e, view) {
            const files = [...(e.clipboardData?.files ?? [])];
            if (!files.length) return false;
            e.preventDefault();
            insertFiles(view, files);
            return true;
          },
          drop(e, view) {
            const files = [...(e.dataTransfer?.files ?? [])];
            if (!files.length) return false;
            e.preventDefault();
            insertFiles(view, files, view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined);
            return true;
          },
        }),
      ],
    }),
  });

  return {
    view,
    getText: () => view.state.doc.toString(),
    /** Replaces the text (a newer version from elsewhere), keeping the cursor near where it was. Not undoable into. */
    setText(text) {
      const head = Math.min(view.state.selection.main.head, text.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: head },
        // Kept out of undo history: Ctrl+Z must never bring back the old version (autosave would then write it over
        // the new one with the new hash, silently undoing someone else's edit).
        annotations: [EditorView.announce.of('Note updated'), Transaction.addToHistory.of(false)],
      });
    },
    focus(atEnd) {
      if (atEnd) view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
    },
    /** Puts the cursor on a 0-based line, e.g. a todo opened from the list. */
    goToLine(n) {
      const line = view.state.doc.line(Math.min(Math.max(n + 1, 1), view.state.doc.lines));
      view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
      view.focus();
    },
    destroy: () => view.destroy(),
  };
}
