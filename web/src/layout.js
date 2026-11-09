// The web app's layout on wide screens, chosen per account (PATCH /api/prefs) so every browser you sign in on gets it:
//   classic: the original sidebar and sheet; a note opens fullscreen.
//   keep, split and tabs share one shell (the top bar, sidebar, grid and the note's bar and details panel) so they
//   feel like one app; they differ in where a note opens: a dialog over the grid (keep), a pane beside it (split),
//   or a tab of its own (tabs).
// Phones and narrow windows always get Classic, which is the mobile layout there.

import { api } from './api.js';
import * as notes from './notes.js';
import { COLORS, folderHash, noteHash } from './notes.js';
import { esc, folderOf } from './util.js';

const $ = (id) => document.getElementById(id);
const ic = (name, more = '') => `<m3e-icon name="${esc(name)}"${more}></m3e-icon>`;

export const LAYOUTS = [
  { id: 'classic', label: 'Classic', about: 'Sidebar and a big sheet. Notes open full screen.' },
  { id: 'keep', label: 'Keep', about: 'Notes open in a window over the grid.' },
  { id: 'split', label: 'Split', about: 'Notes open in a pane beside the grid.' },
  { id: 'tabs', label: 'Tabs', about: 'Notes open in tabs, like a browser.' },
];

