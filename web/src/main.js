// Only the components the page uses; '@m3e/web/all' doubles the bundle.
import '@m3e/web/theme';
import '@m3e/web/button';
import '@m3e/web/button-group';
import '@m3e/web/icon';
import '@m3e/web/icon-button';
import '@m3e/web/shape';
import '@m3e/web/loading-indicator';
import '@m3e/web/form-field';
import '@m3e/web/chips';
import '@m3e/web/dialog';
import '@m3e/web/search';
import '@m3e/web/fab';
import '@m3e/web/expansion-panel';
import '@m3e/web/switch';
import { M3eSnackbar } from '@m3e/web/snackbar';
import { api, Unauthorized } from './api.js';

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ic = (name, slot, more = '') => `<m3e-icon name="${esc(name)}"${slot ? ` slot="${slot}"` : ''}${more}></m3e-icon>`;
const toast = (msg, opts = {}) => M3eSnackbar.open(msg, { duration: 3000, ...opts });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isPhone = () => matchMedia('(max-width: 839px)').matches;

const storage = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode etc. */
    }
  },
};

// Each kind has its own hue (see --kind in style.css) so the grid scans by colour.
const KINDS = {
  event: { icon: 'event', label: 'Events', one: 'Event' },
  receipt: { icon: 'receipt_long', label: 'Receipts', one: 'Receipt' },
  product: { icon: 'shopping_bag', label: 'Products', one: 'Product' },
  place: { icon: 'place', label: 'Places', one: 'Place' },
  code: { icon: 'code', label: 'Code', one: 'Code' },
  article: { icon: 'article', label: 'Articles', one: 'Article' },
  message: { icon: 'chat', label: 'Messages', one: 'Message' },
  recipe: { icon: 'restaurant', label: 'Recipes', one: 'Recipe' },
  other: { icon: 'category', label: 'Other', one: 'Other' },
};

const VIEWS = [
  { id: 'all', label: 'Sink', icon: 'inventory_2', hash: '#/' },
  { id: 'digest', label: 'Review', icon: 'auto_awesome', hash: '#/review' },
  { id: 'pinned', label: 'Pinned', icon: 'push_pin', hash: '#/pinned' },
  { id: 'archived', label: 'Archive', icon: 'archive', hash: '#/archive' },
  { id: 'trash', label: 'Trash', icon: 'delete', hash: '#/trash' },
];

const ACTION_ICONS = {
  calendar: 'event',
  reminder: 'alarm',
  todo: 'check_circle',
  open_url: 'open_in_new',
  copy: 'content_copy',
  price_drop: 'trending_down',
};

const ACCENTS = [
  { color: '#6750A4', name: 'Grape' },
  { color: '#006A6A', name: 'Teal' },
  { color: '#B3261E', name: 'Tomato' },
  { color: '#8C5000', name: 'Amber' },
  { color: '#386A20', name: 'Fern' },
  { color: '#0061A4', name: 'Ocean' },
];

function relativeDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

const timeOf = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const busyStatus = (c) => c.status === 'pending' || c.status === 'processing';

// ---------- state ----------

const state = {
  // Route: one of VIEWS, 'settings' or 'library' (phone), optionally inside a collection.
  view: 'all',
  collection: '',
  kind: '',
  q: '',
  collections: [],
  items: [],
  cursor: null,
  done: false,
  loading: false,
  generation: 0,
  current: null,
  reviewCount: 0,
  // Multi-select: ids picked in the grid, and the last one clicked (for shift-click ranges).
  selected: new Set(),
  anchor: null,
};

const listView = () => !['digest', 'settings', 'library'].includes(state.view);

// ---------- auth ----------

async function boot() {
  try {
    await api.me();
    showApp();
  } catch (err) {
    if (err instanceof Unauthorized) showLogin();
    else toast(`Can't reach server: ${err.message}`);
  }
}

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
}

function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  loadCollections();
  refreshReviewCount();
  applyRoute();
}

$('login-submit').addEventListener('click', () => {
  location.href = '/api/auth/oidc/start?client=web';
});

// Any 401 anywhere drops back to login.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof Unauthorized) {
    e.preventDefault();
    showLogin();
  }
});

// ---------- theme ----------

const theme = $('theme');

function applyTheme() {
  const scheme = storage.get('scheme') ?? 'auto';
  const accent = storage.get('accent') ?? ACCENTS[0].color;
  theme.setAttribute('scheme', scheme);
  theme.setAttribute('color', accent);
  document.querySelector('meta[name="theme-color"]').content = accent;
}
applyTheme();

// ---------- routing ----------
// Hash routes so reloads, the back button and links keep their place:
// #/  #/review  #/pinned  #/archive  #/trash  #/c/<collection>  #/settings  #/library

