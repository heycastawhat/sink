// Editing a GFM table's source (Obsidian's Advanced Tables): Tab and Enter move between cells and line the pipes up,
// a toolbar over the table adds, removes and aligns rows and columns, and Enter after a `| header |` line or a paste
// of spreadsheet cells starts a table.
import { EditorSelection, StateField } from '@codemirror/state';
import { EditorView, showTooltip } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

/** Each cell's [from, to] in a row's text: between unescaped pipes, the outer ones optional. */
export function cellSpans(text) {
  const spans = [];
  let start = text.match(/^\s*\|?/)[0].length;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '|') {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  if (text.slice(start).trim() || !spans.length) spans.push([start, text.length]);
  return spans;
}

const cellsOf = (text) => cellSpans(text).map(([a, b]) => text.slice(a, b).trim());

/** The Table node around `pos`, unless it's in a quote (its lines start with "> ", left alone like the widget does). */
function tableNode(state, pos) {
  for (const side of [-1, 1]) {
    let table = null;
    for (let n = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'Blockquote') return null;
      if (n.name === 'Table') table = n;
    }
    if (table) return table;
  }
  return null;
}

function inCode(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (/^(FencedCode|CodeBlock|HTMLBlock|CommentBlock|Blockquote)$/.test(n.name)) return true;
  }
  return false;
}

/** The table at the caret as rows of cell text (the header first, no rule line), and where in it the caret is. */
function current(state) {
  if (state.readOnly) return null;
  const pos = state.selection.main.head;
  const node = tableNode(state, pos);
  if (!node) return null;
  const first = state.doc.lineAt(node.from);
  const last = state.doc.lineAt(node.to);
  const lines = [];
  for (let n = first.number; n <= last.number; n++) lines.push(state.doc.line(n).text);
  const rows = lines.filter((_, i) => i !== 1).map(cellsOf);
  const width = Math.max(...rows.map((r) => r.length));
  for (const r of rows) while (r.length < width) r.push('');
  const align = Array.from({ length: width }, (_, c) => {
    const d = cellsOf(lines[1] ?? '')[c] ?? '';
    return /^:-*:$/.test(d) ? 'center' : /^-*:$/.test(d) ? 'right' : /^:/.test(d) ? 'left' : '';
  });
  const line = state.doc.lineAt(pos);
  const i = line.number - first.number;
  const spans = cellSpans(line.text);
  let col = spans.findIndex(([, b]) => pos - line.from <= b);
  if (col < 0) col = spans.length - 1;
  const raw = line.text.slice(...spans[col]);
  const offset = i === 1 ? 0 : Math.max(0, pos - line.from - spans[col][0] - (raw.length - raw.trimStart().length));
  return { from: first.from, to: last.to, indent: first.text.match(/^\s*/)[0], rows, align, row: Math.max(0, i - 1), col: Math.min(col, width - 1), offset };
}

/** The table as text with its columns padded to line up, and the caret's place (or its cell selected) in it. */
function render(t, select) {
  const w = t.align.map((_, c) => Math.max(3, ...t.rows.map((r) => r[c].length)));
  const left = (s, c) => {
    const gap = w[c] - s.length;
    return !s ? 0 : t.align[c] === 'right' ? gap : t.align[c] === 'center' ? gap >> 1 : 0;
  };
  const pad = (s, c) => ' '.repeat(left(s, c)) + s + ' '.repeat(w[c] - s.length - left(s, c));
  const row = (r) => `${t.indent}| ${r.map(pad).join(' | ')} |`;
  const end = (a, side) => (a === 'center' || a === side ? ':' : '-');
  const rule = `${t.indent}| ${t.align.map((a, c) => end(a, 'left') + '-'.repeat(w[c] - 2) + end(a, 'right')).join(' | ')} |`;
  const lines = [row(t.rows[0]), rule, ...t.rows.slice(1).map(row)];
  const cell = t.rows[t.row][t.col];
  let at = t.from + lines.slice(0, t.row && t.row + 1).reduce((n, l) => n + l.length + 1, 0) + t.indent.length + 2;
  for (let c = 0; c < t.col; c++) at += w[c] + 3;
  at += left(cell, t.col);
  const range = select ? EditorSelection.range(at, at + cell.length) : EditorSelection.cursor(at + Math.min(t.offset, cell.length));
  return { text: lines.join('\n'), range };
}

