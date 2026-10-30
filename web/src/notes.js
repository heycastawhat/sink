// Notes: a Keep-style grid of cards, each opening fullscreen in the markdown editor, plus the Todos list.
// Notes are files in the vault on the NAS; saves carry the hash we last saw, so edits made elsewhere
// (Obsidian, the phone) are never silently overwritten.

import { esc, folderOf } from './util.js';
import { backlinksHtml } from './backlinks.js';
import { api, ApiError, Unauthorized } from './api.js';
import { createEditor } from './editor.js';
import { registry, onRegistryChange } from './plugin-api.js';
import { askText, pickFolder, pickVersion } from './dialogs.js';

const $ = (id) => document.getElementById(id);
const ic = (name, slot, more = '') => `<m3e-icon name="${esc(name)}"${slot ? ` slot="${slot}"` : ''}${more}></m3e-icon>`;

export const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'gray'];
const SAVE_DELAY = 700;
const POLL_MS = 15_000;
const draftKey = (path) => `sink:unsaved:${path}`;

let toast = (msg) => console.log(msg);
let navigate = (hash) => (location.hash = hash);
// Opened by tapping a card (so Back can pop history) rather than from a link or a reload.
let openedInApp = false;
const openFromApp = (hash) => {
  openedInApp = true;
  navigate(hash);
};

export function initNotes(deps) {
  toast = deps.toast;
  navigate = deps.navigate ?? navigate;
}

const state = {
  notes: [],
  folders: [],
  folder: '',
  q: '',
  results: null,
  loaded: false,
};

const fileName = (path) => path.split('/').pop().replace(/(\.excalidraw)?\.md$/i, '');
export const folderHash = (folder) => (folder ? `#/notes/${folder.split('/').map(encodeURIComponent).join('/')}` : '#/notes');
// Sink's own attachments folder isn't somewhere you file notes.
const shownFolder = (f) => f !== 'attachments' && !f.startsWith('attachments/');
const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
const childFolders = (parent) => state.folders.filter((f) => shownFolder(f) && folderOf(f) === parent).sort(byName);
const notesIn = (folder) => state.notes.filter((n) => n.path.startsWith(folder + '/')).length;
export const noteHash = (path, line) => `#/n/${path.split('/').map(encodeURIComponent).join('/')}${line != null ? `?line=${line}` : ''}`;