function parseHash() {
  const path = location.hash.replace(/^#/, '') || '/';
  const [, first = '', second = ''] = path.split('/');
  if (first === 'c' && second) return { view: 'all', collection: decodeURIComponent(second) };
  const view = VIEWS.find((v) => v.hash === `#/${first}`)?.id ?? (['settings', 'library'].includes(first) ? first : 'all');
  return { view, collection: '' };
}

function applyRoute() {
  const route = parseHash();
  // Library is a phone page; on desktop the sidebar already is the library.
  if (route.view === 'library' && !isPhone()) route.view = 'all';
  const changed = route.view !== state.view || route.collection !== state.collection;
  state.view = route.view;
  state.collection = route.collection;
  if (changed) closePanel();
  renderChrome();
  if (state.view === 'settings') renderSettings();
  if (listView() || state.view === 'digest') reload();
}

window.addEventListener('hashchange', applyRoute);

// Phone: the open capture is a history entry, so swipe-back / the back button closes it.
window.addEventListener('popstate', () => {
  if (!history.state?.capture && state.current && isPhone()) closePanel({ fromHistory: true });
});

/** Sidebar, tab bar, page title and which sections show, for the current route. */
function renderChrome() {
  const col = state.collections.find((c) => c.id === state.collection);
  const view = VIEWS.find((v) => v.id === state.view);

  $('nav-views').innerHTML = VIEWS.map(
    (v) => `<a class="nav-item${!state.collection && state.view === v.id ? ' active' : ''}" href="${v.hash}">
  ${ic(v.icon)}<span>${v.label}</span>${v.id === 'digest' && state.reviewCount ? `<b class="count">${state.reviewCount}</b>` : ''}
</a>`,
  ).join('');
  $('nav-collections').innerHTML = state.collections.length
    ? state.collections
        .map(
          (c) => `<a class="nav-item${c.id === state.collection ? ' active' : ''}" href="#/c/${encodeURIComponent(c.id)}">
  ${ic('folder')}<span>${esc(c.name)}</span><b class="count">${c.count}</b>
</a>`,
        )
        .join('')
    : '<p class="nav-empty">Group captures for a trip, a gift list, anything.</p>';
  document.querySelector('.nav-foot .nav-item').classList.toggle('active', state.view === 'settings');

  const tab = state.collection || ['pinned', 'archived', 'trash'].includes(state.view) ? 'library' : state.view;
  for (const a of document.querySelectorAll('.tabbar [data-tab]')) a.classList.toggle('active', a.dataset.tab === tab);
  $('tab-badge').hidden = !state.reviewCount;
  $('tab-badge').textContent = state.reviewCount;

  const titles = { settings: 'Settings', library: 'Library' };
  $('view-title').textContent = col?.name ?? titles[state.view] ?? (state.view === 'all' ? 'Sink' : view?.label ?? 'Sink');
  $('view-sub').textContent = col ? plural(col.count, 'capture') : '';
  $('collection-tools').hidden = !col;

  const app = $('app');
  app.dataset.view = state.view;
  $('search-row').hidden = !listView();
  $('kinds').hidden = !listView();
  $('digest').hidden = state.view !== 'digest';
  $('settings').hidden = state.view !== 'settings';
  $('grid').hidden = $('more').hidden = !listView();
  if (!listView()) $('empty').hidden = true;
}

// ---------- filters ----------

$('kinds').innerHTML = Object.entries(KINDS)
  .map(([k, v]) => `<m3e-filter-chip value="${k}" style="--kind: var(--kind-${k})">${ic(v.icon, 'icon')}${v.label}</m3e-filter-chip>`)
  .join('');

$('kinds').addEventListener('change', () => {
  // `selected` attributes reflect a render late; the set's value is current.
  state.kind = $('kinds').value ?? '';
  reload();
});

let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = $('search').value.trim();
    reload();
  }, 220);
});
document.querySelector('m3e-search-bar').addEventListener('clear', () => {
  state.q = '';
  reload();
});

// ---------- collections ----------

async function loadCollections() {
  try {
    state.collections = (await api.collections()).collections;
  } catch (err) {
    if (err instanceof Unauthorized) return showLogin();
    return toast(err.message);
  }
  // The open collection may have been deleted elsewhere.
  if (state.collection && !state.collections.some((c) => c.id === state.collection)) {
    location.hash = '#/';
    return;
  }
  renderChrome();
}

async function refreshReviewCount() {
  try {
    state.reviewCount = (await api.digest()).unreviewed.length;
    renderChrome();
  } catch {
    /* badge is a nicety */
  }
}

async function newCollection() {
  const name = prompt('Name the collection')?.trim();
  if (!name) return null;
  try {
    const created = await api.createCollection(name);
    await loadCollections();
    return created;
  } catch (err) {
    toast(err.message === 'name taken' ? `“${name}” already exists` : err.message);
    return null;
  }
}

$('collection-new').addEventListener('click', async () => {
  const created = await newCollection();
  if (created) location.hash = `#/c/${encodeURIComponent(created.id)}`;
});

$('collection-rename').addEventListener('click', async () => {
  const current = state.collections.find((c) => c.id === state.collection);
  if (!current) return;
  const name = prompt('Rename collection', current.name)?.trim();
  if (!name || name === current.name) return;
  try {
    await api.renameCollection(current.id, name);
    await loadCollections();
  } catch (err) {
    toast(err.message === 'name taken' ? `“${name}” already exists` : err.message);
  }
});

