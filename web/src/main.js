// Only the components the page uses; '@m3e/web/all' doubles the bundle.
import '@m3e/web/theme';
import '@m3e/web/button';
import '@m3e/web/button-group';
import '@m3e/web/icon';
import '@m3e/web/icon-button';
import '@m3e/web/heading';
import '@m3e/web/shape';
import '@m3e/web/loading-indicator';
import '@m3e/web/form-field';
import '@m3e/web/chips';
import '@m3e/web/dialog';
import '@m3e/web/search';
import '@m3e/web/fab';
import '@m3e/web/expansion-panel';
import { M3eSnackbar } from '@m3e/web/snackbar';
import { api, Unauthorized } from './api.js';

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ic = (name, slot, more = '') => `<m3e-icon name="${esc(name)}"${slot ? ` slot="${slot}"` : ''}${more}></m3e-icon>`;
const toast = (msg, opts = {}) => M3eSnackbar.open(msg, { duration: 3000, ...opts });

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

const KINDS = {
  event: { icon: 'event', label: 'Events' },
  receipt: { icon: 'receipt_long', label: 'Receipts' },
  product: { icon: 'shopping_bag', label: 'Products' },
  place: { icon: 'place', label: 'Places' },
  code: { icon: 'code', label: 'Code' },
  article: { icon: 'article', label: 'Articles' },
  message: { icon: 'chat', label: 'Messages' },
  recipe: { icon: 'restaurant', label: 'Recipes' },
  other: { icon: 'category', label: 'Other' },
};

const VIEWS = [
  { id: 'all', label: 'Sink', icon: 'inventory_2' },
  { id: 'digest', label: 'Review', icon: 'auto_awesome' },
  { id: 'pinned', label: 'Pinned', icon: 'push_pin' },
  { id: 'archived', label: 'Archive', icon: 'archive' },
  { id: 'trash', label: 'Trash', icon: 'delete' },
];

const ACTION_ICONS = { calendar: 'event', reminder: 'alarm', todo: 'check_circle', open_url: 'open_in_new', copy: 'content_copy' };

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

// ---------- state ----------

const state = {
  view: 'all',
  kind: '',
  collection: '',
  collections: [],
  q: '',
  items: [],
  cursor: null,
  done: false,
  loading: false,
  generation: 0,
  current: null,
};

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
  reload();
}

$('login-submit').addEventListener('click', () => {
  location.href = '/api/auth/oidc/start?client=web';
});

$('logout').addEventListener('click', async () => {
  await api.logout().catch(() => {});
  showLogin();
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
const darkToggle = $('dark-toggle');
const savedScheme = storage.get('scheme');
if (savedScheme) {
  theme.setAttribute('scheme', savedScheme);
  darkToggle.selected = savedScheme === 'dark';
} else {
  darkToggle.selected = matchMedia('(prefers-color-scheme: dark)').matches;
}
darkToggle.addEventListener('change', () => {
  const scheme = darkToggle.selected ? 'dark' : 'light';
  theme.setAttribute('scheme', scheme);
  storage.set('scheme', scheme);
});

// ---------- filters ----------

$('views').innerHTML = VIEWS.map(
  (v) => `<m3e-button toggle variant="tonal" data-view="${v.id}"${v.id === state.view ? ' selected' : ''}>${ic(v.icon, 'icon')}${v.label}</m3e-button>`,
).join('');

$('views').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (!btn) return;
  state.view = btn.dataset.view;
  for (const b of $('views').querySelectorAll('[data-view]')) b.selected = b === btn;
  reload();
});

$('kinds').innerHTML = Object.entries(KINDS)
  .map(([k, v]) => `<m3e-filter-chip value="${k}">${ic(v.icon, 'icon')}${v.label}</m3e-filter-chip>`)
  .join('');