const WIDE = matchMedia('(min-width: 1024px)');
const CACHE = 'sink:layout';
const local = {
  get: (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

let deps = { toast: () => {}, toggleTheme: () => {}, openNewMenu: () => {}, searchTag: () => {} };
// The last prefs seen; cached so a reload starts in the right layout before the server answers.
let prefs = local.get(CACHE, {});

export const chosenLayout = () => prefs.layout ?? 'classic';
const current = () => (WIDE.matches ? chosenLayout() : 'classic');

// Where the search bar and New button live in Classic, to put them back.
const homes = new Map();
const moveTo = (el, slot) => {
  if (!homes.has(el)) homes.set(el, [el.parentNode, el.nextSibling]);
  if (slot) slot.append(el);
  else {
    const [parent, next] = homes.get(el);
    parent.insertBefore(el, next);
  }
};

function apply() {
  const layout = current();
  const app = $('app');
  app.dataset.layout = layout;
  app.classList.toggle('desk', layout !== 'classic');
  const desk = layout !== 'classic';
  app.classList.toggle('desk', desk);
  // Until you open or close it yourself, a narrower window starts with the sidebar as the icon rail.
  app.classList.toggle('nav-shut', local.get('sink:nav-shut', innerWidth < 1280));
  app.classList.toggle('info-shut', local.get('sink:info-shut', false));
  app.classList.remove('rail-open');
  $('topbar').hidden = !desk;
  $('top-tabs').hidden = layout !== 'tabs';

  moveTo(document.querySelector('#search-row m3e-search-bar, #top-search m3e-search-bar'), desk ? $('top-search') : null);
  moveTo($('add-btn'), desk ? $('top-new') : null);
  $('add-btn').setAttribute('variant', desk ? 'filled' : 'tonal');

  // The note's bar: a close button where the note sits over, beside or in place of the grid; an arrow on Classic's page.
  $('note-back').querySelector('m3e-icon').setAttribute('name', desk ? 'close' : 'arrow_back');
  $('note-share').querySelector('m3e-icon').setAttribute('name', desk ? 'ios_share' : 'share');
  $('note-more').querySelector('m3e-icon').setAttribute('name', desk ? 'more_horiz' : 'more_vert');
  // Rounded squares in the denser desktop bars, as the tabs and cards are; Classic keeps Material's circles.
  for (const b of document.querySelectorAll('.note-bar m3e-icon-button')) {
    if (desk) b.setAttribute('shape', 'square');
    else b.removeAttribute('shape');
  }
  if (!desk) $('note-screen').classList.remove('expanded');
  renderAll();
}

function renderAll() {
  renderCrumbs();
  renderTabs();
  renderInfo();
}

/** Applies prefs from the server; `fresh` is what it just sent. */
function take(fresh) {
  const changed = fresh.layout !== prefs.layout;
  prefs = fresh;
  local.set(CACHE, prefs);
  if (changed) apply();
  // Chosen in another browser while this one was asking.
  if (prefs.layoutChosen) document.querySelector('.layout-dialog')?.remove();
}

async function refresh() {
  try {
    take(await api.prefs());
  } catch {}
}

export async function chooseLayout(layout) {
  take({ ...prefs, layout, layoutChosen: true });
  try {
    take(await api.setPrefs({ layout, layoutChosen: true }));
  } catch (err) {
    deps.toast(`Couldn't save the layout: ${err.message}`);
  }
}

// ---------- picker (Settings and first sign-in) ----------

/** A tiny drawing of each layout: sidebar, bars, cards and the note, as boxes. */
function thumb(id) {
  const r = (x, y, w, h, cls = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" class="${cls}"/>`;
  const cards = (x0, y0, cols, w, rows = 2) =>
    Array.from({ length: cols * rows }, (_, i) => r(x0 + (i % cols) * (w + 4), y0 + Math.floor(i / cols) * 20, w, 16, 'lt-card')).join('');
  const shapes = {
    classic: r(4, 4, 26, 72, 'lt-side') + r(34, 4, 82, 72, 'lt-sheet') + r(40, 10, 40, 6, 'lt-ink') + r(40, 20, 70, 7, 'lt-bar') + cards(40, 32, 3, 20),
    keep: r(0, 0, 120, 12, 'lt-top') + r(70, 3, 34, 6, 'lt-bar') + r(4, 16, 22, 60, 'lt-side') + cards(32, 18, 4, 18) + r(44, 24, 52, 46, 'lt-note'),
    split: r(0, 0, 120, 12, 'lt-top') + r(70, 3, 34, 6, 'lt-bar') + r(4, 16, 22, 60, 'lt-side') + cards(30, 18, 2, 18, 3) + r(72, 16, 44, 60, 'lt-note'),
    tabs: r(0, 0, 120, 12, 'lt-top') + r(70, 3, 34, 6, 'lt-bar') + r(30, 14, 18, 7, 'lt-tab') + r(50, 14, 18, 7, 'lt-bar') + r(4, 24, 22, 52, 'lt-side') + r(30, 24, 86, 52, 'lt-note'),
  };
  return `<svg viewBox="0 0 120 80" aria-hidden="true">${shapes[id]}</svg>`;
}

export function layoutPickerHtml(selected = chosenLayout()) {
  return `<div class="layout-pick" role="radiogroup" aria-label="Layout">${LAYOUTS.map(
    (l) => `<button type="button" class="layout-option${l.id === selected ? ' on' : ''}" role="radio" aria-checked="${l.id === selected}" data-layout-pick="${l.id}">
  ${thumb(l.id)}<span class="layout-name">${l.label}</span><span class="layout-about">${l.about}</span></button>`,
  ).join('')}</div>`;
}

/** Clicks on a picker inside `root` choose that layout. */
export function wirePicker(root, after = () => {}) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-layout-pick]');
    if (!b) return;
    for (const o of root.querySelectorAll('[data-layout-pick]')) {
      o.classList.toggle('on', o === b);
      o.setAttribute('aria-checked', String(o === b));
    }
    chooseLayout(b.dataset.layoutPick);
    after();
  });
}

/** Once per account, on a wide screen: which layout. Closing it keeps Classic and doesn't ask again. */
function askLayout() {
  const dlg = document.createElement('dialog');
  dlg.className = 'sink-dialog layout-dialog';
  dlg.innerHTML = `<div class="sink-dialog-body">
<h2>Pick a layout</h2>
<p class="muted">How Sink looks on big screens. It follows you to every browser you sign in on; phones keep their own. Change it any time in Settings.</p>
${layoutPickerHtml(null)}
<div class="dialog-actions"><m3e-button variant="text" data-keep>Keep Classic</m3e-button></div>
</div>`;
  $('theme').append(dlg);
  const done = () => {
    dlg.close();
    dlg.remove();
  };
  wirePicker(dlg, done);
  dlg.querySelector('[data-keep]').addEventListener('click', () => {
    chooseLayout('classic');
    done();
  });
  dlg.addEventListener('cancel', () => chooseLayout('classic'));
  dlg.showModal();
}

