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
import '@m3e/web/fab-menu';
import '@m3e/web/breadcrumb';
import '@m3e/web/expansion-panel';
import '@m3e/web/switch';
import '@m3e/web/checkbox';
import '@m3e/web/snackbar';
import { api, Unauthorized } from './api.js';
import * as notes from './notes.js';
import { initLayout, layoutPickerHtml, startLayout, wirePicker } from './layout.js';
import { loadPlugins } from './plugin-api.js';
import { bundledPlugins } from './plugins/index.js';
import { askConfirm, showQr } from './dialogs.js';
import { hapticsEnabled, setHaptics } from './haptics.js';
import { esc } from './util.js';
import { acceptInvite, inviteName, passkeysWork, signInWithPasskey } from './passkey.js';

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);
const ic = (name, slot, more = '') => `<m3e-icon name="${esc(name)}"${slot ? ` slot="${slot}"` : ''}${more}></m3e-icon>`;
/** `action` + `onAction` add a button (Undo) to the snackbar. Built here rather than with M3eSnackbar.open so it sits
 * inside <m3e-theme> and picks up the theme's colours (open() appends to <body>, outside them). */
const toast = (msg, { action, onAction, duration = action ? 6000 : 3000 } = {}) => {
  const bar = Object.assign(document.createElement('m3e-snackbar'), { duration, action });
  bar.append(msg);
  bar.addEventListener('toggle', (e) => {
    if (e.newState !== 'closed') return;
    setTimeout(() => bar.remove(), 300);
    if (bar.isActionTaken) onAction?.();
  });
  $('theme').append(bar);
  bar.open = true;
};

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
  // Keep's Archive is a folder; the newer layouts list it with the views, as Keep does.
  { id: 'archive', label: 'Archive', icon: 'archive', hash: '#/notes/Archive', desk: true },
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

// The installed app is a share target (manifest.webmanifest): the share sheet opens /shared?title=…&text=…&url=….
// A link (Android often sends it as the text) goes to the clip route, anything else to a new note; the address is
// swapped for that route straight away so reload and back don't share it again.
if (location.pathname === '/shared') {
  const shared = new URLSearchParams(location.search);
  const [title, text, url] = ['title', 'text', 'url'].map((k) => shared.get(k)?.trim() ?? '');
  const link = url || (/^https?:\/\/\S+$/i.test(text) ? text : '');
  const body = title ? `# ${title}\n\n${text}` : text;
  history.replaceState(null, '', link ? `/#/clip?url=${encodeURIComponent(link)}` : body ? `/#/new?text=${encodeURIComponent(body)}` : '/#/new');
}

// The sign-in screen also takes invite links (?invite=…) and the Android app's sign-in (?client=android&…), which
// always show it, even in a browser that's already signed in.
const params = new URLSearchParams(location.search);
const signInParams = ['client', 'device', 'challenge', 'next'].filter((k) => params.has(k)).map((k) => [k, params.get(k)]);

const AFTER_SIGN_IN = 'sink.afterSignIn';

async function boot() {
  if (params.has('invite')) return showInvite(params.get('invite'));
  if (params.has('login')) return showPhoneLogin(params.get('login'));
  if (params.get('client') === 'android') return showLogin();
  try {
    await api.me();
    showApp();
  } catch (err) {
    // Signing in comes back to the bare address, so a clip from the bookmarklet or a share waits until then.
    if (err instanceof Unauthorized && /^#\/(clip|new)\?/.test(location.hash)) sessionStorage.setItem(AFTER_SIGN_IN, location.hash);
    if (err instanceof Unauthorized) showLogin();
    else toast(`Can't reach server: ${err.message}`);
  }
}

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  fetch('/api/auth/info')
    .then((r) => r.json())
    .then(({ provider, passkeys }) => {
      if (provider) $('login-label').textContent = `Sign in with ${provider}`;
      $('login-passkey').hidden = !passkeys || !passkeysWork() || params.has('invite') || params.has('login');
      // The Android app opens this screen; with nothing to choose, straight on to the provider.
      if (params.get('client') === 'android' && $('login-passkey').hidden) $('login-submit').click();
    })
    .catch(() => {});
}

function loginError(message) {
  $('login-error').textContent = message;
  $('login-error').hidden = !message;
}

async function showInvite(token) {
  showLogin();
  $('login-submit').hidden = true;
  $('login-passkey').hidden = true;
  try {
    const name = await inviteName(token);
    $('login-tagline').textContent = `${name}, you're invited to keep your notes here. Make a passkey to sign in with: your phone, computer or password manager keeps it, so there's no password.`;
    if (!passkeysWork()) return loginError('This browser can’t make passkeys. Try an up-to-date Chrome, Safari or Firefox.');
    $('invite-accept').hidden = false;
    $('invite-accept').onclick = async () => {
      loginError('');
      try {
        location.replace(await acceptInvite(token));
      } catch (err) {
        if (err.name !== 'NotAllowedError') loginError(err.message);
      }
    };
  } catch (err) {
    loginError(err.message);
  }
}