$('collection-delete').addEventListener('click', async () => {
  const current = state.collections.find((c) => c.id === state.collection);
  if (!current || !confirm(`Delete “${current.name}”? The captures in it stay in the sink.`)) return;
  try {
    await api.deleteCollection(current.id);
    toast('Collection deleted');
    location.hash = '#/';
    loadCollections();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- list ----------

function reload() {
  clearSelection();
  state.generation++;
  state.items = [];
  state.cursor = null;
  state.done = false;
  $('grid').innerHTML = '';
  if (state.view === 'digest') loadDigest();
  else if (listView()) loadMore();
}

async function loadMore() {
  if (state.loading || state.done || !listView()) return;
  state.loading = true;
  $('loading').hidden = false;
  const gen = state.generation;
  try {
    const res = await api.list({ q: state.q, kind: state.kind, collection: state.collection, view: state.view, cursor: state.cursor });
    if (gen !== state.generation) return;
    state.items.push(...res.items);
    state.cursor = res.next_cursor;
    state.done = !res.next_cursor;
    renderGrid();
  } catch (err) {
    if (err instanceof Unauthorized) return showLogin();
    toast(err.message);
  } finally {
    if (gen === state.generation) {
      state.loading = false;
      $('loading').hidden = true;
    }
  }
}

new IntersectionObserver((entries) => entries[0].isIntersecting && loadMore(), { rootMargin: '600px' }).observe($('more'));

const hostOf = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Notes and links saved by assistants have no screenshot; their card shows the text instead. */
function textTileHtml(c) {
  const link = /^https?:\/\//.test(c.source_url ?? '') ? c.source_url : null;
  const body = (c.ocr_text ?? '').replace(/^(Title|Description): /gm, '').slice(0, 360) || c.note_text || '';
  return `<div class="text-tile">
    ${link ? `<span class="tile-host">${ic('link')}${esc(hostOf(link))}</span>` : `<span class="tile-host">${ic('notes')}Note</span>`}
    <p>${esc(body)}</p>
  </div>`;
}

function cardHtml(c) {
  const busy = busyStatus(c);
  const kind = KINDS[c.kind];
  const title = c.title || c.note_text || (busy ? 'Reading…' : 'Untitled');
  const classes = ['card', c.pinned && 'pinned', state.selected.has(c.id) && 'selected', state.current?.id === c.id && 'open'].filter(Boolean);
  return `
<article class="${classes.join(' ')}" data-id="${c.id}" tabindex="0" style="--kind: var(--kind-${c.kind ?? 'none'})">
  <div class="thumb${c.thumb_url ? '' : ' text'}">
    ${c.thumb_url ? `<img src="${c.thumb_url}" alt="" loading="lazy" />` : textTileHtml(c)}
    <span class="select-box" data-select role="checkbox" aria-label="Select" aria-checked="${state.selected.has(c.id)}">${ic('check')}</span>
    ${c.pinned ? `<span class="pin" title="Pinned">${ic('push_pin', '', ' filled')}</span>` : ''}
    ${busy ? '<div class="busy"><m3e-loading-indicator variant="contained"></m3e-loading-indicator></div>' : ''}
  </div>
  <div class="meta">
    ${
      c.status === 'failed'
        ? `<span class="kind failed">${ic('error')}AI failed</span>`
        : kind
          ? `<span class="kind">${ic(kind.icon)}${kind.one}</span>`
          : ''
    }
    <div class="title">${esc(title)}</div>
    ${c.summary ? `<div class="summary">${esc(c.summary)}</div>` : ''}
    <div class="time">${state.q ? `${esc(relativeDay(c.created_at))} · ` : ''}${timeOf(c.created_at)}</div>
  </div>
</article>`;
}

function renderGrid() {
  const grid = $('grid');
  // Day headers when browsing by date; search results are ranked, so they stay flat.
  const groups = new Map();
  for (const c of state.items) {
    const day = state.q ? '' : relativeDay(c.created_at);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(c);
  }
  grid.innerHTML = [...groups]
    .map(
      ([day, items]) => `
<section class="day-group">
  ${day ? `<h2 class="day">${esc(day)}<span>${items.length}</span></h2>` : ''}
  <div class="cards">${items.map(cardHtml).join('')}</div>
</section>`,
    )
    .join('');

  const empty = state.items.length === 0 && state.done;
  $('empty').hidden = !empty;
  if (empty) {
    const [title, body] = state.q
      ? ['Nothing matches', `No luck for “${state.q}”. Try fewer words.`]
      : state.collection
        ? ['Nothing in here yet', 'Open a capture and file it into this collection.']
        : state.view === 'trash'
          ? ['Trash is empty', 'Deleted things land here first.']
          : state.view === 'archived'
            ? ['Archive is empty', 'Archive things you are done with but want to keep.']
            : state.view === 'pinned'
              ? ['No pins yet', 'Pin the stuff you keep coming back to.']
              : ["Sink's empty", 'Drop a screenshot anywhere, paste one, or hit the button.'];
    $('empty-title').textContent = title;
    $('empty-body').textContent = body;
  }
  schedulePoll();
}

function replaceItem(updated) {
  const i = state.items.findIndex((c) => c.id === updated.id);
  if (i !== -1) state.items[i] = { ...state.items[i], ...updated };
  const el = document.querySelector(`.card[data-id="${updated.id}"]`);
  if (el) el.outerHTML = cardHtml(state.items[i] ?? updated);
}

function removeItem(id) {
  state.items = state.items.filter((c) => c.id !== id);
  renderGrid();
}

$('grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  // Once anything is selected, clicks select; the tick, shift or cmd/ctrl start it.
  if (e.target.closest('[data-select]') || state.selected.size || e.shiftKey || e.metaKey || e.ctrlKey) {
    toggleSelect(card.dataset.id, e.shiftKey);
  } else openPanel(card.dataset.id);
});
$('grid').addEventListener('keydown', (e) => {
  const card = e.target.closest('.card');
  if (card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openPanel(card.dataset.id);
  }
});

// ---------- multi-select ----------

function toggleSelect(id, range) {
  const ids = state.items.map((c) => c.id);
  if (range && state.anchor && ids.includes(state.anchor)) {
    const [a, b] = [ids.indexOf(state.anchor), ids.indexOf(id)].sort((x, y) => x - y);
    for (const i of ids.slice(a, b + 1)) state.selected.add(i);
  } else if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  state.anchor = id;
  renderSelection();
}

function clearSelection() {
  state.selected.clear();
  state.anchor = null;
  renderSelection();
}

function renderSelection() {
  for (const card of $('grid').querySelectorAll('.card')) {
    const on = state.selected.has(card.dataset.id);
    card.classList.toggle('selected', on);
    card.querySelector('[data-select]')?.setAttribute('aria-checked', String(on));
  }
  const n = state.selected.size;
  $('grid').classList.toggle('selecting', n > 0);
  $('bulk-bar').hidden = n === 0;
  $('app').classList.toggle('bulk', n > 0);
  if (!n) return;
  $('bulk-count').textContent = `${n} selected`;
  const picked = state.items.filter((c) => state.selected.has(c.id));
  const allPinned = picked.length > 0 && picked.every((c) => c.pinned);
  const button = (act, icon, label) =>
    `<m3e-icon-button data-bulk="${act}" aria-label="${label}" title="${label}">${ic(icon)}</m3e-icon-button>`;
  $('bulk-actions').innerHTML =
    state.view === 'trash'
      ? button('restore', 'restore_from_trash', 'Restore') + button('purge', 'delete_forever', 'Delete forever')
      : [
          button(allPinned ? 'unpin' : 'pin', allPinned ? 'keep_off' : 'push_pin', allPinned ? 'Unpin' : 'Pin'),
          button('tag', 'sell', 'Add tag'),
          button('collect', 'create_new_folder', 'Add to collection'),
          state.collection ? button('uncollect', 'folder_off', 'Remove from this collection') : '',
          state.view === 'archived' ? button('unarchive', 'unarchive', 'Unarchive') : button('archive', 'archive', 'Archive'),
          button('delete', 'delete', 'Move to trash'),
        ].join('');
}

async function bulk(body, message) {
  const ids = [...state.selected];
  try {
    const { updated } = await api.bulk({ ids, ...body });
    toast(message(updated));
  } catch (err) {
    return toast(err.message);
  }
  if (body.add_collections || body.remove_collections) loadCollections();
  reload();
}

$('bulk-actions').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-bulk]')?.dataset.bulk;
  switch (act) {
    case 'pin':
    case 'unpin':
      return bulk({ pinned: act === 'pin' }, (n) => `${act === 'pin' ? 'Pinned' : 'Unpinned'} ${plural(n, 'capture')}`);
    case 'archive':
    case 'unarchive':
      return bulk({ archived: act === 'archive' }, (n) => `${act === 'archive' ? 'Archived' : 'Unarchived'} ${plural(n, 'capture')}`);
    case 'delete':
      return bulk({ deleted: true }, (n) => `Moved ${plural(n, 'capture')} to trash`);
    case 'restore':
      return bulk({ deleted: false }, (n) => `Restored ${plural(n, 'capture')}`);
    case 'tag': {
      const tags = (prompt('Add tags (comma separated)') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      if (tags.length) bulk({ add_tags: tags }, (n) => `Tagged ${plural(n, 'capture')}`);
      return;
    }
    case 'uncollect': {
      const name = state.collections.find((c) => c.id === state.collection)?.name ?? 'collection';
      return bulk({ remove_collections: [state.collection] }, (n) => `Took ${plural(n, 'capture')} out of ${name}`);
    }
    case 'collect':
      return openBulkCollect();
    case 'purge': {
      const ids = [...state.selected];
      if (!confirm(`Delete ${plural(ids.length, 'capture')} forever? This cannot be undone.`)) return;
      let gone = 0;
      for (const id of ids) {
        try {
          await api.purge(id);
          gone++;
        } catch {
          /* counted below */
        }
      }
      toast(gone === ids.length ? `Deleted ${plural(gone, 'capture')}` : `Deleted ${gone} of ${ids.length}`);
      return reload();
    }
  }
});