function write(view, t, select = false) {
  const { text, range } = render(t, select);
  view.dispatch({ changes: { from: t.from, to: t.to, insert: text }, selection: range, scrollIntoView: true, userEvent: 'input' });
}

function removeTable(view, t) {
  const to = Math.min(t.to + 1, view.state.doc.length);
  view.dispatch({ changes: { from: t.from, to }, selection: { anchor: t.from }, scrollIntoView: true, userEvent: 'delete' });
}

const blank = (t) => t.align.map(() => '');

/** A command on the table at the caret: `fn` changes it (returning 'remove' to delete it); false outside a table. */
const onTable = (fn, select) => (view) => {
  const t = current(view.state);
  if (!t) return false;
  if (fn(t) === 'remove') removeTable(view, t);
  else write(view, t, select);
  return true;
};

/** Tab: the next cell (a new row after the last one), its text selected so typing replaces it. */
export const nextCell = onTable((t) => {
  if (++t.col < t.align.length) return;
  t.col = 0;
  if (++t.row === t.rows.length) t.rows.push(blank(t));
}, true);

export const prevCell = onTable((t) => {
  if (--t.col >= 0) return;
  if (t.row === 0) t.col = 0;
  else [t.row, t.col] = [t.row - 1, t.align.length - 1];
}, true);

export const rowAbove = onTable((t) => {
  t.rows.splice(t.row, 0, blank(t));
  t.offset = 0;
});
export const rowBelow = onTable((t) => {
  t.rows.splice(++t.row, 0, blank(t));
  t.offset = 0;
});
export const deleteRow = onTable((t) => {
  if (t.rows.length === 1) return 'remove';
  t.rows.splice(t.row, 1);
  t.row = Math.min(t.row, t.rows.length - 1);
});
export const colLeft = onTable((t) => {
  for (const r of t.rows) r.splice(t.col, 0, '');
  t.align.splice(t.col, 0, '');
  t.offset = 0;
});
export const colRight = onTable((t) => {
  t.col++;
  for (const r of t.rows) r.splice(t.col, 0, '');
  t.align.splice(t.col, 0, '');
  t.offset = 0;
});
export const deleteCol = onTable((t) => {
  if (t.align.length === 1) return 'remove';
  for (const r of t.rows) r.splice(t.col, 1);
  t.align.splice(t.col, 1);
  t.col = Math.min(t.col, t.align.length - 1);
  t.offset = 0;
});
const alignCol = (a) => onTable((t) => void (t.align[t.col] = t.align[t.col] === a ? '' : a));

/**
 * Enter in a table goes down a row (adding one at the bottom); on an empty last row it leaves the table, dropping
 * the row. At the end of a `| a | b |` line outside a table it makes that line a header, with a row to fill in.
 */
export function tableEnter(view) {
  const t = current(view.state);
  if (t) {
    if (t.row > 0 && t.row === t.rows.length - 1 && t.rows[t.row].every((c) => !c)) {
      t.rows.pop();
      t.row--;
      const { text } = render(t);
      view.dispatch({ changes: { from: t.from, to: t.to, insert: `${text}\n` }, selection: { anchor: t.from + text.length + 1 }, scrollIntoView: true, userEvent: 'input' });
      return true;
    }
    if (++t.row === t.rows.length) t.rows.push(blank(t));
    t.offset = Infinity;
    write(view, t);
    return true;
  }
  const { state } = view;
  const { head, empty } = state.selection.main;
  const line = state.doc.lineAt(head);
  if (!empty || head !== line.to || !/^\s*\|.*\|\s*$/.test(line.text) || inCode(state, head)) return false;
  const cells = cellsOf(line.text);
  if (!cells.some((c) => c)) return false;
  const align = cells.map(() => '');
  write(view, { from: line.from, to: line.to, indent: line.text.match(/^\s*/)[0], rows: [cells, align.slice()], align, row: 1, col: 0, offset: 0 });
  return true;
}

