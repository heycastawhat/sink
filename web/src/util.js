// Small helpers the web app and the Android editor page share.

/** Text made safe to put in HTML, attribute values included. */
export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The folder a vault path is in ("" at the top level). */
export const folderOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/**
 * Inline markdown as card HTML: links and embeds as their text, Tasks dates dropped, and bold, italic, strikethrough,
 * `code` and ==highlight== kept as formatting. Escapes first, so the formatting is the only markup.
 */
export function inlineHtml(s) {
  const plain = s
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, '🖼')
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a, b) => b || a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[📅⏳🛫✅]\s*\d{4}-\d{2}-\d{2}|\(@[^)]*\)/gu, '')
    .trim();
  // Code spans first, so nothing inside them is read as formatting.
  const code = [];
  const html = esc(plain)
    .replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`)
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<b>${a ?? b}</b>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)|(^|\W)_([^_\s][^_]*)_(?!\w)/g, (_, p1, a, p2, b) => `${p1 ?? p2}<i>${a ?? b}</i>`)
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[i]}</code>`);
}