$('bulk-clear').addEventListener('click', clearSelection);
$('bulk-all').addEventListener('click', () => {
  for (const c of state.items) state.selected.add(c.id);
  renderSelection();
});

const bulkCollect = $('bulk-collect');

async function openBulkCollect() {
  if (!state.collections.length) {
    const created = await newCollection();
    if (created) bulk({ add_collections: [created.id] }, (n) => `Added ${plural(n, 'capture')} to ${created.name}`);
    return;
  }
  $('bulk-collect-chips').innerHTML = `<m3e-filter-chip-set id="bulk-collect-set" multi aria-label="Collections">${state.collections
    .map((col) => `<m3e-filter-chip value="${esc(col.id)}">${esc(col.name)}</m3e-filter-chip>`)
    .join('')}</m3e-filter-chip-set><m3e-assist-chip id="bulk-collect-new">${ic('add', 'icon')}New</m3e-assist-chip>`;
  bulkCollect.show();
}

$('bulk-collect-chips').addEventListener('click', async (e) => {
  if (!e.target.closest('#bulk-collect-new')) return;
  bulkCollect.hide();
  const created = await newCollection();
  if (created) bulk({ add_collections: [created.id] }, (n) => `Added ${plural(n, 'capture')} to ${created.name}`);
});
$('bulk-collect-cancel').addEventListener('click', () => bulkCollect.hide());
$('bulk-collect-go').addEventListener('click', () => {
  const ids = [].concat($('bulk-collect-set')?.value ?? []);
  bulkCollect.hide();
  if (ids.length) bulk({ add_collections: ids }, (n) => `Filed ${plural(n, 'capture')}`);
});

// ---------- keyboard ----------

document.addEventListener('keydown', (e) => {
  if ($('app').hidden || e.target.closest('input, textarea, [contenteditable]') || document.querySelector('m3e-dialog[open]')) return;
  if (e.key === '/' && listView()) {
    e.preventDefault();
    $('search').focus();
  } else if (e.key === 'Escape') {
    if (state.selected.size) clearSelection();
    else if (state.current) closePanel();
  } else if ((e.key === 'j' || e.key === 'ArrowDown' || e.key === 'ArrowRight') && state.current && !isPhone()) {
    e.preventDefault();
    stepPanel(1);
  } else if ((e.key === 'k' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') && state.current && !isPhone()) {
    e.preventDefault();
    stepPanel(-1);
  } else if (e.key === 'a' && (e.metaKey || e.ctrlKey) && listView() && state.items.length) {
    e.preventDefault();
    for (const c of state.items) state.selected.add(c.id);
    renderSelection();
  }
});

// Poll captures the AI is still working on.
let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = state.items.filter(busyStatus);
  if (!busy.length) return;
  pollTimer = setTimeout(async () => {
    for (const c of busy.slice(0, 20)) {
      try {
        const fresh = await api.get(c.id);
        if (fresh.status !== c.status) {
          replaceItem(fresh);
          if (state.current?.id === fresh.id) {
            state.current = fresh;
            renderPanel();
          }
        }
      } catch {
        /* next round */
      }
    }
    schedulePoll();
  }, 3000);
}

// ---------- review (digest) ----------

async function loadDigest() {
  const el = $('digest');
  el.innerHTML = '<div class="more"><m3e-loading-indicator></m3e-loading-indicator></div>';
  try {
    const { unreviewed, actions } = await api.digest();
    state.items = unreviewed;
    state.done = true;
    state.reviewCount = unreviewed.length;
    renderChrome();
    const byCapture = new Map(unreviewed.map((c) => [c.id, c]));
    el.innerHTML = `
<div class="digest-head">
  <m3e-shape name="sunny" class="digest-shape"></m3e-shape>
  <div>
    <h2>This week in the sink</h2>
    <p>${unreviewed.length ? `${plural(unreviewed.length, 'thing')} you saved and haven't looked at again. Keep or archive.` : 'All caught up. Nice.'}</p>
  </div>
</div>
${
  actions.length
    ? `<div class="digest-actions">
  <h3 class="section-label">Open suggestions</h3>
  <div class="chip-row">${actions
    .map(
      (a) =>
        `<m3e-assist-chip data-capture="${a.capture_id}" title="${esc(byCapture.get(a.capture_id)?.title ?? '')}">${ic(ACTION_ICONS[a.type] ?? 'bolt', 'icon')}${esc(a.label)}</m3e-assist-chip>`,
    )
    .join('')}</div>
</div>`
    : ''
}
<div class="cards">${unreviewed
      .map(
        (c) => `<div class="digest-item" data-id="${c.id}">${cardHtml(c)}
  <div class="digest-buttons">
    <m3e-button variant="tonal" size="small" data-review="keep">${ic('check', 'icon')}Keep</m3e-button>
    <m3e-button variant="text" size="small" data-review="archive">${ic('archive', 'icon')}Archive</m3e-button>
  </div></div>`,
      )
      .join('')}</div>`;
  } catch (err) {
    if (err instanceof Unauthorized) return showLogin();
    el.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

$('digest').addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-capture]');
  if (chip) return openPanel(chip.dataset.capture);
  const btn = e.target.closest('[data-review]');
  const item = e.target.closest('.digest-item');
  if (btn && item) {
    const id = item.dataset.id;
    await api.patch(id, btn.dataset.review === 'keep' ? { reviewed: true } : { reviewed: true, archived: true });
    item.classList.add('leaving');
    state.reviewCount = Math.max(0, state.reviewCount - 1);
    renderChrome();
    setTimeout(() => item.remove(), 250);
    return;
  }
  const card = e.target.closest('.card');
  if (card) openPanel(card.dataset.id);
});

// ---------- capture panel ----------

async function openPanel(id) {
  try {
    const c = await api.get(id);
    const wasOpen = !!state.current;
    state.current = c;
    renderPanel();
    $('panel-close').querySelector('m3e-icon').setAttribute('name', isPhone() ? 'arrow_back' : 'close');
    $('panel').hidden = false;
    $('app').classList.add('panel-open');
    for (const card of document.querySelectorAll('.card.open')) card.classList.remove('open');
    document.querySelector(`.card[data-id="${id}"]`)?.classList.add('open');
    $('panel-body').scrollTop = 0;
    if (isPhone() && !wasOpen) history.pushState({ capture: id }, '');
  } catch (err) {
    toast(err.message);
  }
}

function closePanel({ fromHistory = false } = {}) {
  if (!state.current) return;
  state.current = null;
  $('panel').hidden = true;
  $('app').classList.remove('panel-open');
  for (const card of document.querySelectorAll('.card.open')) card.classList.remove('open');
  if (isPhone() && !fromHistory && history.state?.capture) history.back();
}

function stepPanel(delta) {
  const ids = state.items.map((c) => c.id);
  const next = ids[ids.indexOf(state.current?.id) + delta];
  if (next) {
    openPanel(next);
    document.querySelector(`.card[data-id="${next}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

$('panel-close').addEventListener('click', () => closePanel());
// Esc in a field leaves it (which saves it); the next Esc closes the panel.
$('panel-body').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.matches('input, textarea')) {
    e.stopPropagation();
    e.target.blur();
  }
});
$('panel-prev').addEventListener('click', () => stepPanel(-1));
$('panel-next').addEventListener('click', () => stepPanel(1));

