// "Linked mentions": the notes that link to this one, each with the lines that do. Shared by the web app and the
// Android editor page, which fetch the list differently (`GET /api/notes/backlinks`).

import { esc, folderOf, inlineHtml } from './util.js';

/**
 * A linking line formatted like a card line (list, task, heading and quote markers dropped), its links highlighted.
 * The line shows on one row, so on a phone a link far into it would be cut off: there it starts at the link's
 * sentence (or a few words before the link) instead.
 */
function line(l) {
  const s = l.replace(/^\s*(?:[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+|#{1,6}\s+|>\s*)/, '');
  const at = s.search(/!?\[\[|\[[^\]]*\]\(/);
  if (at <= 40) return inlineHtml(s);
  const sentence = s.lastIndexOf('. ', at);
  const start = sentence >= 0 && at - sentence < 60 ? sentence + 2 : s.lastIndexOf(' ', at - 20) + 1;
  if (start <= 0) return inlineHtml(s);
  return `<span class="bl-full">${inlineHtml(s)}</span><span class="bl-near">…${inlineHtml(s.slice(start))}</span>`;
}

/** `href(path)` gives each entry's link; `icon` is the markup put before each title. */
export function backlinksHtml(items, { href, icon = '' }) {
  return `<h2 class="notes-head">Linked mentions<span>${items.length}</span></h2>${items
    .map(
      (b) => `<a class="backlink" href="${esc(href(b.path))}" data-path="${esc(b.path)}">
  <span class="backlink-title">${icon}${esc(b.title)}${folderOf(b.path) ? `<small>${esc(folderOf(b.path))}</small>` : ''}</span>
  ${b.lines.map((l) => `<span class="backlink-line ln">${line(l)}</span>`).join('')}</a>`,
    )
    .join('')}`;
}