$('kinds').addEventListener('change', () => {
  // `selected` attributes reflect a render late; the set's value is current.
  state.kind = $('kinds').value ?? '';
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
  // The open filter may have been deleted elsewhere.
  if (state.collection && !state.collections.some((c) => c.id === state.collection)) {
    state.collection = '';
    reload();
  }
  renderCollections();
}

function renderCollections() {
  $('collections').innerHTML = state.collections
    .map(
      (c) =>
        `<m3e-filter-chip value="${esc(c.id)}"${c.id === state.collection ? ' selected' : ''}>${ic('folder', 'icon')}${esc(c.name)}<span class="chip-count">${c.count}</span></m3e-filter-chip>`,
    )
    .join('');
  $('collections').hidden = !state.collections.length;
  $('collection-rename').hidden = $('collection-delete').hidden = !state.collection;
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

$('collections').addEventListener('change', () => {
  state.collection = $('collections').value ?? '';
  $('collection-rename').hidden = $('collection-delete').hidden = !state.collection;
  reload();
});

$('collection-new').addEventListener('click', newCollection);

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
    await loadCollections();
  } catch (err) {
    toast(err.message);
  }
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
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.target.closest('input, textarea')) {
    e.preventDefault();
    $('search').focus();
  }
});

// ---------- list ----------

function reload() {
  state.generation++;
  state.items = [];
  state.cursor = null;
  state.done = false;
  $('grid').innerHTML = '';
  $('digest').hidden = state.view !== 'digest';
  $('kinds').hidden = $('collections-bar').hidden = state.view === 'digest';
  if (state.view === 'digest') loadDigest();
  else loadMore();
}

async function loadMore() {
  if (state.loading || state.done || state.view === 'digest') return;
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

function cardHtml(c) {
  const busy = c.status === 'pending' || c.status === 'processing';
  const kind = KINDS[c.kind];
  const title = c.title || c.note_text || (busy ? 'Reading…' : 'Untitled');
  return `
<article class="card${c.pinned ? ' pinned' : ''}" data-id="${c.id}" tabindex="0">
  <div class="thumb" style="aspect-ratio:${c.width}/${Math.min(c.height, c.width * 1.6)}">
    <img src="${c.thumb_url}" alt="" loading="lazy" />
    ${busy ? '<div class="busy"><m3e-loading-indicator variant="contained"></m3e-loading-indicator></div>' : ''}
    ${c.pinned ? `<span class="pin">${ic('push_pin', '', ' filled')}</span>` : ''}
  </div>
  <div class="meta">
    <div class="title">${esc(title)}</div>
    ${c.summary ? `<div class="summary">${esc(c.summary)}</div>` : ''}
    <div class="foot">
      ${kind ? `<span class="kind">${ic(kind.icon)}${esc(c.kind)}</span>` : ''}
      ${c.status === 'failed' ? `<span class="kind failed">${ic('error')}AI failed</span>` : ''}
      <span class="time">${timeOf(c.created_at)}</span>
    </div>
  </div>
</article>`;
}

function renderGrid() {
  const grid = $('grid');
  // Group by day when browsing chronologically; search results are ranked, so no headers.
  if (state.q) {
    grid.innerHTML = `<div class="day-group"><div class="masonry">${state.items.map(cardHtml).join('')}</div></div>`;
  } else {
    const groups = new Map();
    for (const c of state.items) {
      const day = relativeDay(c.created_at);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(c);
    }
    grid.innerHTML = [...groups]
      .map(
        ([day, items]) => `
<div class="day-group">
  <m3e-heading variant="title" size="medium" class="day">${esc(day)}</m3e-heading>
  <div class="masonry">${items.map(cardHtml).join('')}</div>
</div>`,
      )
      .join('');
  }

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
  if (card) openDetail(card.dataset.id);
});
$('grid').addEventListener('keydown', (e) => {
  const card = e.target.closest('.card');
  if (card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openDetail(card.dataset.id);
  }
});

// Poll captures the AI is still working on.
let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = state.items.filter((c) => c.status === 'pending' || c.status === 'processing');
  if (!busy.length) return;
  pollTimer = setTimeout(async () => {
    for (const c of busy.slice(0, 20)) {
      try {
        const fresh = await api.get(c.id);
        if (fresh.status !== c.status) {
          replaceItem(fresh);
          if (state.current?.id === fresh.id) renderDetail(fresh);
        }
      } catch {
        /* next round */
      }
    }
    schedulePoll();
  }, 3000);
}