/** Saves one edited field straight away; the panel stays open, so there's no "save on close". */
async function saveField(changes) {
  const c = state.current;
  if (!c) return;
  try {
    const updated = await api.patch(c.id, changes);
    Object.assign(c, updated);
    replaceItem(updated);
  } catch (err) {
    toast(`Couldn't save: ${err.message}`);
  }
}

function entityRows(entities) {
  const labels = { dates: ['event', 'When'], urls: ['link', 'Links'], prices: ['sell', 'Price'], addresses: ['place', 'Where'], people: ['person', 'People'] };
  return Object.entries(entities ?? {})
    .filter(([, v]) => v?.length)
    .map(([k, values]) => {
      const [icon, label] = labels[k] ?? ['label', k];
      const shown = values
        .map((v) =>
          k === 'urls' && /^https?:\/\//.test(v)
            ? `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v.replace(/^https?:\/\/(www\.)?/, ''))}</a>`
            : esc(k === 'dates' && !Number.isNaN(Date.parse(v)) ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: v.length > 10 ? 'short' : undefined }) : v),
        )
        .join('<br>');
      return `<div class="fact">${ic(icon)}<span class="fact-label">${label}</span><span class="fact-value">${shown}</span></div>`;
    })
    .join('');
}

/** The page a price watch would check: where it was captured, else the first link found in it. */
const watchableUrl = (c) =>
  (/^https?:\/\//.test(c.source_url ?? '') && c.source_url) || (c.entities?.urls ?? []).find((u) => /^https?:\/\//.test(u)) || null;

function priceWatchHtml(c) {
  const w = c.price_watch;
  const url = w?.url ?? watchableUrl(c);
  // Offer it for products, or anything with a price and a link to check.
  if (!url || !(w || c.kind === 'product' || c.entities?.prices?.length)) return '';
  const money = (p) => (p == null ? '' : `${w?.currency ? `${w.currency} ` : '$'}${p.toFixed(2)}`);
  let status = 'Checks the page twice a day and tells you when the price drops.';
  if (w?.last_error) status = `Last check failed: ${w.last_error}`;
  else if (w?.last_price != null) {
    const lowest = w.lowest_price != null && w.lowest_price < w.last_price ? ` · lowest ${money(w.lowest_price)}` : '';
    const first = w.first_price != null && w.first_price !== w.last_price ? ` · was ${money(w.first_price)}` : '';
    status = `Now ${money(w.last_price)}${lowest}${first} · checked ${relativeDay(w.last_checked_at).toLowerCase()} ${timeOf(w.last_checked_at)}`;
  } else if (w) status = 'Watching. First check is on its way.';
  return `<label class="price-watch">
  ${ic('trending_down')}
  <div class="grow"><div class="price-watch-title">Watch price</div><div class="muted small">${esc(status)}</div></div>
  <m3e-switch id="d-watch" ${w ? 'checked' : ''} aria-label="Watch price"></m3e-switch>
</label>`;
}

function renderPanel() {
  const c = state.current;
  if (!c) return;
  const busy = busyStatus(c);
  const kind = KINDS[c.kind];
  const actions = (c.actions ?? []).filter((a) => a.state !== 'dismissed');
  const trashed = c.deleted_at != null;

  $('panel').style.setProperty('--kind', `var(--kind-${c.kind ?? 'none'})`);
  $('panel-actions').innerHTML = trashed
    ? `<m3e-button data-do="restore" variant="text">${ic('restore_from_trash', 'icon')}Restore</m3e-button>
       <m3e-icon-button data-do="purge" aria-label="Delete forever" title="Delete forever">${ic('delete_forever')}</m3e-icon-button>`
    : `<m3e-icon-button data-do="pin" toggle ${c.pinned ? 'selected' : ''} aria-label="Pin" title="${c.pinned ? 'Unpin' : 'Pin'}">${ic('push_pin')}${ic('push_pin', 'selected', ' filled')}</m3e-icon-button>
       <m3e-icon-button data-do="archive" aria-label="${c.archived_at ? 'Unarchive' : 'Archive'}" title="${c.archived_at ? 'Unarchive' : 'Archive'}">${ic(c.archived_at ? 'unarchive' : 'archive')}</m3e-icon-button>
       <m3e-icon-button data-do="reprocess" aria-label="Re-read with AI" title="Re-read with AI">${ic('auto_awesome')}</m3e-icon-button>
       <m3e-icon-button data-do="delete" aria-label="Move to trash" title="Move to trash">${ic('delete')}</m3e-icon-button>`;

  const tagChips = c.tags
    .map((t) => `<m3e-input-chip data-tag="${esc(t)}" removable>${esc(t)}</m3e-input-chip>`)
    .join('');

  $('panel-body').innerHTML = `
${
  c.image_url
    ? `<a class="shot" href="${c.image_url}" target="_blank" rel="noopener" title="Open full size">
  <img src="${c.image_url}" alt="Screenshot" />
</a>`
    : /^https?:\/\//.test(c.source_url ?? '')
      ? `<a class="link-card" href="${esc(c.source_url)}" target="_blank" rel="noopener noreferrer">${ic('link')}<span>${esc(hostOf(c.source_url))}</span>${ic('open_in_new')}</a>`
      : ''
}
<div class="panel-content">
  <div class="eyebrow">
    ${kind ? `<span class="kind">${ic(kind.icon)}${kind.one}</span>` : ''}
    <span>${esc(relativeDay(c.created_at))}, ${timeOf(c.created_at)}</span>
  </div>
  ${busy ? `<div class="status"><m3e-loading-indicator></m3e-loading-indicator><span>AI is reading this…</span></div>` : ''}
  ${c.status === 'failed' ? `<div class="status failed">${ic('error')}<span>AI couldn't read this. ${esc(c.error ?? '')}</span></div>` : ''}
  <textarea id="d-title" class="title-edit" rows="1" placeholder="Add a title" aria-label="Title">${esc(c.title ?? '')}</textarea>
  ${c.summary ? `<p class="summary-text">${esc(c.summary)}</p>` : ''}
  ${
    actions.length
      ? `<div class="chip-row actions">${actions
          .map(
            (a) =>
              `<m3e-assist-chip data-action="${a.id}" class="${a.state === 'done' ? 'done' : ''}">${ic(a.state === 'done' ? 'check' : a.state === 'accepted' ? 'alarm_on' : ACTION_ICONS[a.type] ?? 'bolt', 'icon')}${esc(a.label)}${a.due_at && a.state === 'suggested' && a.due_at > Date.now() ? ` · ${esc(new Date(a.due_at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}` : ''}</m3e-assist-chip>`,
          )
          .join('')}</div>`
      : ''
  }
  ${
    (c.source_url && /^https?:\/\//.test(c.source_url)) || Object.values(c.entities ?? {}).some((v) => v?.length)
      ? `<div class="facts">${
          c.source_url && /^https?:\/\//.test(c.source_url)
            ? `<div class="fact">${ic('public')}<span class="fact-label">Page</span><span class="fact-value"><a href="${esc(c.source_url)}" target="_blank" rel="noopener noreferrer">${esc(new URL(c.source_url).host.replace(/^www\./, ''))}</a></span></div>`
            : ''
        }${entityRows(c.entities)}</div>`
      : ''
  }
  ${priceWatchHtml(c)}

  <h3 class="section-label">Your note</h3>
  <textarea id="d-note" class="note-edit" rows="2" placeholder="Why did you save this?">${esc(c.note_text ?? '')}</textarea>

  <h3 class="section-label">Collections</h3>
  <div class="chip-row">
    ${
      state.collections.length
        ? `<m3e-filter-chip-set id="d-collections" multi aria-label="Collections">${state.collections
            .map((col) => `<m3e-filter-chip value="${esc(col.id)}"${c.collections?.includes(col.id) ? ' selected' : ''}>${esc(col.name)}</m3e-filter-chip>`)
            .join('')}</m3e-filter-chip-set>`
        : ''
    }
    <m3e-assist-chip id="d-collection-new">${ic('add', 'icon')}New</m3e-assist-chip>
  </div>

  <h3 class="section-label">Tags</h3>
  <div class="chip-row tags">
    ${tagChips}
    <input id="d-tag-add" class="tag-add" placeholder="${c.tags.length ? 'Add' : 'Add a tag'}" aria-label="Add tag" />
  </div>

  ${
    c.ocr_text
      ? `<m3e-expansion-panel class="ocr" ${c.image_url ? '' : 'open'}><span slot="header">${c.image_url ? 'Text in the image' : 'Saved text'}</span><pre>${esc(c.ocr_text)}</pre></m3e-expansion-panel>`
      : ''
  }
  ${c.model ? `<p class="muted small footnote">Read by ${esc(c.model)}</p>` : ''}
</div>`;

  const title = $('d-title');
  const fit = () => {
    title.style.height = 'auto';
    title.style.height = `${title.scrollHeight}px`;
  };
  requestAnimationFrame(fit);
  title.addEventListener('input', fit);
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      title.blur();
    }
  });
  title.addEventListener('blur', () => {
    const v = title.value.trim();
    if (v !== (c.title ?? '')) saveField({ title: v });
  });
  $('d-note').addEventListener('blur', () => {
    const v = $('d-note').value.trim();
    if (v !== (c.note_text ?? '')) saveField({ note_text: v || null });
  });
  $('d-tag-add').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    const v = e.target.value.trim().toLowerCase();
    if (!v || c.tags.includes(v)) return;
    await saveField({ tags: [...c.tags, v] });
    renderPanel();
    $('d-tag-add')?.focus();
  });
  // Tag chips' own remove button (or Delete/Backspace on a focused chip).
  for (const chip of $('panel-body').querySelectorAll('[data-tag]')) {
    chip.addEventListener('remove', async () => {
      await saveField({ tags: c.tags.filter((t) => t !== chip.dataset.tag) });
      renderPanel();
    });
  }
  $('d-watch')?.addEventListener('change', async () => {
    try {
      const updated = await api.patch(c.id, { watch_price: $('d-watch').checked });
      c.price_watch = updated.price_watch;
      toast(c.price_watch ? 'Watching the price' : 'Stopped watching');
    } catch (err) {
      toast(err.message);
    }
    renderPanel();
  });
  $('d-collections')?.addEventListener('change', () => setCollections(c, [].concat($('d-collections').value ?? [])));
  $('d-collection-new').addEventListener('click', async () => {
    const created = await newCollection();
    if (created) await setCollections(c, [...(c.collections ?? []), created.id]);
    renderPanel();
  });
}

$('panel-body').addEventListener('click', async (e) => {
  const c = state.current;
  if (!c) return;
  const chip = e.target.closest('[data-action]');
  if (chip) {
    const action = c.actions.find((a) => a.id === chip.dataset.action);
    if (action) await runAction(action);
  }
});

async function setCollections(c, ids) {
  try {
    const updated = await api.patch(c.id, { collections: ids });
    c.collections = updated.collections;
    loadCollections();
    // Filed out of the collection being browsed.
    if (state.collection && !c.collections.includes(state.collection)) removeItem(c.id);
  } catch (err) {
    toast(`Couldn't update collections: ${err.message}`);
    renderPanel();
  }
}

async function runAction(a) {
  const p = a.payload ?? {};
  // Dated reminders/todos become real reminders; the phone schedules and fires them.
  if ((a.type === 'reminder' || a.type === 'todo') && a.due_at > Date.now()) {
    await api.setAction(a.id, 'accepted').catch(() => {});
    a.state = 'accepted';
    toast(`Reminder set for ${new Date(a.due_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}. Your phone will ping you.`);
    renderPanel();
    return;
  }
  switch (a.type) {
    case 'open_url':
    case 'price_drop':
      if (/^https?:\/\//.test(p.url)) window.open(p.url, '_blank', 'noopener');
      break;
    case 'copy':
      await navigator.clipboard.writeText(String(p.text ?? ''));
      toast('Copied');
      break;
    case 'calendar':
      window.open(googleCalendarUrl(p), '_blank', 'noopener');
      break;
    case 'reminder':
    case 'todo':
      toast('No date on this one, marked done.');
      break;
  }
  await api.setAction(a.id, 'done').catch(() => {});
  a.state = 'done';
  renderPanel();
}

function googleCalendarUrl(p) {
  const fmt = (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };
  const start = fmt(p.start);
  const end = fmt(p.end) ?? (start ? fmt(new Date(new Date(p.start).getTime() + 3600_000)) : null);
  const params = new URLSearchParams({ action: 'TEMPLATE', text: p.title ?? 'Event' });
  if (start && end) params.set('dates', `${start}/${end}`);
  if (p.location) params.set('location', p.location);
  return `https://calendar.google.com/calendar/render?${params}`;
}

$('panel-actions').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-do]');
  const c = state.current;
  if (!btn || !c) return;
  const leave = (message) => {
    closePanel();
    removeItem(c.id);
    if (message) toast(message);
  };
  try {
    switch (btn.dataset.do) {
      case 'pin': {
        const updated = await api.patch(c.id, { pinned: !c.pinned });
        Object.assign(c, updated);
        replaceItem(updated);
        if (state.view === 'pinned' && !updated.pinned) leave();
        break;
      }
      case 'archive':
        await api.patch(c.id, { archived: !c.archived_at });
        leave(c.archived_at ? 'Back in the sink' : 'Archived');
        break;
      case 'reprocess': {
        const updated = await api.reprocess(c.id);
        Object.assign(c, updated);
        replaceItem(updated);
        renderPanel();
        schedulePoll();
        break;
      }
      case 'delete':
        await api.patch(c.id, { deleted: true });
        leave('Moved to trash');
        break;
      case 'restore':
        await api.patch(c.id, { deleted: false });
        leave('Restored');
        break;
      case 'purge':
        if (!confirm('Delete forever? This cannot be undone.')) return;
        await api.purge(c.id);
        leave('Deleted');
        break;
    }
  } catch (err) {
    toast(err.message);
  }
});

