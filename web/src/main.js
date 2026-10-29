// Only the components the page uses; '@m3e/web/all' doubles the bundle.
import '@m3e/web/theme';
import '@m3e/web/button';
import '@m3e/web/button-group';
import '@m3e/web/icon';
import '@m3e/web/icon-button';
import '@m3e/web/shape';
import '@m3e/web/loading-indicator';
import '@m3e/web/form-field';
import '@m3e/web/search';
import '@m3e/web/fab';
import '@m3e/web/expansion-panel';
import { M3eSnackbar } from '@m3e/web/snackbar';
import { api, Unauthorized } from './api.js';
import * as notes from './notes.js';
import { loadPlugins } from './plugin-api.js';
import { bundledPlugins } from './plugins/index.js';

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ic = (name, slot, more = '') => `<m3e-icon name="${esc(name)}"${slot ? ` slot="${slot}"` : ''}${more}></m3e-icon>`;
/** `action` + `onAction` add a button (Undo) to the snackbar. */
const toast = (msg, { action, onAction, ...opts } = {}) =>
  action
    ? M3eSnackbar.open(msg, action, { duration: 6000, ...opts, actionCallback: onAction })
    : M3eSnackbar.open(msg, { duration: 3000, ...opts });

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

const VIEWS = [
  { id: 'notes', label: 'Notes', icon: 'sticky_note_2', hash: '#/notes' },
  { id: 'todos', label: 'Todos', icon: 'checklist', hash: '#/todos' },
];

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

// ---------- state ----------

const state = {
  // 'notes', 'todos', 'trash' or 'settings'.
  view: '',
  // Notes: the folder filter and the search text.
  folder: '',
  q: '',
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
  fetch('/api/auth/info')
    .then((r) => r.json())
    .then(({ provider }) => provider && ($('login-label').textContent = `Sign in with ${provider}`))
    .catch(() => {});
}

async function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  notes.loadNotes().catch(() => {});
  // Before the first note opens, so its diagrams and commands are there.
  await loadPlugins(
    {
      list: async () => (await api.plugins()).plugins,
      url: (path) => path,
      fetch: (path, init) => fetch(path, { credentials: 'same-origin', ...init }),
      dark: () =>
        theme.getAttribute('scheme') === 'dark' || (theme.getAttribute('scheme') !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches),
    },
    bundledPlugins,
  );
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
// #/ or #/notes  #/notes/<folder>  #/n/<note path>[?line=N]  #/new  #/todos  #/trash  #/settings

function parseHash() {
  const [path, query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
  const [, first = '', ...rest] = path.split('/');
  const base = { view: 'notes', folder: '', note: null, line: null, draft: false };
  if (!first || first === 'notes') return { ...base, folder: decodeURIComponent(rest.join('/')) };
  if (first === 'n' && rest.length) {
    const line = new URLSearchParams(query).get('line');
    return { ...base, note: rest.map(decodeURIComponent).join('/'), line: line == null ? null : Number(line) };
  }
  if (first === 'new') return { ...base, draft: true };
  if (first === 'todos' || first === 'trash' || first === 'settings') return { ...base, view: first };
  return base;
}

function applyRoute() {
  const route = parseHash();
  const viewChanged = route.view !== state.view;
  state.view = route.view;
  state.folder = route.folder;
  renderChrome();
  if (state.view === 'settings') renderSettings();
  if (state.view === 'todos') notes.loadTodos();
  if (state.view === 'trash') notes.loadTrash();
  if (state.view === 'notes') {
    notes.setFolder(state.folder);
    if (viewChanged) {
      $('search').value = state.q = '';
      notes.setQuery('');
    }
    if (route.note) notes.openNote(route.note, { line: route.line });
    else if (route.draft) notes.openDraft({ folder: state.folder });
    else if (notes.noteIsOpen()) notes.closeNote();
  }
  if (state.view !== 'notes' && notes.noteIsOpen()) notes.closeNote();
}

window.addEventListener('hashchange', applyRoute);

/** Sidebar, tab bar, page title and which sections show, for the current route. */
function renderChrome() {
  $('nav-views').innerHTML = VIEWS.map(
    (v) => `<a class="nav-item${state.view === v.id ? ' active' : ''}" href="${v.hash}">${ic(v.icon)}<span>${v.label}</span></a>`,
  ).join('');
  for (const a of document.querySelectorAll('.nav-foot [data-route]')) a.classList.toggle('active', a.dataset.route === state.view);
  // The phone tab bar has no Trash tab; it's reached from Settings.
  const tab = state.view === 'trash' ? 'settings' : state.view;
  for (const a of document.querySelectorAll('.tabbar [data-tab]')) a.classList.toggle('active', a.dataset.tab === tab);

  const titles = { notes: state.folder || 'Notes', todos: 'Todos', trash: 'Trash', settings: 'Settings' };
  $('view-title').textContent = titles[state.view];

  $('app').dataset.view = state.view;
  $('search-row').hidden = state.view !== 'notes';
  $('notes').hidden = state.view !== 'notes';
  $('todos').hidden = state.view !== 'todos';
  $('trash').hidden = state.view !== 'trash';
  $('settings').hidden = state.view !== 'settings';
  $('fab-icon').setAttribute('name', state.view === 'todos' ? 'add_task' : 'edit');
  $('new-fab').setAttribute('aria-label', state.view === 'todos' ? 'Add todo' : 'New note');
  if (state.view === 'notes') notes.notesRendered();
  if (state.view === 'todos') notes.todosRendered();
}

// ---------- search ----------

let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = $('search').value.trim();
    notes.setQuery(state.q);
  }, 220);
});
document.querySelector('m3e-search-bar').addEventListener('clear', () => {
  state.q = '';
  notes.setQuery('');
});

// ---------- keyboard ----------

document.addEventListener('keydown', (e) => {
  if ($('app').hidden || notes.noteIsOpen() || e.target.closest('input, textarea, [contenteditable]')) return;
  if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey && state.view !== 'settings') {
    e.preventDefault();
    if (state.view === 'todos') $('todo-text').focus();
    else notes.newNote();
  } else if (e.key === '/' && state.view === 'notes') {
    e.preventDefault();
    $('search').focus();
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
  <p class="muted">Let Claude, ChatGPT, Poke or another assistant search and read your notes, write new ones and add todos.</p>
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
  <div class="setting-row">
    <div class="grow"><div class="setting-title">Trash</div><div class="muted small">Put back or delete notes you've deleted.</div></div>
    <m3e-button id="open-trash" variant="tonal">${ic('delete', 'icon')}Open trash</m3e-button>
  </div>
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
    const { notes: all } = await api.notes();
    $('server-info').innerHTML = [
      ['description', 'Notes', String(all.length)],
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
  } else if (id === 'open-trash') {
    location.hash = '#/trash';
  } else if (id === 'logout') {
    await api.logout().catch(() => {});
    showLogin();
  }
});

// ---------- new note / todo ----------

for (const id of ['new-fab', 'add-btn']) {
  $(id).addEventListener('click', () => {
    if (state.view === 'todos') $('todo-text').focus();
    else notes.newNote();
  });
}

notes.initNotes({ toast, navigate: (hash) => (location.hash = hash) });
notes.wireNotes();

boot();
