// "Linked mentions": the notes that link to this one, each with the lines that do. Shared by the web app and the
// Android editor page, which fetch the list differently (`GET /api/notes/backlinks`).

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A linking line, with its links shown as their text and highlighted. */
function line(l) {
  return esc(l)
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, a, b) => `<mark>${b || a.replace(/#.*/, '')}</mark>`)
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '<mark>$1</mark>');
}

/** `href(path)` gives each entry's link; `icon` is the markup put before each title. */
export function backlinksHtml(items, { href, icon = '' }) {
  const folderOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  return `<h2 class="notes-head">Linked mentions<span>${items.length}</span></h2>${items
    .map(
      (b) => `<a class="backlink" href="${esc(href(b.path))}" data-path="${esc(b.path)}">
  <span class="backlink-title">${icon}${esc(b.title)}${folderOf(b.path) ? `<small>${esc(folderOf(b.path))}</small>` : ''}</span>
  ${b.lines.map((l) => `<span class="backlink-line">${line(l)}</span>`).join('')}</a>`,
    )
    .join('')}`;
}