// ---------- settings ----------

async function renderSettings() {
  const el = $('settings');
  const scheme = storage.get('scheme') ?? 'auto';
  const accent = storage.get('accent') ?? ACCENTS[0].color;
  el.innerHTML = `
<section class="setting-card">
  <h2>Appearance</h2>
  <div class="setting-row">
    <div class="grow"><div class="setting-title">Theme</div></div>
    <m3e-button-group id="scheme" variant="connected" size="small">
      ${[['auto', 'brightness_auto', 'System'], ['light', 'light_mode', 'Light'], ['dark', 'dark_mode', 'Dark']]
        .map(([v, icon, label]) => `<m3e-button toggle variant="tonal" data-scheme="${v}"${v === scheme ? ' selected' : ''}>${ic(icon, 'icon')}${label}</m3e-button>`)
        .join('')}
    </m3e-button-group>
  </div>
  <div class="setting-row">
    <div class="grow"><div class="setting-title">Accent</div><div class="muted small">Buttons, highlights and the logo.</div></div>
    <div class="swatches" role="radiogroup" aria-label="Accent colour">
      ${ACCENTS.map((a) => `<button class="swatch${a.color === accent ? ' on' : ''}" data-accent="${a.color}" style="--c:${a.color}" role="radio" aria-checked="${a.color === accent}" aria-label="${a.name}" title="${a.name}"></button>`).join('')}
    </div>
  </div>
</section>

<section class="setting-card">
  <h2>AI assistants</h2>
  <p class="muted">Let Claude, ChatGPT, Poke or another assistant search your sink, read captures, save new things and file them into collections.</p>
  <div class="setting-title">Connector URL</div>
  <p class="muted small">Add a custom connector (MCP server) with this URL. You'll sign in here and approve it.</p>
  <div class="copy-row">
    <code id="connect-url">${esc(location.origin)}/mcp</code>
    <m3e-icon-button id="connect-url-copy" aria-label="Copy connector URL" title="Copy">${ic('content_copy')}</m3e-icon-button>
  </div>
  <m3e-expansion-panel class="token-panel">
    <span slot="header">Claude Code, or anything that wants a token</span>
    <p class="muted small">The URL above works with <code>claude mcp add --transport http</code>. For a fixed header instead, make a token:</p>
    <div class="setting-row">
      <m3e-form-field variant="outlined" class="grow">
        <label slot="label" for="connect-name">Name</label>
        <input id="connect-name" value="Claude Code" />
      </m3e-form-field>
      <m3e-button id="connect-create" variant="tonal">Create token</m3e-button>
    </div>
    <div id="connect-result" hidden>
      <p class="small">Run this once. The token is only shown now.</p>
      <pre id="connect-command" class="command"></pre>
      <m3e-button id="connect-copy" variant="text" size="small">${ic('content_copy', 'icon')}Copy command</m3e-button>
    </div>
  </m3e-expansion-panel>
</section>

<section class="setting-card">
  <h2>Signed-in devices and assistants</h2>
  <div id="connect-tokens" class="token-list"><m3e-loading-indicator></m3e-loading-indicator></div>
</section>

<section class="setting-card">
  <h2>Server</h2>
  <div id="server-info" class="facts"></div>
</section>

<section class="setting-card">
  <div class="setting-row">
    <div class="grow"><div class="setting-title">Sign out of this browser</div><div class="muted small">Other devices stay signed in.</div></div>
    <m3e-button id="logout" variant="outlined">${ic('logout', 'icon')}Sign out</m3e-button>
  </div>
</section>`;
  renderTokens();
  try {
    const h = await api.health();
    $('server-info').innerHTML = [
      ['smart_toy', 'AI reading', h.ai ? 'On' : 'Off (no API key)'],
      ['manage_search', 'Search by meaning', h.semantic == null ? 'Off' : `${plural(h.semantic, 'capture')} indexed`],
      ['pending', 'Waiting to be read', String(h.pending_jobs)],
      ['dns', 'Address', location.host],
    ]
      .map(([icon, label, value]) => `<div class="fact">${ic(icon)}<span class="fact-label">${label}</span><span class="fact-value">${esc(value)}</span></div>`)
      .join('');
  } catch (err) {
    $('server-info').textContent = err.message;
  }
}