/** Text copied from a spreadsheet (rows of tab-separated cells) as a markdown table, or null if it isn't that. */
export function tableFromTsv(text) {
  const lines = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n');
  const tabs = lines[0].split('\t').length;
  if (lines.length < 2 || tabs < 2 || lines.some((l) => l.split('\t').length !== tabs)) return null;
  const rows = lines.map((l) => l.split('\t').map((c) => c.trim().replace(/\|/g, '\\|')));
  return render({ from: 0, indent: '', rows, align: rows[0].map(() => ''), row: 0, col: 0, offset: 0 }).text;
}

const tablePaste = EditorView.domEventHandlers({
  paste(e, view) {
    const { state } = view;
    const at = state.selection.main.from;
    const table = !state.readOnly && tableFromTsv(e.clipboardData?.getData('text/plain') ?? '');
    if (!table || current(state) || inCode(state, at)) return false;
    e.preventDefault();
    // Its own lines, a blank one above it, as /table does: markdown only reads a table that starts a block.
    const line = state.doc.lineAt(at);
    const before = state.sliceDoc(line.from, at).trim() ? '\n\n' : line.number > 1 && state.doc.line(line.number - 1).text.trim() ? '\n' : '';
    const insert = `${before}${table}\n`;
    view.dispatch(state.update({ changes: { from: at, to: state.selection.main.to, insert }, selection: { anchor: at + insert.length }, scrollIntoView: true, userEvent: 'input.paste' }));
    return true;
  },
});

const TOOLS = [
  ['add_row_above', 'Add row above', '↑+', rowAbove],
  ['add_row_below', 'Add row below', '↓+', rowBelow],
  ['delete', 'Delete row', '−row', deleteRow],
  null,
  ['add_column_left', 'Add column left', '←+', colLeft],
  ['add_column_right', 'Add column right', '→+', colRight],
  ['delete', 'Delete column', '−col', deleteCol],
  null,
  ['format_align_left', 'Align column left', '⇤', alignCol('left')],
  ['format_align_center', 'Center column', '↔', alignCol('center')],
  ['format_align_right', 'Align column right', '⇥', alignCol('right')],
];

function toolbarDom(view) {
  const dom = document.createElement('div');
  dom.className = 'cm-table-tools';
  // Pages without the icon font (a shared note, the phone's editor) get short text instead.
  const icons = !!customElements.get('m3e-icon');
  for (const tool of TOOLS) {
    if (!tool) {
      dom.append(Object.assign(document.createElement('span'), { className: 'cm-table-tools-gap' }));
      continue;
    }
    const [icon, label, text, run] = tool;
    const b = Object.assign(document.createElement('button'), { type: 'button', title: label });
    b.setAttribute('aria-label', label);
    if (icons) b.append(Object.assign(document.createElement('m3e-icon'), { name: icon }));
    else b.textContent = text;
    // Keeps the editor focused, the caret (and the phone's keyboard) where it was.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      run(view);
      view.focus();
    });
    dom.append(b);
  }
  return { dom };
}

function toolbarAt(state, old) {
  const node = !state.readOnly && tableNode(state, state.selection.main.head);
  if (!node) return null;
  const pos = state.doc.lineAt(node.from).from;
  // The same tooltip object keeps its DOM rather than being rebuilt on every keystroke.
  return old?.pos === pos ? old : { pos, above: true, create: toolbarDom };
}

const toolbar = StateField.define({
  create: (state) => toolbarAt(state, null),
  update: (tip, tr) => (tr.docChanged || tr.selection ? toolbarAt(tr.state, tip) : tip),
  provide: (f) => showTooltip.from(f),
});

export const tableEditing = [toolbar, tablePaste];