function relative(ts) {
  const d = new Date(ts);
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

// ---------- grid ----------

export async function loadNotes() {
  try {
    const { notes, folders } = await api.notes();
    state.notes = notes;
    state.folders = folders;
    state.loaded = true;
  } catch (err) {
    if (err instanceof Unauthorized) throw err;
    toast(`Can't load notes: ${err.message}`);
  }
  renderGrid();
}

export function setFolder(folder) {
  state.folder = folder;
  renderGrid();
}

let searchSeq = 0;
export async function setQuery(q) {
  state.q = q;
  const seq = ++searchSeq;
  if (!q) {
    state.results = null;
    return renderGrid();
  }
  try {
    const { items } = await api.searchNotes(q);
    if (seq === searchSeq) state.results = items;
  } catch (err) {
    toast(err.message);
  }
  if (seq === searchSeq) renderGrid();
}

/** Markdown excerpt as card text: checkboxes as boxes, markup stripped, a few lines. */
/**
 * Inline markdown as card HTML: links and embeds as their text, Tasks dates dropped, and bold, italic, strikethrough,
 * `code` and ==highlight== kept as formatting. Escapes first, so the formatting is the only markup.
 */
function inlineHtml(s) {
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

/**
 * A note's first lines as card HTML, formatted like the note: headings, nested list indents, checkboxes, numbered
 * lists, quotes and code blocks, plus inline formatting. Mirrors the Android card.
 */
function excerptHtml(text) {
  const out = [];
  let fenced = false;
  for (const raw of (text ?? '').split('\n')) {
    if (out.length === 10) break;
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      if (raw.trim()) out.push(`<span class="ln code">${esc(raw)}</span>`);
      continue;
    }
    if (!raw.trim() || /^%%/.test(raw) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue;
    // Tabs, or every two spaces, are one level of nesting.
    const lead = /^[\t ]*/.exec(raw)[0];
    const depth = Math.min(4, [...lead].reduce((d, c) => d + (c === '\t' ? 2 : 1), 0) >> 1);
    const indent = depth ? ` style="--depth:${depth}"` : '';
    const l = raw.slice(lead.length);
    const task = /^[-*+]\s+\[(.)\]\s+(.*)$/.exec(l);
    if (task) {
      out.push(`<span class="ln task${task[1] === ' ' ? '' : ' done'}"${indent}>${ic(task[1] === ' ' ? 'check_box_outline_blank' : 'check_box')}<span>${inlineHtml(task[2])}</span></span>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(l);
    if (heading) {
      out.push(`<span class="ln h h${Math.min(heading[1].length, 3)}">${inlineHtml(heading[2])}</span>`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(l);
    if (quote) {
      // Callout header `[!tip] Title` reads as just the title (or the type when there isn't one).
      const body = quote[1].replace(/^\[!(\w+)\][+-]?\s*(.*)$/, (_, type, title) => title || type[0].toUpperCase() + type.slice(1));
      if (body.trim()) out.push(`<span class="ln quote"${indent}>${inlineHtml(body)}</span>`);
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(l);
    const numbered = /^(\d+[.)])\s+(.*)$/.exec(l);
    if (bullet) out.push(`<span class="ln li"${indent}><span class="mk">•</span><span>${inlineHtml(bullet[1])}</span></span>`);
    else if (numbered) out.push(`<span class="ln li"${indent}><span class="mk">${esc(numbered[1])}</span><span>${inlineHtml(numbered[2])}</span></span>`);
    else out.push(`<span class="ln"${indent}>${inlineHtml(l)}</span>`);
  }
  return out.join('');
}

function cardHtml(n) {
  const board = /\.excalidraw\.md$/i.test(n.path);
  const folder = folderOf(n.path);
  const body = n.snippet ? esc(n.snippet).replace(/\[([^\]]+)\]/g, '<mark>$1</mark>') : excerptHtml(n.excerpt);
  // A note with no heading is named after its first line (Keep-style); showing both would repeat it.
  const firstLine = (n.excerpt ?? '').trimStart().split('\n')[0];
  const showTitle = board || n.snippet || n.title !== fileName(n.path) || !firstLine.startsWith(n.title);
  return `
<article class="note-card${n.color ? ` c-${n.color}` : ''}" data-path="${esc(n.path)}" tabindex="0" draggable="true">
  ${n.pinned ? `<span class="pin" title="Pinned">${ic('push_pin', '', ' filled')}</span>` : ''}
  ${showTitle ? `<h3 class="note-title">${board ? ic('draw') : ''}${esc(n.title)}</h3>` : ''}
  ${board ? '' : `<div class="note-body">${body}</div>`}
  <div class="note-foot">
    ${folder ? `<span class="note-folder">${ic('folder')}${esc(folder)}</span>` : ''}
    ${(n.tags ?? []).slice(0, 3).map((t) => `<span class="note-tag">#${esc(t)}</span>`).join('')}
    <span class="note-time">${relative(n.mtime)}</span>
  </div>
</article>`;
}

function renderGrid() {
  const root = $('notes');
  if (!root || root.hidden) return;
  // Search always covers everything; browsing home can leave filed notes to their folders.
  const inFolder = (n) =>
    state.folder ? n.path.startsWith(state.folder + '/') : state.results || !prefs.hideFoldered || !n.path.includes('/');
  const list = (state.results ?? state.notes).filter(inFolder);

  renderFolderBar();
  renderFolderTree();
  renderRecentStrip();

  const pinned = state.results ? [] : list.filter((n) => n.pinned);
  const others = state.results ? list : list.filter((n) => !n.pinned);
  $('notes-pinned-head').hidden = !pinned.length;
  $('notes-others-head').hidden = !pinned.length || !others.length;
  $('notes-pinned').innerHTML = pinned.map(cardHtml).join('');
  $('notes-grid').innerHTML = others.map(cardHtml).join('');

  const empty = state.loaded && !list.length;
  $('notes-empty').hidden = !empty;
  if (empty) {
    $('notes-empty-title').textContent = state.q
      ? 'Nothing matches'
      : state.folder
        ? 'Nothing in here yet'
        : prefs.hideFoldered && state.notes.length
          ? 'Everything’s filed away'
          : 'No notes yet';
    $('notes-empty-body').textContent = state.q
      ? `No notes mention “${state.q}”.`
      : state.folder
        ? 'Notes you take here, or drag onto this folder, land in it.'
        : prefs.hideFoldered && state.notes.length
          ? 'Your notes are in the folders above. New notes you take here stay on this page.'
          : 'Take a note above. It saves as a markdown file in your notes folder.';
  }
}

// ---------- folders ----------

/** Breadcrumb, this folder's actions, and tiles for the folders inside it. */
function renderFolderBar() {
  // The title already names this folder; the crumbs are the way back up (and places to drop a note).
  const parts = state.folder ? state.folder.split('/') : [];
  const item = (path, label, icon, current) =>
    `<m3e-breadcrumb-item data-crumb="${esc(path)}" data-drop-folder="${esc(path)}"${current ? ' current="page"' : ''}>${ic(icon, 'icon')}${esc(label)}</m3e-breadcrumb-item>`;
  $('folder-crumbs').innerHTML =
    item('', 'Notes', 'home', false) + parts.map((name, i) => item(parts.slice(0, i + 1).join('/'), name, 'folder', i === parts.length - 1)).join('');
  $('folder-crumbs').hidden = !parts.length;
  const btn = (act, icon, label) =>
    `<m3e-icon-button data-folder-act="${act}" aria-label="${label}" title="${label}">${ic(icon)}</m3e-icon-button>`;
  $('folder-actions').innerHTML = state.folder
    ? btn('new', 'create_new_folder', 'New folder here') +
      btn('rename', 'drive_file_rename_outline', 'Rename folder') +
      btn('move', 'drive_file_move', 'Move folder') +
      btn('delete', 'delete', 'Delete folder')
    : btn('new', 'create_new_folder', 'New folder');

  const children = state.results ? [] : childFolders(state.folder);
  $('folder-tiles').innerHTML = children
    .map((f) => {
      const n = notesIn(f);
      return `<a class="folder-tile" href="${folderHash(f)}" data-drop-folder="${esc(f)}">
  ${ic('folder')}<span class="folder-name">${esc(f.split('/').pop())}</span><span class="folder-count">${n || ''}</span></a>`;
    })
    .join('');
  $('folder-tiles').hidden = !children.length;
}

/** "Hide notes in folders from the home grid": home then shows only loose notes; folders hold the rest. */
export const prefs = {
  get hideFoldered() {
    try {
      return localStorage.getItem('sink:hide-foldered') === '1';
    } catch {
      return false;
    }
  },
  set hideFoldered(on) {
    try {
      localStorage.setItem('sink:hide-foldered', on ? '1' : '0');
    } catch {}
    renderGrid();
  },
};

// ---------- recents ----------

/** When this browser last opened each note (path -> ms), for home's Recent row. Kept per device. */
const opened = {
  read() {
    try {
      return JSON.parse(localStorage.getItem('sink:opened') ?? '{}');
    } catch {
      return {};
    }
  },
  write(map) {
    try {
      // The 300 most recent are plenty; the Recent row shows 8.
      const top = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 300);
      localStorage.setItem('sink:opened', JSON.stringify(Object.fromEntries(top)));
    } catch {}
  },
  touch(path) {
    const map = this.read();
    map[path] = Date.now();
    this.write(map);
  },
  rename(from, to) {
    const map = this.read();
    if (!(from in map)) return;
    map[to] = map[from];
    delete map[from];
    this.write(map);
  },
};

function when(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

/** Whether the Recent row on home is folded away; remembered per device. */
const recentPrefs = {
  get shut() {
    try {
      return localStorage.getItem('sink:recent-shut') === '1';
    } catch {
      return false;
    }
  },
  set shut(on) {
    try {
      localStorage.setItem('sink:recent-shut', on ? '1' : '0');
    } catch {}
  },
};

/**
 * Home's Recent row: the notes you opened here or edited anywhere lately, as preview cards, like Drive's suggested
 * files. Only on home, not in folders or search, and only once there are enough notes for it to save scrolling.
 */
function renderRecentStrip() {
  const root = $('notes-recent');
  if (!root) return;
  const show = !state.folder && !state.results && state.notes.length > 6;
  root.hidden = !show;
  if (!show) return;
  const opens = opened.read();
  const items = state.notes
    .map((n) => {
      const o = opens[n.path] ?? 0;
      return { n, at: Math.max(o, n.mtime), how: o > n.mtime ? 'opened' : 'edited' };
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, 8);
  const shut = recentPrefs.shut;
  const board = (n) => /\.excalidraw\.md$/i.test(n.path);
  root.innerHTML = `<button type="button" class="recent-toggle" data-recent-toggle aria-expanded="${!shut}">${ic('expand_more')}<h2>Recent</h2></button>
${
  shut
    ? ''
    : `<div class="recent-row">${items
        .map(
          ({ n, at, how }) => `<a class="recent-card${n.color ? ` c-${n.color}` : ''}" href="${noteHash(n.path)}">
  <span class="recent-card-head">${ic(board(n) ? 'draw' : 'description')}<span class="recent-title">${esc(n.title)}</span></span>
  <span class="recent-preview">${board(n) ? `<span class="recent-board">${ic('draw')}</span>` : excerptHtml(n.excerpt)}</span>
  <span class="recent-foot">You ${how} · ${esc(when(at))}</span></a>`,
        )
        .join('')}</div>`
}`;
  root.classList.toggle('shut', shut);
}

document.addEventListener('click', (e) => {
  if (!e.target.closest?.('[data-recent-toggle]')) return;
  recentPrefs.shut = !recentPrefs.shut;
  renderRecentStrip();
});

const openFolders = new Set(
  (() => {
    try {
      return JSON.parse(localStorage.getItem('sink:open-folders') ?? '[]');
    } catch {
      return [];
    }
  })(),
);
const saveOpen = () => {
  try {
    localStorage.setItem('sink:open-folders', JSON.stringify([...openFolders]));
  } catch {}
};

/** The sidebar's folder tree (desktop). Folders open to show their children; the current one's parents stay open. */
export function renderFolderTree() {
  const box = $('nav-folders');
  if (!box) return;
  if (state.folder) state.folder.split('/').slice(0, -1).forEach((_, i, a) => openFolders.add(a.slice(0, i + 1).join('/')));
  const rows = [];
  const walk = (parent, depth) => {
    for (const f of childFolders(parent)) {
      const kids = childFolders(f).length > 0;
      const isOpen = openFolders.has(f);
      const here = state.folder === f && location.hash.startsWith('#/notes');
      rows.push(`<div class="tree-row" style="--depth:${depth}">
  <button class="tree-twisty${kids ? '' : ' leaf'}" data-toggle="${esc(f)}" aria-label="${isOpen ? 'Collapse' : 'Expand'}" ${kids ? '' : 'tabindex="-1"'}>${ic(isOpen ? 'expand_more' : 'chevron_right')}</button>
  <a class="nav-item tree-item${here ? ' active' : ''}" href="${folderHash(f)}" data-drop-folder="${esc(f)}">${ic(here ? 'folder_open' : 'folder')}<span>${esc(f.split('/').pop())}</span><b class="count">${notesIn(f) || ''}</b></a>
</div>`);
      if (kids && isOpen) walk(f, depth + 1);
    }
  };
  walk('', 0);
  box.innerHTML = rows.join('') || '<p class="nav-empty">Folders you make show up here.</p>';
}

/** "New → Todo": asks for it and adds it to Todo.md, wherever you are. */
export async function quickTodo() {
  const text = await askText({ title: 'New todo', label: 'Todo', action: 'Add' });
  if (!text) return;
  try {
    await api.addTodo({ text });
    toast('Added to Todo.md');
    if (!$('todos').hidden) loadTodos();
  } catch (err) {
    toast(err.message);
  }
}

export const newFolderHere = (parent) => newFolder(parent);

async function newFolder(parent) {
  const name = await askText({ title: parent ? `New folder in ${parent.split('/').pop()}` : 'New folder', action: 'Create' });
  if (!name) return;
  const path = parent ? `${parent}/${name}` : name;
  try {
    await api.createFolder(path);
    await loadNotes();
    navigate(folderHash(path));
  } catch (err) {
    toast(err.status === 400 ? 'Folder names can’t start with a dot or contain \\ : * ? " < > |' : err.message);
  }
}

async function moveFolderTo(folder, to) {
  if (to === folder) return;
  try {
    const { path } = await api.moveNote(folder, to);
    await loadNotes();
    if (state.folder === folder || state.folder.startsWith(folder + '/')) navigate(folderHash(path + state.folder.slice(folder.length)));
    return path;
  } catch (err) {
    toast(err.status === 409 ? `There's already a folder called “${to.split('/').pop()}” there` : err.message);
  }
}

async function renameFolder(folder) {
  const name = await askText({ title: 'Rename folder', value: folder.split('/').pop(), action: 'Rename' });
  if (!name) return;
  const parent = folderOf(folder);
  await moveFolderTo(folder, parent ? `${parent}/${name}` : name);
}

async function moveFolder(folder) {
  const dest = await pickFolder({
    title: `Move “${folder.split('/').pop()}” to…`,
    folders: state.folders.filter(shownFolder),
    current: folderOf(folder),
    exclude: folder,
    createFolder: (path) => api.createFolder(path),
  });
  if (dest === null) return;
  const name = folder.split('/').pop();
  await moveFolderTo(folder, dest ? `${dest}/${name}` : name);
}

/** Folders go to the trash whole; Undo brings the whole folder back. */
async function deleteFolder(folder) {
  const n = notesIn(folder);
  try {
    const { trashed_to } = await api.trashNote(folder);
    navigate(folderHash(folderOf(folder)));
    await loadNotes();
    toast(`Moved “${folder.split('/').pop()}”${n ? ` and ${n === 1 ? 'its note' : `its ${n} notes`}` : ''} to trash`, {
      action: 'Undo',
      duration: 8000,
      onAction: async () => {
        try {
          const back = await api.restoreNote(trashed_to);
          await loadNotes();
          navigate(folderHash(back.path));
        } catch (err) {
          toast(`Couldn't restore: ${err.message}`);
        }
      },
    });
  } catch (err) {
    toast(err.message);
  }
}

/** Moves a note into `folder` keeping its file name. Returns the new path. */
async function moveNoteTo(path, folder) {
  if (folderOf(path) === folder) return path;
  const to = (folder ? folder + '/' : '') + path.split('/').pop();
  try {
    const moved = await api.moveNote(path, to);
    clearUnsaved(path);
    opened.rename(path, moved.path);
    return moved.path;
  } catch (err) {
    toast(err.status === 409 ? `A note called “${fileName(path)}” is already in ${folder || 'Notes'}` : err.message);
    return null;
  }
}

function wireFolders() {
  $('folder-crumbs').addEventListener('click', (e) => {
    const item = e.target.closest('[data-crumb]');
    if (item && !item.hasAttribute('current')) navigate(folderHash(item.dataset.crumb));
  });
  $('folder-actions').addEventListener('click', (e) => {
    const act = e.target.closest('[data-folder-act]')?.dataset.folderAct;
    const f = state.folder;
    if (act === 'new') newFolder(f);
    if (act === 'rename') renameFolder(f);
    if (act === 'move') moveFolder(f);
    if (act === 'delete') deleteFolder(f);
  });
  $('nav-folder-new')?.addEventListener('click', () => newFolder(''));
  $('nav-folders')?.addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle]');
    if (!t) return;
    e.preventDefault();
    const f = t.dataset.toggle;
    openFolders.has(f) ? openFolders.delete(f) : openFolders.add(f);
    saveOpen();
    renderFolderTree();
  });

  // Drag a card onto a folder (a tile, the sidebar, or the breadcrumb) to file it there.
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.note-card');
    if (!card) return;
    e.dataTransfer.setData('text/x-sink-note', card.dataset.path);
    e.dataTransfer.effectAllowed = 'move';
    document.body.classList.add('dragging-note');
  });
  document.addEventListener('dragend', () => {
    document.body.classList.remove('dragging-note');
    document.querySelectorAll('.drop-over').forEach((el) => el.classList.remove('drop-over'));
  });
  const target = (e) => (e.dataTransfer?.types.includes('text/x-sink-note') ? e.target.closest?.('[data-drop-folder]') : null);
  document.addEventListener('dragover', (e) => {
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.drop-over').forEach((el) => el !== t && el.classList.remove('drop-over'));
    t.classList.add('drop-over');
  });
  document.addEventListener('drop', async (e) => {
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    t.classList.remove('drop-over');
    const path = e.dataTransfer.getData('text/x-sink-note');
    const folder = t.dataset.dropFolder;
    const moved = await moveNoteTo(path, folder);
    if (moved && moved !== path) {
      await loadNotes();
      toast(`Moved to ${folder ? folder.split('/').pop() : 'Notes'}`, {
        action: 'Undo',
        onAction: async () => {
          if (await moveNoteTo(moved, folderOf(path))) loadNotes();
        },
      });
    }
  });
}