async function renderTokens() {
  try {
    const [{ tokens }, me] = await Promise.all([api.tokens(), api.me()]);
    const ago = (ts) => (ts ? `${relativeDay(ts).toLowerCase()} ${timeOf(ts)}` : 'never');
    $('connect-tokens').innerHTML = tokens
      .map((t) => {
        const assistant = /\(MCP\)|claude|mcp|code|gpt|poke/i.test(t.name);
        return `<div class="token-row">
  <span class="token-icon">${ic(assistant ? 'hub' : 'devices')}</span>
  <div class="grow"><div>${esc(t.name.replace(/ \(MCP\)$/, ''))}${t.id === me.tokenId ? ' <span class="here">This browser</span>' : ''}</div>
  <div class="muted small">${assistant ? 'Assistant' : 'Device'} · last used ${esc(ago(t.last_used_at))}</div></div>
  ${t.id === me.tokenId ? '' : `<m3e-icon-button data-revoke="${esc(t.id)}" aria-label="Revoke ${esc(t.name)}" title="Revoke">${ic('close')}</m3e-icon-button>`}
</div>`;
      })
      .join('');
  } catch (err) {
    $('connect-tokens').textContent = err.message;
  }
}

$('settings').addEventListener('click', async (e) => {
  const scheme = e.target.closest('[data-scheme]');
  if (scheme) {
    storage.set('scheme', scheme.dataset.scheme);
    applyTheme();
    for (const b of document.querySelectorAll('[data-scheme]')) b.selected = b === scheme;
    return;
  }
  const accent = e.target.closest('[data-accent]');
  if (accent) {
    storage.set('accent', accent.dataset.accent);
    applyTheme();
    for (const b of document.querySelectorAll('[data-accent]')) {
      b.classList.toggle('on', b === accent);
      b.setAttribute('aria-checked', String(b === accent));
    }
    return;
  }
  const revoke = e.target.closest('[data-revoke]');
  if (revoke) {
    if (!confirm('Revoke this? That device or assistant gets signed out.')) return;
    await api.revokeToken(revoke.dataset.revoke).catch((err) => toast(err.message));
    return renderTokens();
  }
  const id = e.target.closest('[id]')?.id;
  if (id === 'connect-url-copy') {
    await navigator.clipboard.writeText($('connect-url').textContent);
    toast('Copied');
  } else if (id === 'connect-copy') {
    await navigator.clipboard.writeText($('connect-command').textContent);
    toast('Copied');
  } else if (id === 'connect-create') {
    const name = $('connect-name').value.trim() || 'MCP client';
    try {
      const { token } = await api.createToken(name);
      $('connect-command').textContent =
        `claude mcp add --transport http --scope user sink ${location.origin}/mcp \\\n  --header "Authorization: Bearer ${token}"`;
      $('connect-result').hidden = false;
      renderTokens();
    } catch (err) {
      toast(err.message);
    }
  } else if (id === 'logout') {
    await api.logout().catch(() => {});
    showLogin();
  }
});

