// "Linked mentions": the notes that link to this one, each with the lines that do; and "Unlinked mentions": notes that
// only write its name, each with a button to make that a link. Shared by the web app and the Android editor page,
// which fetch the lists differently (`GET /api/notes/backlinks`, `GET /api/notes/mentions`).

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

/** Collapsed unless `open` (kept open while the list redraws after a link). `icon` is put before each title. */
export function mentionsHtml(items, { href, icon = '', open = false }) {
  if (!items.length) return '';
  const count = items.reduce((n, i) => n + i.mentions.length, 0);
  return `<details class="unlinked"${open ? ' open' : ''}><summary class="notes-head">Unlinked mentions<span>${count}</span></summary>${items
    .map(
      (b) => `<div class="backlink">
  <a class="backlink-title" href="${esc(href(b.path))}" data-path="${esc(b.path)}">${icon}${esc(b.title)}${folderOf(b.path) ? `<small>${esc(folderOf(b.path))}</small>` : ''}</a>
  ${b.mentions
    .map(
      (m) => `<span class="mention"><span class="backlink-line">${esc(m.before)}<mark>${esc(m.text)}</mark>${esc(m.after)}</span>
  <button type="button" class="mention-link" data-src="${esc(b.path)}" data-hash="${esc(b.hash)}" data-start="${m.start}" data-text="${esc(m.text)}">Link</button></span>`,
    )
    .join('')}</div>`,
    )
    .join('')}</details>`;
}

/** Calls `link({ src, hash, start, text })` when a "Link" button in `box` is pressed. */
export function onLinkMention(box, link) {
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.mention-link');
    if (!b || b.disabled) return;
    b.disabled = true;
    const { src, hash, start, text } = b.dataset;
    link({ src, hash, start: Number(start), text });
  });
}