function wireGrid() {
  const open = (e) => {
    const card = e.target.closest('.note-card');
    if (card) openFromApp(noteHash(card.dataset.path));
  };
  for (const id of ['notes-grid', 'notes-pinned']) {
    $(id).addEventListener('click', open);
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open(e);
    });
  }
  wireFolders();

  // Keep's "Take a note…": collapsed until focused, saved when it loses focus or on Ctrl/Cmd+Enter.
  const box = $('take-note');
  const title = $('take-title');
  const body = $('take-body');
  const expand = () => box.classList.add('open');
  const reset = () => {
    title.value = body.value = '';
    box.classList.remove('open');
    body.style.height = '';
  };
  const commit = async () => {
    const t = title.value.trim();
    const b = body.value.replace(/\s+$/, '');
    if (!t && !b.trim()) return reset();
    reset();
    const content = t ? `# ${t}\n\n${b}${b ? '\n' : ''}` : `${b}\n`;
    try {
      await api.createNote({ folder: state.folder, title: t || b.split('\n')[0].replace(/^[-*+]\s+(\[.\]\s+)?/, '').slice(0, 60), content });
      await loadNotes();
    } catch (err) {
      toast(`Couldn't save: ${err.message}`);
      title.value = t;
      body.value = b;
      expand();
    }
  };
  body.addEventListener('focus', expand);
  title.addEventListener('focus', expand);
  body.addEventListener('input', () => {
    body.style.height = 'auto';
    body.style.height = `${body.scrollHeight}px`;
  });
  box.addEventListener('focusout', () => setTimeout(() => !box.contains(document.activeElement) && commit(), 0));
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
    if (e.key === 'Escape') document.activeElement.blur();
  });
  $('take-close').addEventListener('click', () => document.activeElement.blur());
  $('take-list').addEventListener('click', () => {
    expand();
    if (!body.value.trim()) body.value = '- [ ] ';
    body.focus();
  });
  $('take-board').addEventListener('click', () => newBoard());
  $('take-open').addEventListener('click', () => {
    const t = title.value.trim();
    const b = body.value;
    reset();
    openDraft({ text: t ? `# ${t}\n\n${b}` : b });
  });
}