// ---------- digest ----------

async function loadDigest() {
  const el = $('digest');
  el.innerHTML = '<m3e-loading-indicator></m3e-loading-indicator>';
  try {
    const { unreviewed, actions } = await api.digest();
    state.items = unreviewed;
    state.done = true;
    const byCapture = new Map(unreviewed.map((c) => [c.id, c]));
    el.innerHTML = `
<div class="digest-head">
  <m3e-shape name="sunny" class="digest-shape"></m3e-shape>
  <div>
    <m3e-heading variant="headline" size="small">This week in the sink</m3e-heading>
    <p class="muted">${unreviewed.length ? `${unreviewed.length} thing${unreviewed.length === 1 ? '' : 's'} you saved and haven't looked at again. Keep or archive.` : 'All caught up. Nice.'}</p>
  </div>
</div>
${
  actions.length
    ? `<div class="digest-actions">
  <m3e-heading variant="title" size="small">Open suggestions</m3e-heading>
  <m3e-chip-set>${actions
    .map(
      (a) =>
        `<m3e-assist-chip data-capture="${a.capture_id}" title="${esc(byCapture.get(a.capture_id)?.title ?? '')}">${ic(ACTION_ICONS[a.type] ?? 'bolt', 'icon')}${esc(a.label)}</m3e-assist-chip>`,
    )
    .join('')}</m3e-chip-set>
</div>`
    : ''
}
<div class="masonry digest-grid">${unreviewed
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
  if (chip) return openDetail(chip.dataset.capture);
  const btn = e.target.closest('[data-review]');
  const item = e.target.closest('.digest-item');
  if (btn && item) {
    const id = item.dataset.id;
    await api.patch(id, btn.dataset.review === 'keep' ? { reviewed: true } : { reviewed: true, archived: true });
    item.classList.add('leaving');
    setTimeout(() => item.remove(), 250);
    return;
  }
  const card = e.target.closest('.card');
  if (card) openDetail(card.dataset.id);
});

// ---------- detail ----------

const detail = $('detail');

async function openDetail(id) {
  try {
    const c = await api.get(id);
    state.current = c;
    renderDetail(c);
    detail.show();
  } catch (err) {
    toast(err.message);
  }
}

detail.addEventListener('closed', async () => {
  const c = state.current;
  state.current = null;
  if (!c) return;
  // Save edits on close.
  const title = $('d-title')?.value.trim();
  const note = $('d-note')?.value.trim() ?? '';
  const tags = ($('d-tags')?.value ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const changes = {};
  if (title !== undefined && title !== (c.title ?? '')) changes.title = title;
  if (note !== (c.note_text ?? '')) changes.note_text = note || null;
  if (tags.join(',') !== c.tags.join(',')) changes.tags = tags;
  if (Object.keys(changes).length) {
    try {
      replaceItem(await api.patch(c.id, changes));
      toast('Saved');
    } catch (err) {
      toast(`Couldn't save: ${err.message}`);
    }
  }
});

function entityRows(entities) {
  const labels = { dates: ['event', 'Dates'], urls: ['link', 'Links'], prices: ['sell', 'Prices'], addresses: ['place', 'Addresses'], people: ['person', 'People'] };
  return Object.entries(entities ?? {})
    .filter(([, v]) => v?.length)
    .map(([k, values]) => {
      const [icon, label] = labels[k] ?? ['label', k];
      const shown = values
        .map((v) =>
          k === 'urls' && /^https?:\/\//.test(v)
            ? `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>`
            : esc(k === 'dates' && !Number.isNaN(Date.parse(v)) ? new Date(v).toLocaleString() : v),
        )
        .join(' · ');
      return `<div class="entity">${ic(icon)}<span class="entity-label">${label}</span><span>${shown}</span></div>`;
    })
    .join('');
}

function renderDetail(c) {
  const busy = c.status === 'pending' || c.status === 'processing';
  const kind = KINDS[c.kind];
  $('detail-header').innerHTML = `${kind ? ic(kind.icon) : ''} ${esc(relativeDay(c.created_at))}, ${timeOf(c.created_at)}`;

  const actions = (c.actions ?? []).filter((a) => a.state !== 'dismissed');
  $('detail-body').innerHTML = `
<div class="detail-grid">
  <a class="detail-image" href="${c.image_url}" target="_blank" rel="noopener">
    <img src="${c.image_url}" alt="Screenshot" />
  </a>
  <div class="detail-info">
    ${busy ? `<div class="status">${'<m3e-loading-indicator></m3e-loading-indicator>'}<span>AI is reading this…</span></div>` : ''}
    ${c.status === 'failed' ? `<div class="status failed">${ic('error')}<span>AI couldn't process this. ${esc(c.error ?? '')}</span></div>` : ''}
    <m3e-form-field variant="outlined" class="full">
      <label slot="label" for="d-title">Title</label>
      <input id="d-title" value="${esc(c.title ?? '')}" />
    </m3e-form-field>
    ${c.summary ? `<p class="detail-summary">${esc(c.summary)}</p>` : ''}
    ${
      actions.length
        ? `<m3e-chip-set class="detail-chips">${actions
            .map(
              (a) =>
                `<m3e-assist-chip data-action="${a.id}" class="${a.state === 'done' ? 'done' : ''}">${ic(a.state === 'done' ? 'check' : a.state === 'accepted' ? 'alarm_on' : ACTION_ICONS[a.type] ?? 'bolt', 'icon')}${esc(a.label)}${a.due_at && a.state === 'suggested' && a.due_at > Date.now() ? ` · ${esc(new Date(a.due_at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}` : ''}</m3e-assist-chip>`,
            )
            .join('')}</m3e-chip-set>`
        : ''
    }
    <div class="entities">${
      c.source_url && /^https?:\/\//.test(c.source_url)
        ? `<div class="entity">${ic('public')}<span class="entity-label">Page</span><span><a href="${esc(c.source_url)}" target="_blank" rel="noopener noreferrer">${esc(c.source_url)}</a></span></div>`
        : ''
    }${entityRows(c.entities)}</div>
    <div class="detail-collections">
      <span class="entity-label">Collections</span>
      <div class="collection-chips">
        ${
          state.collections.length
            ? `<m3e-filter-chip-set id="d-collections" multi aria-label="Collections">${state.collections
                .map(
                  (col) =>
                    `<m3e-filter-chip value="${esc(col.id)}"${c.collections?.includes(col.id) ? ' selected' : ''}>${esc(col.name)}</m3e-filter-chip>`,
                )
                .join('')}</m3e-filter-chip-set>`
            : ''
        }
        <m3e-assist-chip id="d-collection-new">${ic('add', 'icon')}New</m3e-assist-chip>
      </div>
    </div>
    <m3e-form-field variant="outlined" class="full">
      <label slot="label" for="d-note">Your note</label>
      <textarea id="d-note" rows="2">${esc(c.note_text ?? '')}</textarea>
    </m3e-form-field>
    <m3e-form-field variant="outlined" class="full">
      <label slot="label" for="d-tags">Tags (comma separated)</label>
      <input id="d-tags" value="${esc(c.tags.join(', '))}" />
    </m3e-form-field>
    ${
      c.ocr_text
        ? `<m3e-expansion-panel class="ocr"><span slot="header">Text in image</span><pre>${esc(c.ocr_text)}</pre></m3e-expansion-panel>`
        : ''
    }
    ${c.model ? `<p class="muted small">Read by ${esc(c.model)}</p>` : ''}
  </div>
</div>`;

  $('d-collections')?.addEventListener('change', () =>
    setCollections(c, [].concat($('d-collections').value ?? [])),
  );
  $('d-collection-new').addEventListener('click', async () => {
    const created = await newCollection();
    if (created) await setCollections(c, [...(c.collections ?? []), created.id]);
    renderDetail(c);
  });

  const trashed = c.deleted_at != null;
  $('detail-actions').innerHTML = trashed
    ? `<m3e-button data-do="restore">${ic('restore_from_trash', 'icon')}Restore</m3e-button>
       <m3e-button data-do="purge" variant="filled" class="danger">${ic('delete_forever', 'icon')}Delete forever</m3e-button>`
    : `<m3e-icon-button data-do="pin" toggle ${c.pinned ? 'selected' : ''} aria-label="Pin">${ic('push_pin')}${ic('push_pin', 'selected', ' filled')}</m3e-icon-button>
       <m3e-icon-button data-do="archive" aria-label="${c.archived_at ? 'Unarchive' : 'Archive'}">${ic(c.archived_at ? 'unarchive' : 'archive')}</m3e-icon-button>
       <m3e-icon-button data-do="reprocess" aria-label="Re-read with AI">${ic('auto_awesome')}</m3e-icon-button>
       <m3e-icon-button data-do="delete" aria-label="Move to trash">${ic('delete')}</m3e-icon-button>
       <span class="spacer"></span>
       <m3e-button data-do="close" variant="filled">Done</m3e-button>`;
}

$('detail-body').addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-action]');
  if (!chip || !state.current) return;
  const action = state.current.actions.find((a) => a.id === chip.dataset.action);
  if (action) await runAction(action);
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
    renderDetail(c);
  }
}

async function runAction(a) {
  const p = a.payload ?? {};
  // Dated reminders/todos become real reminders; the phone schedules and fires them.
  if ((a.type === 'reminder' || a.type === 'todo') && a.due_at > Date.now()) {
    await api.setAction(a.id, 'accepted').catch(() => {});
    a.state = 'accepted';
    toast(`Reminder set for ${new Date(a.due_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}. Your phone will ping you.`);
    renderDetail(state.current);
    return;
  }
  switch (a.type) {
    case 'open_url':
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
  renderDetail(state.current);
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

$('detail-actions').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-do]');
  const c = state.current;
  if (!btn || !c) return;
  try {
    switch (btn.dataset.do) {
      case 'close':
        detail.hide();
        break;
      case 'pin': {
        const updated = await api.patch(c.id, { pinned: !c.pinned });
        Object.assign(c, updated);
        replaceItem(updated);
        break;
      }
      case 'archive':
        await api.patch(c.id, { archived: !c.archived_at });
        toast(c.archived_at ? 'Back in the sink' : 'Archived');
        state.current = null;
        detail.hide();
        removeItem(c.id);
        break;
      case 'reprocess': {
        const updated = await api.reprocess(c.id);
        Object.assign(c, updated);
        replaceItem(updated);
        renderDetail(c);
        schedulePoll();
        break;
      }
      case 'delete':
        await api.patch(c.id, { deleted: true });
        state.current = null;
        detail.hide();
        removeItem(c.id);
        toast('Moved to trash');
        break;
      case 'restore':
        await api.patch(c.id, { deleted: false });
        state.current = null;
        detail.hide();
        removeItem(c.id);
        toast('Restored');
        break;
      case 'purge':
        if (!confirm('Delete forever? This cannot be undone.')) return;
        await api.purge(c.id);
        state.current = null;
        detail.hide();
        removeItem(c.id);
        toast('Deleted');
        break;
    }
  } catch (err) {
    toast(err.message);
  }
});

// ---------- upload ----------

const uploadDialog = $('upload-dialog');
let pendingFiles = [];

function startUpload(files) {
  pendingFiles = [...files].filter((f) => f.type.startsWith('image/'));
  if (!pendingFiles.length) return;
  $('upload-previews').innerHTML = pendingFiles
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
      if (state.view === 'all' && !state.q && !state.kind) {
        state.items.unshift(created);
        renderGrid();
      }
    } catch (err) {
      toast(`${f.name}: ${err.message}`);
    }
  }
  if (ok && state.collection) loadCollections();
  if (ok) toast(ok === 1 ? 'Stashed. AI is reading it.' : `Stashed ${ok}. AI is reading them.`);
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

$('upload-fab').addEventListener('click', () => $('file-input').click());
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