/** A phone's camera opened the link in a QR code from Settings on a signed-in browser. */
function showPhoneLogin(code) {
  showLogin();
  $('login-submit').hidden = true;
  $('login-tagline').textContent = 'Sign this browser in with the code you scanned?';
  $('phone-accept').hidden = false;
  $('phone-accept').onclick = async () => {
    loginError('');
    const res = await fetch('/api/auth/qr/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, device: 'Phone browser', cookie: true }),
    });
    if (res.ok) return location.replace('/');
    loginError((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
    $('phone-accept').hidden = true;
    $('login-submit').hidden = false;
  };
}

async function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  notes.loadNotes().catch(() => {});
  notes.loadTodoBadge();
  notes.listenForChanges();
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
  const after = sessionStorage.getItem(AFTER_SIGN_IN);
  sessionStorage.removeItem(AFTER_SIGN_IN);
  if (after) history.replaceState(null, '', after);
  applyRoute();
  syncReminders().catch(() => {});
  startLayout();
}

$('login-submit').addEventListener('click', () => {
  location.href = `/api/auth/oidc/start?${new URLSearchParams(signInParams.length ? signInParams : [['client', 'web']])}`;
});

$('login-passkey').addEventListener('click', async () => {
  loginError('');
  try {
    location.replace(await signInWithPasskey(Object.fromEntries(signInParams)));
  } catch (err) {
    // NotAllowedError: they closed the passkey prompt.
    if (err.name !== 'NotAllowedError') loginError(err.message);
  }
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
  // CSS can't see the manual scheme override, and a few surfaces need different steps in dark mode.
  theme.toggleAttribute('data-dark', scheme === 'dark' || (scheme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches));
  document.querySelector('meta[name="theme-color"]').content = accent;
  $('top-theme').querySelector('m3e-icon').setAttribute('name', theme.hasAttribute('data-dark') ? 'light_mode' : 'dark_mode');
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- routing ----------
// Hash routes so reloads, the back button and links keep their place:
// #/ or #/notes  #/notes/<folder>  #/n/<note path>[?line=N]  #/new[?folder=F&text=T]  #/clip?url=U  #/todos  #/trash  #/settings

function parseHash() {
  const [path, query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
  const [, first = '', ...rest] = path.split('/');
  const base = { view: 'notes', folder: '', note: null, line: null, draft: false, text: '', clip: null };
  if (!first || first === 'notes') return { ...base, folder: decodeURIComponent(rest.join('/')) };
  if (first === 'n' && rest.length) {
    const line = new URLSearchParams(query).get('line');
    return { ...base, note: rest.map(decodeURIComponent).join('/'), line: line == null ? null : Number(line) };
  }
  if (first === 'new') {
    const q = new URLSearchParams(query);
    return { ...base, draft: true, folder: q.get('folder') ?? '', text: q.get('text') ?? '' };
  }
  if (first === 'clip') return { ...base, clip: new URLSearchParams(query).get('url') };
  if (['todos', 'trash', 'settings'].includes(first)) return { ...base, view: first };
  return base;
}

function applyRoute() {
  const route = parseHash();
  if (route.clip) {
    // The bookmarklet's address: clip once, then leave it out of history so back and reload don't clip again.
    location.replace('#/notes');
    return notes.clipPage(route.clip);
  }
  const viewChanged = route.view !== state.view;
  state.view = route.view;
  // A note's address has no folder in it: the grid beside or behind it (Keep, Split, Tabs' Home) stays where it was.
  if (!route.note) state.folder = route.folder;
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
    else if (route.draft && route.text) {
      // Shared text: once it's in a draft, leave it out of the address so reload doesn't make a second note.
      history.replaceState(null, '', state.folder ? `#/new?folder=${encodeURIComponent(state.folder)}` : '#/new');
      notes.openDraft({ folder: state.folder, text: route.text });
    } else if (route.draft) notes.openDraft({ folder: state.folder });
    else if (notes.noteIsOpen()) notes.closeNote();
  }
  if (state.view !== 'notes' && notes.noteIsOpen()) notes.closeNote();
}

window.addEventListener('hashchange', applyRoute);

/** Sidebar, tab bar, page title and which sections show, for the current route. */
function renderChrome() {
  const archive = state.view === 'notes' && /^archive$/i.test(state.folder);
  const on = (v) => (v.id === 'archive' ? archive : v.id === 'notes' ? state.view === 'notes' && !archive : state.view === v.id);
  $('nav-views').innerHTML = VIEWS.map(
    (v) => `<a class="nav-item${on(v) ? ' active' : ''}${v.desk ? ' desk-only' : ''}" href="${v.hash}" title="${v.label}">${ic(v.icon)}<span>${v.label}</span></a>`,
  ).join('');
  for (const a of document.querySelectorAll('.nav-foot [data-route]')) a.classList.toggle('active', a.dataset.route === state.view);
  // The phone tab bar has no Trash tab; it's reached from Settings.
  const tab = state.view === 'trash' ? 'settings' : state.view;
  for (const a of document.querySelectorAll('.tabbar [data-tab]')) a.classList.toggle('active', a.dataset.tab === tab);

  const titles = { notes: state.folder.split('/').pop() || 'Notes', todos: 'Todos', trash: 'Trash', settings: 'Settings' };
  $('view-title').textContent = titles[state.view];

  $('app').dataset.view = state.view;
  $('app').toggleAttribute('data-in-folder', !!state.folder);
  $('search-row').hidden = state.view !== 'notes';
  $('notes').hidden = state.view !== 'notes';
  $('folder-actions').hidden = state.view !== 'notes';
  if (state.view !== 'notes') $('folder-crumbs').hidden = true;
  $('todos').hidden = state.view !== 'todos';
  $('trash').hidden = state.view !== 'trash';
  $('settings').hidden = state.view !== 'settings';
  closeNewMenus();
  notes.renderFolderTree();
  notes.paintTodoBadge();
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
// A tag in the sidebar: search for it from the top of Notes.
/** A tag in the sidebar or the details panel: search for it from the top of Notes. */
function searchTag(tag) {
  const q = `#${tag}`;
  $('search').value = state.q = q;
  // From Todos, Trash or Settings: already Notes as far as the route goes, or arriving there would clear the search.
  state.view = 'notes';
  location.hash = '#/notes';
  notes.setQuery(q);
}
$('nav-tags').addEventListener('click', (e) => {
  const a = e.target.closest('[data-tag]');
  if (!a) return;
  e.preventDefault();
  searchTag(a.dataset.tag);
});
document.querySelector('m3e-search-bar').addEventListener('clear', () => {
  state.q = '';
  notes.setQuery('');
});

// ---------- keyboard ----------

document.addEventListener('keydown', (e) => {
  // Cmd/Ctrl+K (or +O, as in Obsidian): the quick switcher, from anywhere, even mid-note.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'o') && !$('app').hidden) {
    e.preventDefault();
    notes.openSwitcher();
    return;
  }
  // Split keeps the grid beside the open note, so its shortcuts work there unless you're in the note.
  const noteHasFocus = notes.noteIsOpen() && ($('app').dataset.layout !== 'split' || e.target.closest('#note-screen'));
  if ($('app').hidden || noteHasFocus || e.target.closest('input, textarea, [contenteditable]')) return;
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
  <div class="setting-row layout-row">
    <div class="grow"><div class="setting-title">Layout</div><div class="muted small">On big screens; phones keep their own. Follows you to every browser you sign in on.</div></div>
    ${layoutPickerHtml()}
  </div>
  <div class="setting-row">
    <div class="grow"><div class="setting-title">Accent</div><div class="muted small">Buttons and highlights.</div></div>
    <div class="swatches" role="radiogroup" aria-label="Accent colour">
      ${ACCENTS.map((a) => `<button class="swatch${a.color === accent ? ' on' : ''}" data-accent="${a.color}" style="--c:${a.color}" role="radio" aria-checked="${a.color === accent}" aria-label="${a.name}" title="${a.name}"></button>`).join('')}
    </div>
  </div>
  <div class="setting-row">
    <div class="grow">
      <label class="setting-title" for="haptics">Vibration</label>
      <div class="muted small">A short buzz on taps, toggles and ticks. This browser only.</div>
    </div>
    <m3e-switch id="haptics"${hapticsEnabled() ? ' checked' : ''}></m3e-switch>
  </div>
</section>

<section class="setting-card">
  <h2>Notes</h2>
  <div class="setting-row" id="reminders-row" hidden>
    <div class="grow">
      <label class="setting-title" for="reminders">Todo reminders</label>
      <div class="muted small">A notification at a todo's reminder time, or 9am on its due date. This browser only; the Android app has its own.</div>
    </div>
    <m3e-switch id="reminders"></m3e-switch>
  </div>
  <div class="setting-row">
    <div class="grow">
      <label class="setting-title" for="hide-foldered">Keep filed notes in their folders</label>
      <div class="muted small">Home shows only notes that aren't in a folder, and each folder only its own notes, not its subfolders'. Search still finds everything. This browser only.</div>
    </div>
    <m3e-switch id="hide-foldered"${notes.prefs.hideFoldered ? ' checked' : ''}></m3e-switch>
  </div>
  <div class="setting-row">
    <div class="grow">
      <div class="setting-title">Import from Google Keep</div>
      <div class="muted small">In <a href="https://takeout.google.com/" target="_blank" rel="noopener">Google Takeout</a>, export only Keep, then pick the zip here. Notes land in a Keep folder with their checklists, labels, colours, pins and images. Running it again skips notes already imported.</div>
      <div id="keep-status" class="small" aria-live="polite" hidden></div>
    </div>
    <m3e-button id="keep-import" variant="tonal">${ic('upload', 'icon')}Import</m3e-button>
    <input id="keep-file" type="file" accept=".zip,.json,image/*" multiple hidden />
  </div>
  <div class="setting-row">
    <div class="grow">
      <div class="setting-title">Import from Notion</div>
      <div class="muted small">In Notion, Settings → Export all workspace content (or ⋯ → Export on a page), as Markdown &amp; CSV with subpages, then pick the zip here. Pages land in a Notion folder in the same tree, with links, images and databases (as tables). Running it again skips pages already imported.</div>
      <div id="notion-status" class="small" aria-live="polite" hidden></div>
    </div>
    <m3e-button id="notion-import" variant="tonal">${ic('upload', 'icon')}Import</m3e-button>
    <input id="notion-file" type="file" accept=".zip" hidden />
  </div>
  <div class="setting-row">
    <div class="grow">
      <div class="setting-title">Clip web pages</div>
      <div class="muted small">New → Clip a web page saves a page's article as a note, with its address. Or drag this to your bookmarks bar and click it on any page: <a id="clip-bookmarklet" href="javascript:location.href='${esc(location.origin)}/#/clip?url='+encodeURIComponent(location.href)">Clip to Sink</a>.</div>
    </div>
  </div>
  <div class="setting-row">
    <div class="grow">
      <div class="setting-title">Download all notes</div>
      <div class="muted small">Every note and attachment as a zip of plain files, in their folders. Opens in Obsidian or any editor.</div>
    </div>
    <m3e-button id="export-notes" variant="tonal">${ic('download', 'icon')}Download</m3e-button>
  </div>
</section>

<section class="setting-card">
  <h2>Public page</h2>
  <p class="muted small">Notes you choose (Share → Show on my public page) are listed here for anyone to read. Nothing else is.</p>
  <div class="setting-row">
    <m3e-form-field variant="outlined" class="grow" hide-subscript>
      <label slot="label" for="public-handle">Name in the address</label>
      <input id="public-handle" autocomplete="off" maxlength="30" />
    </m3e-form-field>
    <m3e-button id="public-save" variant="tonal">Save</m3e-button>
  </div>
  <div class="copy-row" id="public-link" hidden><code id="public-url"></code><m3e-icon-button id="public-open" aria-label="Open public page" title="Open">${ic('open_in_new')}</m3e-icon-button></div>
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
      <m3e-form-field variant="outlined" class="grow" hide-subscript>
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
  <h2>Calendar feed</h2>
  <p class="muted">Subscribe in Google or Apple Calendar to see your todos that have a date or reminder. Anyone with the link can read those todos, so keep it private and revoke it if it leaks.</p>
  <div class="setting-row">
    <div class="grow muted small" id="calendar-state"></div>
    <m3e-button id="calendar-revoke" variant="text" hidden>Revoke</m3e-button>
    <m3e-button id="calendar-create" variant="tonal">Create link</m3e-button>
  </div>
  <div id="calendar-result" hidden>
    <p class="small">Add this link as a calendar from URL. It's only shown now.</p>
    <div class="copy-row"><code id="calendar-url"></code><m3e-icon-button id="calendar-copy" aria-label="Copy calendar link" title="Copy">${ic('content_copy')}</m3e-icon-button></div>
  </div>
</section>

<section class="setting-card">
  <h2>Signed-in devices and assistants</h2>
  <div class="setting-row">
    <div class="grow"><div>Sign in on your phone</div><div class="muted small">Scan a code with the Sink app, or your phone's camera to use Sink in its browser.</div></div>
    <m3e-button id="phone-login" variant="tonal">${ic('qr_code_2', 'icon')}Show code</m3e-button>
  </div>
  <div id="connect-tokens" class="token-list"><m3e-loading-indicator></m3e-loading-indicator></div>
</section>

<section class="setting-card" id="people" hidden>
  <h2>People</h2>
  <p class="muted small">Who can sign in. Everyone gets their own notes; nobody can see anyone else's.</p>
  <div class="setting-row">
    <m3e-form-field variant="outlined" class="grow" hide-subscript>
      <label slot="label" for="people-entry">Email or user:name</label>
      <input id="people-entry" autocomplete="off" />
    </m3e-form-field>
    <m3e-button id="people-add" variant="tonal">${ic('person_add', 'icon')}Add</m3e-button>
  </div>
  <m3e-expansion-panel class="token-panel">
    <span slot="header">Invite someone with a passkey</span>
    <p class="muted small">For people without an account at your sign-in provider. They get a link that works once, for 7 days, and make a passkey with it.</p>
    <div class="setting-row">
      <m3e-form-field variant="outlined" class="grow" hide-subscript>
        <label slot="label" for="invite-name">Their name</label>
        <input id="invite-name" autocomplete="off" maxlength="60" />
      </m3e-form-field>
      <m3e-button id="invite-create" variant="tonal">${ic('passkey', 'icon')}Make link</m3e-button>
    </div>
    <div id="invite-result" hidden>
      <p class="small">Send them this link:</p>
      <div class="copy-row"><code id="invite-url"></code><m3e-icon-button id="invite-copy" aria-label="Copy invite link" title="Copy">${ic('content_copy')}</m3e-icon-button></div>
    </div>
  </m3e-expansion-panel>
  <div id="people-list" class="token-list"></div>
</section>

<section class="setting-card compact">
  <h2>Trash</h2>
  <div class="setting-row">
    <div class="grow muted small">Put back or delete notes you've deleted.</div>
    <m3e-button id="open-trash" variant="tonal">${ic('delete', 'icon')}Open trash</m3e-button>
  </div>
</section>

<section class="setting-card">
  <h2>Server</h2>
  <div id="server-info" class="facts"></div>
</section>

<section class="setting-card compact">
  <h2>Sign out</h2>
  <div class="setting-row">
    <div class="grow muted small">Signs out this browser. Other devices stay signed in.</div>
    <m3e-button id="logout" variant="tonal">${ic('logout', 'icon')}Sign out</m3e-button>
  </div>
</section>`;
  renderTokens();
  renderPeople();
  renderPublic();
  pushSubscription().then((push) => {
    if (!push) return;
    $('reminders-row').hidden = false;
    $('reminders').checked = !!push.sub && Notification.permission === 'granted';
  });
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
    // Assistant tokens carry the "mcp" scope (made by a connector or the Create token button); the rest are sign-ins.
    const isAssistant = (t) => t.scope === 'mcp';
    const feed = tokens.find((t) => t.scope === 'calendar');
    $('calendar-state').textContent = feed ? `Link active. ${feed.last_used_at ? `Last fetched ${ago(feed.last_used_at)}.` : 'Not fetched yet.'}` : 'No link yet.';
    $('calendar-create').textContent = feed ? 'Replace link' : 'Create link';
    $('calendar-revoke').hidden = !feed;
    $('calendar-revoke').dataset.id = feed?.id ?? '';
    const recent = (a, b) => (b.id === me.tokenId) - (a.id === me.tokenId) || (b.last_used_at ?? 0) - (a.last_used_at ?? 0);
    const row = (t) => `<div class="token-row">
  <span class="token-icon">${ic(isAssistant(t) ? 'hub' : 'devices')}</span>
  <div class="grow"><div>${esc(t.name.replace(/ \(MCP\)$/, ''))}${t.id === me.tokenId ? ' <span class="here">This browser</span>' : ''}</div>
  <div class="muted small">${t.last_used_at ? `Last used ${esc(ago(t.last_used_at))}` : 'Never used'}</div></div>
  ${t.id === me.tokenId ? '' : `<m3e-icon-button data-revoke="${esc(t.id)}" aria-label="Revoke ${esc(t.name)}" title="Revoke">${ic('close')}</m3e-icon-button>`}
</div>`;
    const group = (title, items, empty) =>
      `<h3 class="token-group">${title}<span>${items.length || ''}</span></h3>` +
      (items.length ? items.sort(recent).map(row).join('') : `<p class="muted small">${empty}</p>`);
    $('connect-tokens').innerHTML =
      group('Devices', tokens.filter((t) => !isAssistant(t) && t.scope !== 'calendar'), 'No devices signed in.') +
      group('Assistants', tokens.filter(isAssistant), 'No assistants connected yet. Add one with the connector URL above.');
  } catch (err) {
    $('connect-tokens').textContent = err.message;
  }
}

/** The owner's list of who may sign in, and the accounts that have. Hidden for everyone else. */
async function renderPeople() {
  try {
    if (!(await api.me()).admin) return;
    const { accounts, allowed, configured, invites } = await api.people();
    // Passkey accounts are on the list as sub:passkey:…; show their name instead.
    const label = (entry) => {
      const account = entry.startsWith('sub:passkey:') && accounts.find((a) => `sub:${a.subject}` === entry);
      return account ? `${esc(account.username ?? 'Passkey')} <span class="muted small">passkey</span>` : esc(entry);
    };
    const ago = (ts) => (ts ? `${relativeDay(ts).toLowerCase()} ${timeOf(ts)}` : 'not yet');
    const row = (icon, title, sub, action = '') => `<div class="token-row">
  <span class="token-icon">${ic(icon)}</span>
  <div class="grow"><div>${title}</div>${sub ? `<div class="muted small">${sub}</div>` : ''}</div>${action}
</div>`;
    const group = (title, rows, empty) =>
      `<h3 class="token-group">${title}<span>${rows.length || ''}</span></h3>` + (rows.length ? rows.join('') : `<p class="muted small">${empty}</p>`);
    const fixed = [...configured.users, ...configured.groups.map((g) => `group: ${g}`), ...(configured.anyone ? ['anyone the provider lets in'] : [])];
    $('people-list').innerHTML =
      group(
        'Allowed',
        [
          ...fixed.map((e) => row('lock', esc(e), 'Set on the server')),
          ...allowed.map((e) =>
            row(e.startsWith('sub:passkey:') ? 'passkey' : 'person', label(e), '', `<m3e-icon-button data-disallow="${esc(e)}" aria-label="Remove ${esc(e)}" title="Remove">${ic('close')}</m3e-icon-button>`),
          ),
        ],
        'Nobody yet.',
      ) +
      (invites.length
        ? group(
            'Invited',
            invites.map((i) =>
              row('schedule_send', esc(i.name), `Link works until ${esc(new Date(i.expires_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}`, `<m3e-icon-button data-uninvite="${esc(i.id)}" aria-label="Cancel invite for ${esc(i.name)}" title="Cancel invite">${ic('close')}</m3e-icon-button>`),
            ),
            '',
          )
        : '') +
      group(
        'Accounts',
        accounts.map((a) =>
          row(a.owner ? 'shield_person' : 'account_circle', esc(a.email ?? a.username ?? a.subject) + (a.owner ? ' <span class="here">Owner</span>' : ''), a.seen_at ? `Last signed in ${esc(ago(a.seen_at))}` : 'Never signed in'),
        ),
        'Nobody has signed in.',
      );
    $('people').hidden = false;
  } catch (err) {
    $('people-list').textContent = err.message;
    $('people').hidden = false;
  }
}

async function renderPublic(handle) {
  try {
    if (handle === undefined) ({ handle } = await api.publishInfo());
    $('public-handle').value = handle ?? '';
    $('public-url').textContent = handle ? `${location.origin}/public/${handle}` : '';
    $('public-link').hidden = !handle;
  } catch (err) {
    toast(err.message);
  }
}

async function addPerson() {
  const entry = $('people-entry').value.trim();
  if (!entry) return;
  try {
    await api.allowPerson(entry);
    $('people-entry').value = '';
    renderPeople();
  } catch (err) {
    toast(err.message);
  }
}

$('settings').addEventListener('keydown', (e) => {
  if (e.target.id === 'people-entry' && e.key === 'Enter') addPerson();
});

$('settings').addEventListener('change', (e) => {
  if (e.target.id === 'haptics') setHaptics(e.target.checked);
  if (e.target.id === 'reminders') {
    const on = e.target.checked;
    setReminders(on).catch((err) => {
      e.target.checked = !on;
      toast(err.message);
    });
  }
  if (e.target.id === 'hide-foldered') notes.prefs.hideFoldered = e.target.checked;
  if (e.target.id === 'keep-file') runImport('keep', e.target);
  if (e.target.id === 'notion-file') runImport('notion', e.target);
});

/** This browser's service worker and its push subscription (null if it has none), or null without Web Push. */
async function pushSubscription() {
  const reg = 'PushManager' in window && (await navigator.serviceWorker?.getRegistration());
  return reg ? { reg, sub: await reg.pushManager.getSubscription() } : null;
}

// Which account turned reminders on in this browser, so someone else signing in here doesn't get them.
const PUSH_ACCOUNT = 'sink.pushAccount';
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function setReminders(on) {
  const push = await pushSubscription();
  if (!push) return;
  if (push.sub) {
    await api.pushUnsubscribe(push.sub.endpoint).catch(() => {});
    await push.sub.unsubscribe();
  }
  localStorage.removeItem(PUSH_ACCOUNT);
  if (!on) return;
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site');
  const [{ key }, me] = await Promise.all([api.pushKey(), api.me()]);
  const applicationServerKey = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  // The registration can still be installing on a first visit; subscribing needs an active worker.
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  try {
    await api.pushSubscribe(sub.toJSON());
  } catch (err) {
    await sub.unsubscribe();
    throw err;
  }
  localStorage.setItem(PUSH_ACCOUNT, me.subject);
}

/**
 * On each start, makes this browser's subscription match the server: dropped if another account turned it on or the
 * server's key changed (a new database), else sent again, which also restores one the server lost.
 */
async function syncReminders() {
  const push = await pushSubscription();
  if (!push?.sub || Notification.permission !== 'granted') return;
  const [{ key }, me] = await Promise.all([api.pushKey(), api.me()]);
  const owner = localStorage.getItem(PUSH_ACCOUNT) ?? me.subject;
  const subKey = push.sub.options.applicationServerKey;
  if (owner !== me.subject || (subKey && b64u(subKey) !== key)) {
    localStorage.removeItem(PUSH_ACCOUNT);
    return push.sub.unsubscribe();
  }
  await api.pushSubscribe(push.sub.toJSON());
  localStorage.setItem(PUSH_ACCOUNT, me.subject);
}

/** Google Keep and Notion imports from Settings: loaded only when used. */
async function runImport(kind, input) {
  const files = [...input.files];
  input.value = '';
  if (!files.length) return;
  const status = $(`${kind}-status`);
  const button = $(`${kind}-import`);
  status.hidden = false;
  status.textContent = 'Reading…';
  button.disabled = true;
  try {
    const run = kind === 'keep' ? (await import('./keep-import.js')).importKeep : (await import('./notion-import.js')).importNotion;
    const r = await run(files, (done, total) => (status.textContent = `Importing ${done} of ${total}…`));
    status.textContent =
      [`Imported ${r.imported} note${r.imported === 1 ? '' : 's'}`, r.skipped && `skipped ${r.skipped} already here`, r.failed && `${r.failed} failed`]
        .filter(Boolean)
        .join(', ') + '.';
    notes.loadNotes();
  } catch (err) {
    status.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

$('settings').addEventListener('click', async (e) => {
  if (e.target.closest('#clip-bookmarklet')) {
    e.preventDefault();
    return toast('Drag it to your bookmarks bar');
  }
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
    if (!(await askConfirm({ title: 'Revoke this?', body: 'That device or assistant gets signed out.', action: 'Revoke', danger: true }))) return;
    await api.revokeToken(revoke.dataset.revoke).catch((err) => toast(err.message));
    return renderTokens();
  }
  const uninvite = e.target.closest('[data-uninvite]');
  if (uninvite) {
    await api.cancelInvite(uninvite.dataset.uninvite).catch((err) => toast(err.message));
    return renderPeople();
  }
  const disallow = e.target.closest('[data-disallow]');
  if (disallow) {
    const ok = await askConfirm({ title: 'Remove this person?', body: 'They get signed out and can’t sign in again. Their notes stay on the server.', action: 'Remove', danger: true });
    if (!ok) return;
    await api.disallowPerson(disallow.dataset.disallow).catch((err) => toast(err.message));
    return renderPeople();
  }
  const id = e.target.closest('[id]')?.id;
  if (id === 'people-add') {
    addPerson();
  } else if (id === 'invite-create') {
    try {
      const { url } = await api.invitePerson($('invite-name').value.trim());
      $('invite-url').textContent = url;
      $('invite-result').hidden = false;
      $('invite-name').value = '';
      renderPeople();
    } catch (err) {
      toast(err.message);
    }
  } else if (id === 'public-save') {
    try {
      renderPublic((await api.setHandle($('public-handle').value.trim() || null)).handle);
      toast('Saved');
    } catch (err) {
      toast(err.message);
    }
  } else if (id === 'public-open') {
    window.open($('public-url').textContent, '_blank', 'noopener');
  } else if (id === 'invite-copy') {
    await navigator.clipboard.writeText($('invite-url').textContent);
    toast('Copied');
  } else if (id === 'connect-url-copy') {
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
  } else if (id === 'phone-login') {
    try {
      const { url, expiresIn } = await api.phoneLogin();
      await showQr({
        title: 'Sign in on your phone',
        body: 'Scan this with the Sink app (Scan sign-in code) or your phone’s camera. It works once, for 5 minutes, and signs the phone into this account, so don’t share it.',
        url,
        ttl: expiresIn,
      });
      renderTokens();
    } catch (err) {
      toast(err.message);
    }
  } else if (id === 'calendar-create') {
    const replacing = !$('calendar-revoke').hidden;
    if (replacing && !(await askConfirm({ title: 'Replace the calendar link?', body: 'Calendars subscribed to the old link stop updating.', action: 'Replace', danger: true }))) return;
    try {
      const { token } = await api.createCalendarToken();
      $('calendar-url').textContent = `${location.origin}/api/calendar/${token}.ics`;
      $('calendar-result').hidden = false;
      renderTokens();
    } catch (err) {
      toast(err.message);
    }
  } else if (id === 'calendar-copy') {
    // No clipboard on a plain-http page.
    await navigator.clipboard
      .writeText($('calendar-url').textContent)
      .then(() => toast('Copied'))
      .catch(() => toast("Couldn't copy: select the link instead"));
  } else if (id === 'calendar-revoke') {
    if (!(await askConfirm({ title: 'Revoke the calendar link?', body: 'Calendars subscribed to it stop updating.', action: 'Revoke', danger: true }))) return;
    await api.revokeToken($('calendar-revoke').dataset.id).catch((err) => toast(err.message));
    $('calendar-result').hidden = true;
    renderTokens();
  } else if (id === 'export-notes') {
    location.href = '/api/notes/export';
  } else if (id === 'keep-import' || id === 'notion-import') {
    $(id.replace('import', 'file')).click();
  } else if (id === 'open-trash') {
    location.hash = '#/trash';
  } else if (id === 'logout') {
    // The next person to sign in on this browser shouldn't get these reminders.
    await setReminders(false).catch(() => {});
    await api.logout().catch(() => {});
    showLogin();
  }
});

// ---------- new note / todo ----------

// One list of things to make, shown as the phone's FAB menu and the desktop "New" menu.
const NEW_ITEMS = [
  { id: 'note', label: 'Note', icon: 'edit', run: () => notes.newNote() },
  { id: 'todo', label: 'Todo', icon: 'add_task', run: () => notes.quickTodo() },
  { id: 'folder', label: 'Folder', icon: 'create_new_folder', run: () => notes.newFolderHere(state.view === 'notes' ? state.folder : '') },
  { id: 'board', label: 'Board', icon: 'draw', run: () => notes.newBoard() },
  { id: 'clip', label: 'Clip a web page', icon: 'link', run: () => notes.clipPage() },
  { id: 'template', label: 'From template', icon: 'content_copy', run: () => notes.newFromTemplate() },
];
const itemHtml = (cls) =>
  NEW_ITEMS.map((it) => `<button class="${cls}" role="menuitem" data-new="${it.id}">${ic(it.icon)}<span>${it.label}</span></button>`).join('');
// Phone: Material's own FAB menu (the same component as the M3 playground); desktop: a menu under "New".
$('new-fab-menu').innerHTML = NEW_ITEMS.map(
  (it) => `<m3e-fab-menu-item data-new="${it.id}">${ic(it.icon, 'icon')}${it.label}</m3e-fab-menu-item>`,
).join('');
$('new-menu').innerHTML = itemHtml('new-item');

function closeNewMenus() {
  $('new-fab-menu').hidePopover?.();
  $('new-menu').hidden = true;
  for (const b of document.querySelectorAll('#add-btn, [data-new-tab]')) b.setAttribute('aria-expanded', 'false');
}

/** The New menu under `anchor`: the New button, or the Tabs layout's + tab. */
function openNewMenu(anchor) {
  const open = $('new-menu').hidden;
  closeNewMenus();
  if (!open) return;
  const r = anchor.getBoundingClientRect();
  // Under the button, kept on screen when the button is near the right edge.
  Object.assign($('new-menu').style, { left: `${Math.min(r.left, innerWidth - 240)}px`, top: `${r.bottom + 6}px` });
  $('new-menu').hidden = false;
  anchor.setAttribute('aria-expanded', 'true');
  $('new-menu').querySelector('button')?.focus();
}

$('add-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  openNewMenu($('add-btn'));
});
for (const box of ['new-fab-menu', 'new-menu']) {
  $(box).addEventListener('click', (e) => {
    const item = NEW_ITEMS.find((it) => it.id === e.target.closest('[data-new]')?.dataset.new);
    if (!item) return;
    closeNewMenus();
    item.run();
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#fab-menu, #new-menu, #add-btn, [data-new-tab]')) closeNewMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('new-menu').hidden) {
    closeNewMenus();
    $('add-btn').focus();
  }
});

const markScrolled = () => document.querySelector('.main-head').classList.toggle('scrolled', $('main').scrollTop + scrollY > 4);
$('main').addEventListener('scroll', markScrolled, { passive: true });
addEventListener('scroll', markScrolled, { passive: true });

notes.initNotes({ toast, navigate: (hash) => (location.hash = hash) });
notes.wireNotes();
initLayout({
  toast,
  openNewMenu,
  searchTag,
  toggleTheme: () => {
    storage.set('scheme', theme.hasAttribute('data-dark') ? 'light' : 'dark');
    applyTheme();
  },
});
wirePicker($('settings'));

boot();
if ('serviceWorker' in navigator && !import.meta.env.DEV) navigator.serviceWorker.register('/sw.js');

// An installed app can stay open for days on an old bundle. sw.js is the same file every deploy, so the browser never
// sees a new worker; the hashed entry script in a fresh index.html is what changes, so compare that with ours.
const runningEntry = document.querySelector('script[type=module][src]')?.getAttribute('src');
let lastUpdateCheck = 0;
async function checkForUpdate() {
  if (import.meta.env.DEV || document.hidden || Date.now() - lastUpdateCheck < 60_000) return;
  lastUpdateCheck = Date.now();
  const html = await fetch('/', { cache: 'no-store' })
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '');
  const entry = new DOMParser().parseFromString(html, 'text/html').querySelector('script[type=module][src]')?.getAttribute('src');
  if (!entry || entry === runningEntry) return;
  toast('A new version of Sink is ready', {
    action: 'Reload',
    duration: 0,
    onAction: async () => {
      if (await notes.saveForReload()) location.reload();
      else toast("Couldn't save the note, so not reloading yet");
    },
  });
}
document.addEventListener('visibilitychange', checkForUpdate);
setInterval(checkForUpdate, 30 * 60_000);