// ---------- fullscreen note ----------

const screen = {
  path: null, // null while a new note is still a draft
  folder: '',
  hash: null,
  saved: '', // text as last saved / loaded
  editor: null,
  timer: null,
  saving: null,
  poll: null,
  color: null,
  pinned: false,
  failures: 0,
};

const dirty = () => screen.editor && screen.editor.getText() !== screen.saved;

function setStatus(text, kind = '') {
  const el = $('note-status');
  el.textContent = text;
  el.dataset.kind = kind;
}

function linkTargets() {
  return state.notes.filter((n) => !/\.excalidraw\.md$/i.test(n.path)).map((n) => ({ label: fileName(n.path), detail: folderOf(n.path) }));
}

async function openLink(target, { external } = {}) {
  if (external) return window.open(target, '_blank', 'noopener');
  const name = target.split('#')[0].replace(/\.md$/i, '').trim();
  const lower = name.toLowerCase();
  const hit =
    state.notes.find((n) => n.path.toLowerCase() === `${lower}.md`) ??
    state.notes.find((n) => fileName(n.path).toLowerCase() === lower.split('/').pop()) ??
    state.notes.find((n) => n.title.toLowerCase() === lower);
  await flush();
  if (hit) return navigate(noteHash(hit.path));
  // Like Obsidian: following a link to a note that doesn't exist creates it.
  try {
    const created = await api.createNote({ title: name.split('/').pop(), folder: name.includes('/') ? folderOf(name) : '', content: `# ${name.split('/').pop()}\n\n` });
    await loadNotes();
    navigate(noteHash(created.path));
  } catch (err) {
    toast(err.message);
  }
}

