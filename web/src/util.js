// Small helpers the web app and the Android editor page share.

/** Text made safe to put in HTML, attribute values included. */
export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The folder a vault path is in ("" at the top level). */
export const folderOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/**
 * Inline markdown as card HTML: links as their (link-coloured) text, embeds and Tasks fields dropped, and bold, italic, strikethrough,
 * `code` and ==highlight== kept as formatting. Escapes first, so the formatting is the only markup.
 */
export function inlineHtml(s) {
  const plain = s
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a, b) => `\u0001${b || a}\u0002`)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '\u0001$1\u0002')
    .replace(/[📅⏳🛫✅➕❌]️?\s*\d{4}-\d{2}-\d{2}|\(@[^)]*\)|[⏫🔼🔽🔺⏬]️?|🔁️?\s*every[^📅⏳🛫✅➕❌\n]*/gu, '')
    .trim();
  // Code spans first, so nothing inside them is read as formatting.
  const code = [];
  const html = esc(plain)
    .replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`)
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<b>${a ?? b}</b>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)|(^|\W)_([^_\s][^_]*)_(?!\w)/g, (_, p1, a, p2, b) => `${p1 ?? p2}<i>${a ?? b}</i>`)
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    .replace(/\u0001([^\u0002]*)\u0002/g, '<span class="ln-link">$1</span>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[i]}</code>`);
}

/** A markdown table row as its cells: split on unescaped pipes (outer ones optional), `\|` read as a pipe. */
export function tableCells(line) {
  const cells = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/);
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'));
}