// ---------- upload ----------

const uploadDialog = $('upload-dialog');
let pendingFiles = [];

function startUpload(files) {
  pendingFiles = [...files].filter((f) => f.type.startsWith('image/'));
  if (!pendingFiles.length) return;
  $('upload-previews').innerHTML =
    pendingFiles
      .slice(0, 6)
      .map((f) => `<img src="${URL.createObjectURL(f)}" alt="" />`)
      .join('') + (pendingFiles.length > 6 ? `<span class="more-count">+${pendingFiles.length - 6}</span>` : '');
  $('upload-note').value = '';
  uploadDialog.show();
  setTimeout(() => $('upload-note').focus(), 50);
}

async function doUpload() {
  const files = pendingFiles;
  const note = $('upload-note').value.trim();
  pendingFiles = [];
  uploadDialog.hide();
  let ok = 0;
  for (const f of files) {
    try {
      let created = await api.upload(f, note);
      ok++;
      // Stashing while browsing a collection files it there.
      if (state.collection && !created.collections?.includes(state.collection)) {
        created = await api.patch(created.id, { collections: [...(created.collections ?? []), state.collection] });
      }
      if ((state.view === 'all' || state.collection) && !state.q && !state.kind) {
        state.items.unshift(created);
        renderGrid();
      }
    } catch (err) {
      toast(`${f.name}: ${err.message}`);
    }
  }
  if (ok && state.collection) loadCollections();
  if (ok) {
    refreshReviewCount();
    toast(ok === 1 ? 'Stashed. AI is reading it.' : `Stashed ${ok}. AI is reading them.`);
  }
}

uploadDialog.addEventListener('closed', () => {
  for (const img of $('upload-previews').querySelectorAll('img')) URL.revokeObjectURL(img.src);
});
$('upload-go').addEventListener('click', doUpload);
$('upload-cancel').addEventListener('click', () => {
  pendingFiles = [];
  uploadDialog.hide();
});
$('upload-note').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doUpload();
});

for (const id of ['upload-fab', 'add-btn']) $(id).addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  startUpload(e.target.files);
  e.target.value = '';
});

document.addEventListener('paste', (e) => {
  if ($('app').hidden || e.target.closest('input, textarea')) return;
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) startUpload(files);
});

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if ($('app').hidden || !e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  $('dropzone').hidden = false;
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('dropzone').hidden = true;
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').hidden = true;
  if (!$('app').hidden && e.dataTransfer?.files.length) startUpload(e.dataTransfer.files);
});

boot();