const isBoardPath = (path) => /\.excalidraw\.md$/i.test(path ?? '');

function isDark() {
  const scheme = document.getElementById('theme')?.getAttribute('scheme');
  return scheme === 'dark' || (scheme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
}

/** Excalidraw and React download only when a board opens. */
async function mountBoard(text) {
  screen.editor?.destroy();
  screen.editor = null;
  $('note-editor').innerHTML = '';
  $('note-screen').classList.add('board');
  window.EXCALIDRAW_ASSET_PATH = '/excalidraw/';
  const { createBoard } = await import('./board.js');
  screen.editor = createBoard({
    parent: $('note-editor'),
    text,
    dark: isDark(),
    attachmentUrl: (name) => api.attachmentUrl(name),
    upload: (file) => api.attach(file),
    onError: (err) => toast(`Image upload failed: ${err.message}`),
    onChange: () => {
      setStatus('Editing…');
      clearTimeout(screen.timer);
      screen.timer = setTimeout(save, SAVE_DELAY * 2);
    },
  });
}

/** New board in Boards/, named by the time like the Excalidraw plugin does. */
export async function newBoard() {
  try {
    const { emptyBoard } = await import('./board.js');
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
    const created = await api.createNote({ folder: 'Boards', title: `Drawing ${stamp}.excalidraw`, content: emptyBoard() });
    openFromApp(noteHash(created.path));
  } catch (err) {
    toast(`Couldn't make a board: ${err.message}`);
  }
}

function mountEditor(text) {
  screen.editor?.destroy();
  $('note-editor').innerHTML = '';
  $('note-screen').classList.remove('board');
  screen.editor = createEditor({
    parent: $('note-editor'),
    doc: text,
    placeholder: 'Note',
    onChange: () => {
      setStatus('Editing…');
      clearTimeout(screen.timer);
      screen.timer = setTimeout(save, SAVE_DELAY);
      if (screen.path) stashUnsaved();
    },
    onOpenLink: openLink,
    resolveEmbed: (name) => api.attachmentUrl(name),
    resolveImage: (src) => (/^(https?:|data:|\/)/i.test(src) ? src : api.attachmentUrl(decodeURIComponent(src).replace(/^(\.\.\/)+/, ''))),
    linkTargets,
    uploadFile: async (file) => {
      setStatus('Uploading…');
      const { embed } = await api.attach(file);
      return embed;
    },
    onError: (err) => toast(`Upload failed: ${err.message}`),
  });
}

/** Keeps unsaved text in the browser, so a crash or a dead NAS doesn't lose it. */
function stashUnsaved() {
  try {
    localStorage.setItem(draftKey(screen.path), JSON.stringify({ base: screen.hash, text: screen.editor.getText(), at: Date.now() }));
  } catch {}
}
function clearUnsaved(path) {
  try {
    localStorage.removeItem(draftKey(path));
  } catch {}
}
function readUnsaved(path) {
  try {
    return JSON.parse(localStorage.getItem(draftKey(path)));
  } catch {
    return null;
  }
}

function applyLook() {
  const el = $('note-screen');
  el.className = `note-screen${screen.color ? ` c-${screen.color}` : ''}${isBoardPath(screen.path) ? ' board' : ''}`;
  $('note-pin').innerHTML = ic('push_pin', '', screen.pinned ? ' filled' : '');
  $('note-pin').setAttribute('aria-label', screen.pinned ? 'Unpin' : 'Pin');
  $('note-crumb').textContent = screen.path ? folderOf(screen.path) || 'Notes' : 'New note';
  for (const b of $('note-colors').querySelectorAll('[data-color]')) b.classList.toggle('on', (b.dataset.color || null) === screen.color);
}

export async function openNote(path, { line } = {}) {
  if (screen.path === path && !$('note-screen').hidden) {
    if (line != null) screen.editor.goToLine(line);
    return;
  }
  await closeEditor();
  showScreen();
  setStatus('Opening…');
  try {
    const note = await api.note(path);
    Object.assign(screen, { path: note.path, folder: folderOf(note.path), hash: note.hash, saved: note.content, pinned: note.pinned, color: note.color });
    opened.touch(note.path);
    let text = note.content;
    // Unsaved edits from last time, made on this exact version: bring them back.
    const stash = readUnsaved(note.path);
    if (stash && stash.text !== note.content) {
      if (stash.base === note.hash) {
        text = stash.text;
        toast('Restored unsaved changes');
      } else clearUnsaved(note.path);
    }
    if (isBoardPath(note.path)) await mountBoard(text);
    else mountEditor(text);
    applyLook();
    renderBacklinks(note.path);
    if (text !== note.content) save();
    else setStatus(`Edited ${relative(note.mtime)}`);
    if (line != null) screen.editor.goToLine(line);
    // Ready to type at the end, except on touch screens where focusing would throw the keyboard up.
    else if (!note.content.trim() || !matchMedia('(pointer: coarse)').matches) screen.editor.focus(true);
    startPolling();
  } catch (err) {
    if (err instanceof Unauthorized) throw err;
    toast(err.status === 404 ? 'That note is gone' : `Can't open: ${err.message}`);
    hideScreen();
    navigate(state.folder ? `#/notes/${encodeURIComponent(state.folder)}` : '#/notes');
  }
}

/** A new note that becomes a file on its first save, so an abandoned "new note" leaves nothing behind. */
/** The "new note" button: a fresh draft that Back closes. */
export function newNote() {
  openFromApp('#/new');
}

export async function openDraft({ text = '', folder = state.folder } = {}) {
  await closeEditor();
  showScreen();
  Object.assign(screen, { path: null, folder, hash: null, saved: '', pinned: false, color: null });
  mountEditor(text);
  applyLook();
  setStatus('');
  screen.editor.focus(true);
  if (text) save();
}

function showScreen() {
  $('note-screen').hidden = false;
  document.body.classList.add('note-open');
}
function hideScreen() {
  $('note-screen').hidden = true;
  document.body.classList.remove('note-open');
}

/** Saves now if there's anything unsaved; resolves when the file is written (or the save failed). */
async function flush() {
  clearTimeout(screen.timer);
  if (screen.saving) await screen.saving;
  if (dirty()) await save();
}

function save() {
  clearTimeout(screen.timer);
  if (screen.saving) {
    // One save at a time; the latest text goes in the next one.
    screen.timer = setTimeout(save, SAVE_DELAY);
    return screen.saving;
  }
  screen.saving = doSave().finally(() => (screen.saving = null));
  return screen.saving;
}

async function doSave() {
  if (!screen.editor) return;
  const text = screen.editor.getText();
  if (text === screen.saved) return setStatus('Saved');
  setStatus('Saving…');
  try {
    if (!screen.path) {
      if (!text.trim()) return;
      const heading = /^#\s+(.+)$/m.exec(text)?.[1];
      const title = heading ?? text.trim().split('\n')[0].replace(/^[-*+]\s+(\[.\]\s+)?|^#+\s+/g, '').slice(0, 60);
      const created = await api.createNote({ folder: screen.folder, title, content: text });
      Object.assign(screen, { path: created.path, hash: created.hash, saved: text });
      history.replaceState(history.state, '', noteHash(created.path));
      applyLook();
    } else {
      const saved = await api.saveNote(screen.path, text, screen.hash);
      Object.assign(screen, { hash: saved.hash, saved: text });
      clearUnsaved(screen.path);
    }
    screen.failures = 0;
    setStatus(dirty() ? 'Editing…' : 'Saved');
    if (dirty()) screen.timer = setTimeout(save, SAVE_DELAY);
  } catch (err) {
    if (err instanceof Unauthorized) throw err;
    if (err instanceof ApiError && err.status === 409 && err.body?.current) return resolveConflict(text, err.body.current);
    if (err instanceof ApiError && err.status === 409 && screen.path) return resolveConflict(text, null);
    // NAS down or offline: keep the text locally and keep trying.
    screen.failures++;
    setStatus(navigator.onLine ? "Can't save, retrying" : 'Offline, will save', 'error');
    if (screen.path) stashUnsaved();
    screen.timer = setTimeout(save, Math.min(30_000, 2000 * 2 ** Math.min(screen.failures, 4)));
  }
}

/**
 * The file changed elsewhere since we loaded it. Their version wins the file; ours is kept as a sibling note,
 * so nothing is lost and nothing is merged wrongly.
 */
async function resolveConflict(mine, current) {
  if (current && current.content === mine) {
    Object.assign(screen, { hash: current.hash, saved: mine });
    return setStatus('Saved');
  }
  const stamp = new Date().toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[/:,]/g, '-');
  try {
    const copy = await api.createNote({ folder: screen.folder, title: `${fileName(screen.path)} (conflict ${stamp})`, content: mine });
    clearUnsaved(screen.path);
    if (current) {
      Object.assign(screen, { hash: current.hash, saved: current.content, pinned: current.pinned, color: current.color });
      screen.editor.setText(current.content);
      applyLook();
    } else {
      // Deleted elsewhere: carry on in the copy.
      history.replaceState(history.state, '', noteHash(copy.path));
      Object.assign(screen, { path: copy.path, hash: copy.hash, saved: mine });
    }
    toast(`Changed somewhere else. Your version was saved as “${fileName(copy.path)}”.`, { duration: 8000 });
    setStatus('Saved');
    loadNotes();
  } catch (err) {
    setStatus("Can't save", 'error');
    toast(`Conflict, and couldn't save a copy: ${err.message}`);
  }
}

/** Picks up edits made elsewhere while the note sits open and untouched. */
function startPolling() {
  clearInterval(screen.poll);
  screen.poll = setInterval(async () => {
    if (!screen.path || dirty() || screen.saving || document.hidden) return;
    try {
      const note = await api.note(screen.path);
      if (note.hash !== screen.hash && !dirty()) {
        Object.assign(screen, { hash: note.hash, saved: note.content, pinned: note.pinned, color: note.color });
        screen.editor.setText(note.content);
        applyLook();
        setStatus(`Updated ${relative(note.mtime)}`);
      }
    } catch {}
  }, POLL_MS);
}

/** "Linked mentions" under the note: the notes that link here, each with the lines that do. */
async function renderBacklinks(path) {
  const box = $('note-links');
  box.hidden = true;
  box.innerHTML = '';
  if (isBoardPath(path)) return;
  let items;
  try {
    ({ items } = await api.backlinks(path));
  } catch {
    return;
  }
  // Still on this note, and there's something to show.
  if (screen.path !== path || !items.length) return;
  box.innerHTML = backlinksHtml(items, { href: noteHash, icon: ic('description') });
  box.hidden = false;
}

async function closeEditor() {
  if (!screen.editor) return;
  clearInterval(screen.poll);
  await flush();
  if (dirty() && screen.path) stashUnsaved();
  screen.editor.destroy();
  screen.editor = null;
  screen.path = null;
  $('note-links').hidden = true;
}

export async function closeNote() {
  await closeEditor();
  hideScreen();
  loadNotes();
}

export const noteIsOpen = () => !$('note-screen').hidden;

async function setMeta(changes) {
  await flush();
  if (!screen.path) {
    // A draft gets saved first so there's a file to pin.
    if (!screen.editor.getText().trim()) return toast('Write something first');
    await save();
    if (!screen.path) return;
  }
  try {
    const meta = await api.noteMeta(screen.path, changes);
    const note = await api.note(meta.path);
    Object.assign(screen, { hash: note.hash, saved: note.content, pinned: note.pinned, color: note.color });
    if (!dirty()) screen.editor.setText(note.content);
    applyLook();
  } catch (err) {
    toast(err.message);
  }
}

function wireScreen() {
  const back = () => {
    if (openedInApp) {
      openedInApp = false;
      history.back();
    } else navigate(screen.folder ? `#/notes/${encodeURIComponent(screen.folder)}` : '#/notes');
  };
  $('note-back').addEventListener('click', back);
  // The empty page below the text is part of the note: clicking it puts the cursor at the end, like Keep.
  document.querySelector('#note-screen .note-scroll').addEventListener('mousedown', (e) => {
    if (!screen.editor || isBoardPath(screen.path) || e.target.closest('.cm-content')) return;
    e.preventDefault();
    screen.editor.focus(true);
  });
  $('note-screen').addEventListener('keydown', (e) => {
    // Excalidraw uses Escape itself (leave a tool, deselect), so it never closes a board.
    if (e.key === 'Escape' && !document.querySelector('.cm-tooltip-autocomplete') && !isBoardPath(screen.path)) {
      e.preventDefault();
      back();
    }
    if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      flush();
    }
  });
  $('note-pin').addEventListener('click', () => setMeta({ pinned: !screen.pinned }));
  $('note-palette').addEventListener('click', () => ($('note-colors').hidden = !$('note-colors').hidden));
  $('note-colors').innerHTML =
    `<button data-color="" class="note-swatch none" aria-label="No colour">${ic('format_color_reset')}</button>` +
    COLORS.map((c) => `<button data-color="${c}" class="note-swatch c-${c}" aria-label="${c}" title="${c}"></button>`).join('');
  $('note-colors').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    $('note-colors').hidden = true;
    setMeta({ color: b.dataset.color || null });
  });

  const relocate = (path) => {
    opened.rename(screen.path, path);
    Object.assign(screen, { path, folder: folderOf(path) });
    history.replaceState(history.state, '', noteHash(path));
    applyLook();
  };
  $('note-move').addEventListener('click', async () => {
    await flush();
    if (!screen.path) return toast('Write something first');
    const dest = await pickFolder({
      title: `Move “${fileName(screen.path)}” to…`,
      folders: state.folders.filter(shownFolder),
      current: screen.folder,
      createFolder: (path) => api.createFolder(path),
    });
    if (dest === null || dest === screen.folder) return;
    const moved = await moveNoteTo(screen.path, dest);
    if (moved) {
      relocate(moved);
      toast(`Moved to ${dest ? dest.split('/').pop() : 'Notes'}`);
    }
  });
  $('note-rename').addEventListener('click', async () => {
    await flush();
    if (!screen.path) return toast('Write something first');
    const ext = isBoardPath(screen.path) ? '.excalidraw.md' : '.md';
    const name = await askText({ title: 'Rename', value: screen.path.split('/').pop().slice(0, -ext.length), action: 'Rename' });
    if (!name) return;
    const to = (screen.folder ? screen.folder + '/' : '') + name.replace(/(\.excalidraw)?\.md$/i, '') + ext;
    if (to === screen.path) return;
    try {
      const { path } = await api.moveNote(screen.path, to);
      clearUnsaved(screen.path);
      relocate(path);
    } catch (err) {
      toast(err.status === 409 ? `There's already a note called “${name}” here` : err.status === 400 ? 'Names can’t start with a dot or contain \\ : * ? " < > |' : err.message);
    }
  });

  $('note-history').addEventListener('click', async () => {
    if (!screen.path || !screen.editor) return;
    await flush();
    const path = screen.path;
    let versions;
    try {
      ({ items: versions } = await api.versions(path));
    } catch (err) {
      return toast(err.message);
    }
    const when = (at) =>
      new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const text = await pickVersion({ versions, load: (id) => api.version(path, id), when });
    if (text == null || screen.path !== path) return;
    try {
      // keep_version: what's here now becomes a version too, so a restore can itself be undone from this list.
      const saved = await api.saveNote(path, text, screen.hash, {}, { keep_version: true });
      Object.assign(screen, { hash: saved.hash, saved: text });
      screen.editor.setText(text);
      setStatus('Restored');
      toast('Restored that version. The text it replaced is in the history too.');
    } catch (err) {
      toast(err.status === 409 ? 'This note changed elsewhere just now. Try again.' : err.message);
    }
  });

  $('note-download').addEventListener('click', () => {
    const blob = new Blob([screen.editor.getText()], { type: 'text/markdown' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: screen.path ? screen.path.split('/').pop() : 'note.md' });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('note-delete').addEventListener('click', async () => {
    if (!screen.path) {
      screen.editor.setText('');
      Object.assign(screen, { saved: '' });
      return back();
    }
    // No "are you sure?": the snackbar's Undo (and the Trash page) put it back.
    await flush();
    try {
      const { trashed_to } = await api.trashNote(screen.path);
      clearUnsaved(screen.path);
      screen.saved = screen.editor.getText();
      toast('Moved to trash', { action: 'Undo', onAction: () => restore(trashed_to) });
      back();
      loadNotes();
    } catch (err) {
      toast(err.message);
    }
  });

  // Last chance for unsaved text when the tab closes: a keepalive request outlives the page.
  window.addEventListener('pagehide', () => {
    if (!dirty() || !screen.path) return;
    stashUnsaved();
    api.saveNote(screen.path, screen.editor.getText(), screen.hash, { keepalive: true }).catch(() => {});
  });
}

// ---------- trash ----------

const trashState = { items: [], days: 0, loaded: false };

async function restore(trashPath) {
  try {
    const note = await api.restoreNote(trashPath);
    toast(`Restored “${note.title}”`);
    await loadNotes();
    if (!$('trash').hidden) loadTrash();
  } catch (err) {
    if (err instanceof Unauthorized) throw err;
    toast(`Couldn't restore: ${err.message}`);
  }
}

export async function loadTrash() {
  try {
    const { items, days } = await api.trash();
    Object.assign(trashState, { items, days, loaded: true });
  } catch (err) {
    if (err instanceof Unauthorized) throw err;
    toast(`Can't load the trash: ${err.message}`);
  }
  renderTrash();
}

function renderTrash() {
  if ($('trash').hidden) return;
  const { items, days, loaded } = trashState;
  $('trash-info').textContent = days ? `Notes deleted in Sink are removed for good after ${days} days.` : 'Notes stay here until you empty the trash.';
  $('trash-empty').hidden = !items.length;
  $('trash-none').hidden = !loaded || items.length > 0;
  $('trash-list').innerHTML = items
    .map((t) => {
      const folder = folderOf(t.original);
      return `<article class="trash-row" data-trash="${esc(t.path)}">
  <span class="trash-icon">${ic(isBoardPath(t.path) ? 'draw' : 'description')}</span>
  <div class="grow">
    <div class="trash-title">${esc(t.title)}</div>
    ${t.excerpt ? `<div class="muted small trash-excerpt">${esc(t.excerpt.split('\n').slice(0, 2).join(' · '))}</div>` : ''}
    <div class="muted small">${folder ? `${ic('folder')}${esc(folder)} · ` : ''}deleted ${relative(t.deleted_at)}</div>
  </div>
  <m3e-button data-restore variant="tonal" size="small">Put back</m3e-button>
  <m3e-icon-button data-forever aria-label="Delete for good" title="Delete for good">${ic('delete_forever')}</m3e-icon-button>
</article>`;
    })
    .join('');
}

function wireTrash() {
  $('trash-list').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-trash]');
    if (!row) return;
    const path = row.dataset.trash;
    if (e.target.closest('[data-restore]')) return restore(path);
    if (e.target.closest('[data-forever]')) {
      const item = trashState.items.find((t) => t.path === path);
      if (!confirm(`Delete “${item?.title ?? fileName(path)}” for good? This can't be undone.`)) return;
      try {
        await api.deleteForever(path);
        loadTrash();
      } catch (err) {
        toast(err.message);
      }
    }
  });
  $('trash-empty').addEventListener('click', async () => {
    const n = trashState.items.length;
    if (!confirm(`Delete ${n === 1 ? 'this note' : `all ${n} notes`} in the trash for good? This can't be undone.`)) return;
    try {
      await api.emptyTrash();
      toast('Trash emptied');
      loadTrash();
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- todos ----------

const todoState = { open: [], done: null, today: '' };

export async function loadTodos() {
  try {
    const { todos, today } = await api.todos('open');
    todoState.open = todos;
    todoState.today = today;
    if (todoState.done) todoState.done = (await api.todos('done')).todos;
  } catch (err) {
    if (err instanceof Unauthorized) throw err;
    toast(`Can't load todos: ${err.message}`);
  }
  renderTodos();
}

function dueLabel(due) {
  if (!due) return '';
  const today = todoState.today;
  const days = Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days < 7) return new Date(`${due}T12:00`).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(`${due}T12:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function todoRow(t) {
  const done = t.status !== 'open';
  const overdue = !done && t.due && t.due < todoState.today;
  const time = t.remind_at && /\(@\d{4}-\d{2}-\d{2}[ T]\d/.test(t.raw) ? new Date(t.remind_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  return `
<li class="todo${done ? ' done' : ''}" data-key="${esc(t.path)}:${t.line}">
  <input type="checkbox" class="todo-box" ${done ? 'checked' : ''} aria-label="${esc(t.text)}" />
  <div class="todo-main">
    <span class="todo-text">${esc(t.text || '(empty)')}</span>
    <span class="todo-meta">
      ${t.due ? `<span class="due${overdue ? ' overdue' : ''}">${ic('event')}${esc(dueLabel(t.due))}${time ? ` ${esc(time)}` : ''}</span>` : ''}
      ${t.path === 'Todo.md' ? '' : `<a class="todo-note" href="${noteHash(t.path, t.line)}">${ic('description')}${esc(t.note_title)}</a>`}
    </span>
  </div>
</li>`;
}

function renderTodos() {
  const root = $('todos');
  if (!root || root.hidden) return;
  const today = todoState.today;
  const groups = [
    ['Overdue', todoState.open.filter((t) => t.due && t.due < today)],
    ['Today', todoState.open.filter((t) => t.due === today)],
    ['Upcoming', todoState.open.filter((t) => t.due && t.due > today)],
    ['Someday', todoState.open.filter((t) => !t.due)],
  ].filter(([, items]) => items.length);
  $('todo-list').innerHTML = groups.length
    ? groups.map(([name, items]) => `<section class="todo-group"><h2 class="day">${name}<span>${items.length}</span></h2><ul>${items.map(todoRow).join('')}</ul></section>`).join('')
    : `<div class="empty"><m3e-shape name="sunny" class="empty-shape"></m3e-shape><h2 class="empty-title">All clear</h2>
       <p class="muted">Add one above, or write <code>- [ ] thing</code> in any note.</p></div>`;
  $('todo-done-toggle').textContent = todoState.done ? 'Hide done' : 'Show done';
  $('todo-done').innerHTML = todoState.done
    ? todoState.done.length
      ? `<ul>${todoState.done.slice(0, 100).map(todoRow).join('')}</ul>`
      : '<p class="muted">Nothing ticked off yet.</p>'
    : '';
}

function findTodo(key) {
  return [...todoState.open, ...(todoState.done ?? [])].find((t) => `${t.path}:${t.line}` === key);
}

function wireTodos() {
  $('todos').addEventListener('change', async (e) => {
    if (!e.target.classList.contains('todo-box')) return;
    const li = e.target.closest('.todo');
    const t = findTodo(li.dataset.key);
    if (!t) return;
    li.classList.toggle('done', e.target.checked);
    try {
      await api.toggleTodo(t, e.target.checked);
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.status === 409 ? 'That todo changed; reloaded' : err.message);
    }
    // Let the tick show before the row moves.
    setTimeout(loadTodos, 350);
  });
  $('todo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('todo-text').value.trim();
    if (!text) return;
    const due = $('todo-date').value || undefined;
    const time = (due && $('todo-time').value) || undefined;
    try {
      await api.addTodo({ text, due, time });
      $('todo-text').value = '';
      $('todo-date').value = $('todo-time').value = '';
      loadTodos();
    } catch (err) {
      toast(err.message);
    }
  });
  $('todo-done-toggle').addEventListener('click', async () => {
    todoState.done = todoState.done ? null : [];
    if (todoState.done) await loadTodos();
    else renderTodos();
  });
}

/** Buttons plugins add next to "Take a note" (e.g. Today's note). */
function renderGridActions() {
  const box = $('take-plugins');
  box.innerHTML = registry.gridActions
    .map((a, i) => `<m3e-icon-button data-plugin-action="${i}" aria-label="${esc(a.label)}" title="${esc(a.label)}">${ic(a.icon || 'extension')}</m3e-icon-button>`)
    .join('');
}

function wireGridActions() {
  renderGridActions();
  onRegistryChange(renderGridActions);
  $('take-plugins').addEventListener('click', async (e) => {
    const action = registry.gridActions[e.target.closest('[data-plugin-action]')?.dataset.pluginAction];
    if (!action) return;
    try {
      await action.run({ openNote: (path) => openFromApp(noteHash(path)), toast });
    } catch (err) {
      toast(`${action.label}: ${err.message}`);
    }
  });
}

export function wireNotes() {
  wireGrid();
  wireGridActions();
  wireScreen();
  wireTodos();
  wireTrash();
}

export const notesRendered = () => renderGrid();
export const todosRendered = () => renderTodos();