// ---------- top bar ----------

/** Split's path: the open note's folder, else the folder being browsed. Each part goes there. */
function renderCrumbs() {
  if (current() === 'classic') return;
  const info = notes.openNoteInfo();
  const route = location.hash.replace(/^#\/?/, '').split('?')[0];
  const folder = info.open ? info.folder : route.startsWith('notes') ? notes.currentFolder() : '';
  const titles = { todos: 'Todos', trash: 'Trash', settings: 'Settings' };
  const parts = folder ? folder.split('/') : [];
  const view = titles[route.split('/')[0]];
  $('top-crumbs').innerHTML = view
    ? `<span class="crumb current">${view}</span>`
    : [`<a class="crumb${parts.length ? '' : ' current'}" href="#/notes">Notes</a>`, ...parts.map((p, i) => `<a class="crumb${i === parts.length - 1 ? ' current' : ''}" href="${folderHash(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`)].join('<span class="crumb-sep">/</span>');
}

// ---------- tabs ----------

// Open tabs by note path ('' is a new note not saved yet), kept per browser.
const DRAFT = '';
let tabs = local.get('sink:tabs', []).filter((t) => typeof t === 'string' && t);
// The note shown last; a different path while it stays open means it moved or a draft was saved.
let shown = null;
// The last note shown, kept across the moment between closing one and opening the next: new tabs open beside it.
let beside = null;
// Tabs already drawn, so only new ones animate in. The ones open at load count as already there.
let seenTabs = new Set(tabs);

const saveTabs = () => local.set('sink:tabs', tabs.filter((t) => t !== DRAFT));
const tabTitle = (path) =>
  path === DRAFT ? 'New note' : (notes.allNotes().find((n) => n.path === path)?.title ?? path.split('/').pop().replace(/(\.excalidraw)?\.md$/i, ''));

function followNote() {
  const info = notes.openNoteInfo();
  const key = info.open ? (info.path ?? DRAFT) : null;
  if (key === null) {
    // A draft left without saving is gone, and so is its tab.
    tabs = tabs.filter((t) => t !== DRAFT);
  } else if (shown !== null && shown !== key && tabs.includes(shown)) {
    // Moved or saved for the first time: its tab follows. Archived, it's put away, so its tab closes.
    const archived = /^archive\//i.test(key);
    tabs = tabs.includes(key) || archived ? tabs.filter((t) => t !== shown) : tabs.map((t) => (t === shown ? key : t));
  } else if (!tabs.includes(key) && current() === 'tabs') {
    // Only Tabs opens tabs; notes opened in the other layouts don't pile up for later.
    const at = tabs.indexOf(beside);
    tabs.splice(at < 0 ? tabs.length : at + 1, 0, key);
  }
  shown = key;
  if (key !== null) beside = key;
  saveTabs();
  renderAll();
}

function renderTabs() {
  if (current() !== 'tabs') return;
  // Notes deleted or moved elsewhere drop out once the list knows about them.
  const known = new Set(notes.allNotes().map((n) => n.path));
  if (known.size) tabs = tabs.filter((t) => t === DRAFT || t === shown || known.has(t));
  const tab = (key, href, icon, label, closable) =>
    `<a class="top-tab${key === shown ? ' on' : ''}" href="${href}" data-tab="${esc(key ?? '')}" title="${esc(label)}">${ic(icon)}<span>${esc(label)}</span>${
      closable ? `<button type="button" class="tab-close" data-close-tab="${esc(key)}" aria-label="Close ${esc(label)}">${ic('close')}</button>` : ''
    }</a>`;
  const home = shown === null && /^#\/(notes|$)|^$|^#\/?$/.test(location.hash);
  $('top-tabs').innerHTML =
    `<a class="top-tab home${home ? ' on' : ''}" href="${folderHash(notes.currentFolder())}">${ic('grid_view')}<span>Home</span></a>` +
    tabs
      .map((t) => {
        const board = /\.excalidraw\.md$/i.test(t);
        return tab(t, t === DRAFT ? '#/new' : noteHash(t), board ? 'draw' : 'sticky_note_2', tabTitle(t), true);
      })
      .join('');
  // Tabs that weren't there before ease in; the rest stay put.
  for (const t of $('top-tabs').querySelectorAll('[data-tab]')) if (!seenTabs.has(t.dataset.tab)) t.classList.add('enter');
  seenTabs = new Set(tabs);
  $('top-tabs').querySelector('.top-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  showMoreTabs();
}

/** Fades the strip's edges where tabs are scrolled out of sight. */
function showMoreTabs() {
  const strip = $('top-tabs');
  strip.classList.toggle('more-left', strip.scrollLeft > 1);
  strip.classList.toggle('more-right', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
}

function closeTab(key) {
  const at = tabs.indexOf(key);
  tabs = tabs.filter((t) => t !== key);
  saveTabs();
  if (key !== shown) return renderTabs();
  // The tab you're on: go to the one beside it, as browsers do, or home.
  const next = tabs[Math.min(at, tabs.length - 1)];
  location.hash = next ? noteHash(next) : folderHash(notes.currentFolder());
}

// ---------- details panel (Tabs) ----------

function outlineOf(text) {
  const out = [];
  let fenced = false;
  const lines = text.split('\n');
  // Frontmatter isn't part of the outline.
  let i = /^---\r?$/.test(lines[0]) ? lines.indexOf('---', 1) + 1 : 0;
  for (; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    const h = !fenced && /^(#{1,6})\s+(.+?)\s*#*$/.exec(lines[i]);
    if (h) out.push({ line: i, depth: h[1].length, text: h[2] });
  }
  const top = Math.min(...out.map((h) => h.depth));
  return out.map((h) => ({ ...h, depth: h.depth - top }));
}

const when = (at) => {
  const d = new Date(at);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
};

let infoSeq = 0;
async function renderInfo() {
  const box = $('note-info');
  const info = notes.openNoteInfo();
  // Counted before anything else, so a slow fetch for the last note doesn't fill in the panel after it's gone.
  const seq = ++infoSeq;
  if (current() === 'classic' || !info.open || info.board) {
    box.innerHTML = '';
    return;
  }
  const note = notes.allNotes().find((n) => n.path === info.path);
  const folders = ['', ...notes.allFolders()].sort((a, b) => a.localeCompare(b));
  const section = (title, body, extra = '') => `<section class="info-section"><h3>${title}${extra}</h3>${body}</section>`;
  const row = (label, value) => `<div class="info-row"><span class="info-label">${label}</span>${value}</div>`;
  box.innerHTML =
    section(
      'Note',
      row(
        'Folder',
        `<select id="info-folder" aria-label="Folder"${info.path ? '' : ' disabled'}>${folders
          .map((f) => `<option value="${esc(f)}"${f === info.folder ? ' selected' : ''}>${esc(f || 'Notes')}</option>`)
          .join('')}</select>`,
      ) +
        row(
          'Colour',
          `<span class="info-swatches">${['', ...COLORS]
            .map((c) => `<button type="button" class="note-swatch${c ? ` c-${c}` : ' none'}${(info.color ?? '') === c ? ' on' : ''}" data-info-color="${c}" aria-label="${c || 'No colour'}" title="${c || 'No colour'}"></button>`)
            .join('')}</span>`,
        ) +
        row('Tags', `<span class="info-tags">${(note?.tags ?? []).map((t) => `<a class="info-tag" href="#/notes" data-tag="${esc(t)}">#${esc(t)}</a>`).join('') || '<span class="muted">None</span>'}</span>`) +
        row('Pinned', `<button type="button" class="info-toggle" data-info-pin>${info.pinned ? 'Yes' : 'No'}</button>`),
    ) +
    `<div id="info-outline"></div><div id="info-links"></div><div id="info-history"></div>`;
  renderOutline();
  if (!info.path) return;
  const [links, versions] = await Promise.all([api.backlinks(info.path).then((r) => r.items, () => []), api.versions(info.path).then((r) => r.items, () => [])]);
  if (seq !== infoSeq) return;
  $('info-links').innerHTML = links.length
    ? section(
        'Backlinks',
        links
          .map((b) => `<a class="info-backlink" href="${esc(noteHash(b.path))}"><b>${esc(b.title)}</b><span>${esc((b.lines[0] ?? '').replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').slice(0, 90))}</span></a>`)
          .join(''),
        `<span class="info-count">${links.length}</span>`,
      )
    : '';
  $('info-history').innerHTML = versions.length
    ? section(
        'History',
        versions
          .slice(0, 6)
          .map((v) => `<button type="button" class="info-version" data-info-history><span>${esc(when(v.at))}</span><span class="muted">${esc(v.preview.slice(0, 40))}</span></button>`)
          .join(''),
      )
    : '';
}

function renderOutline() {
  const box = $('info-outline');
  if (!box) return;
  const heads = outlineOf(notes.openNoteInfo().text);
  box.innerHTML = heads.length
    ? `<section class="info-section"><h3>Outline</h3>${heads
        .map((h) => `<button type="button" class="info-heading" style="--depth:${Math.min(h.depth, 3)}" data-line="${h.line}">${esc(h.text.replace(/[*_`[\]]/g, ''))}</button>`)
        .join('')}</section>`
    : '';
}

function wireInfo() {
  const box = $('note-info');
  box.addEventListener('change', (e) => {
    if (e.target.id === 'info-folder') notes.moveOpenNote(e.target.value);
  });
  box.addEventListener('click', (e) => {
    const colour = e.target.closest('[data-info-color]');
    if (colour) return notes.setOpenMeta({ color: colour.dataset.infoColor || null });
    if (e.target.closest('[data-info-pin]')) return notes.setOpenMeta({ pinned: !notes.openNoteInfo().pinned });
    if (e.target.closest('[data-info-history]')) return $('note-history').click();
    const heading = e.target.closest('[data-line]');
    if (heading) return notes.goToLine(Number(heading.dataset.line));
    const tag = e.target.closest('[data-tag]');
    if (tag) {
      e.preventDefault();
      deps.searchTag(tag.dataset.tag);
    }
  });
  let outlineTimer;
  document.addEventListener('sink:edit', () => {
    if (current() === 'classic') return;
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(renderOutline, 400);
  });
  $('note-info-toggle').addEventListener('click', () => {
    const shut = !$('app').classList.contains('info-shut');
    $('app').classList.toggle('info-shut', shut);
    local.set('sink:info-shut', shut);
  });
}

// ---------- split pane width ----------

function wireSplitter() {
  const bar = document.createElement('div');
  bar.className = 'pane-splitter';
  bar.setAttribute('role', 'separator');
  bar.setAttribute('aria-orientation', 'vertical');
  bar.setAttribute('aria-label', 'Resize');
  $('app').append(bar);
  const width = local.get('sink:list-width', 0);
  if (width) $('app').style.setProperty('--list-w', `${width}px`);
  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const left = $('main').getBoundingClientRect().left;
    const move = (ev) => {
      const w = Math.round(Math.min(Math.max(ev.clientX - left, 260), innerWidth - left - 380));
      $('app').style.setProperty('--list-w', `${w}px`);
      local.set('sink:list-width', w);
    };
    bar.addEventListener('pointermove', move);
    // The columns animate when the sidebar folds; while dragging they follow the pointer exactly.
    $('app').classList.add('resizing');
    // Capture ends on release, and also when the system takes the pointer (a gesture, switching windows).
    bar.addEventListener(
      'lostpointercapture',
      () => {
        bar.removeEventListener('pointermove', move);
        $('app').classList.remove('resizing');
      },
      { once: true },
    );
  });
}

// ---------- start ----------

export function initLayout(d) {
  deps = { ...deps, ...d };
  apply();
  WIDE.addEventListener('change', apply);
  document.addEventListener('sink:note', followNote);
  // The notes list changed: titles in tabs, tags and folders in the panel.
  document.addEventListener('sink:notes', () => {
    renderTabs();
    if (current() !== 'classic' && notes.openNoteInfo().open) renderInfo();
  });
  addEventListener('hashchange', () => {
    renderCrumbs();
    renderTabs();
  });
  // Another browser may have changed it.
  document.addEventListener('visibilitychange', () => !document.hidden && refresh());

  $('top-nav').addEventListener('click', () => {
    const shut = !$('app').classList.contains('nav-shut');
    $('app').classList.toggle('nav-shut', shut);
    local.set('sink:nav-shut', shut);
  });
  $('top-back').addEventListener('click', () => history.back());
  $('top-forward').addEventListener('click', () => history.forward());
  $('top-theme').addEventListener('click', () => deps.toggleTheme());
  // Escape closes the note wherever focus is (Classic's note fills the screen, so focus is always in it). In Tabs it
  // goes to the grid and leaves the tab open; its × closes the tab.
  document.addEventListener(
    'keydown',
    (e) => {
      const info = notes.openNoteInfo();
      if (e.key !== 'Escape' || e.defaultPrevented || current() === 'classic' || !info.open || info.board) return;
      if (document.querySelector('dialog[open]') || ['card-menu', 'new-menu', 'note-menu', 'note-colors'].some((id) => !$(id).hidden)) return;
      if (current() === 'tabs') {
        e.preventDefault();
        e.stopPropagation();
        location.hash = folderHash(notes.currentFolder());
      } else if (!e.target.closest?.('#note-screen')) $('note-back').click();
    },
    { capture: true },
  );
  $('rail-folders').addEventListener('click', () => $('app').classList.toggle('rail-open'));
  // The rail's flyout closes once you've picked somewhere to go.
  $('nav').addEventListener('click', (e) => {
    if (e.target.closest('a[href]') && !e.target.closest('[data-toggle]')) $('app').classList.remove('rail-open');
  });
  document.addEventListener('mousedown', (e) => {
    if ($('app').classList.contains('rail-open') && !e.target.closest('#nav')) $('app').classList.remove('rail-open');
  });
  $('top-tabs').addEventListener('click', (e) => {
    const close = e.target.closest('[data-close-tab]');
    if (close) {
      e.preventDefault();
      return closeTab(close.dataset.closeTab);
    }
  });
  $('top-tab-new').addEventListener('click', (e) => deps.openNewMenu(e.currentTarget));
  // A mouse wheel scrolls the strip sideways; trackpads already do.
  $('top-tabs').addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      $('top-tabs').scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  $('top-tabs').addEventListener('scroll', showMoreTabs, { passive: true });
  addEventListener('resize', showMoreTabs);
  // Tabs on a laptop shows the search as a magnifier: a click anywhere on it starts a search.
  $('top-search').addEventListener('click', () => $('search').focus());
  // Middle-click closes a tab, as in a browser.
  $('top-tabs').addEventListener('auxclick', (e) => {
    const t = e.target.closest('[data-tab]');
    if (e.button === 1 && t?.dataset.tab) {
      e.preventDefault();
      closeTab(t.dataset.tab);
    }
  });
  wireInfo();
  wireSplitter();
}

/** After sign-in: the account's prefs, and the one-time question on a wide screen. */
export async function startLayout() {
  try {
    take(await api.prefs());
  } catch {
    return;
  }
  if (!prefs.layoutChosen && WIDE.matches) askLayout();
}

