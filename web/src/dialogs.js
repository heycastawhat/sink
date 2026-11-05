// Small modal dialogs on the native <dialog> element: a text prompt and a folder picker.

import { esc, inlineHtml } from './util.js';

const ic = (name, slot) => `<m3e-icon name="${esc(name)}"${slot ? ` slot="${slot}"` : ''}></m3e-icon>`;

function open(html, wire) {
  const host = document.getElementById('theme') ?? document.body;
  const dlg = document.createElement('dialog');
  dlg.className = 'sink-dialog';
  dlg.innerHTML = html;
  host.append(dlg);
  return new Promise((resolve) => {
    const done = (value) => {
      if (dlg.classList.contains('closing')) return;
      resolve(value);
      // Let the exit animation play (it's a CSS transition on [open]); reduced motion skips it.
      dlg.classList.add('closing');
      const finish = () => {
        dlg.close();
        dlg.remove();
      };
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
      else setTimeout(finish, 180);
    };
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (!dlg.classList.contains('closing')) done(null);
    });
    // A click on the backdrop (the dialog element itself, outside its content) cancels.
    dlg.addEventListener('mousedown', (e) => e.target === dlg && done(null));
    const afterOpen = wire(dlg, done);
    dlg.showModal();
    // A form field renders its slot a moment after it's attached; until then its input can't take focus.
    Promise.all([...dlg.querySelectorAll('m3e-form-field')].map((f) => customElements.whenDefined(f.localName).then(() => f.updateComplete))).then(() => afterOpen?.());
  });
}

/** Asks for a line of text. Resolves to the trimmed text, or null if cancelled. */
export function askText({ title, label = 'Name', value = '', action = 'Save' }) {
  return open(
    `<form method="dialog" class="sink-dialog-body">
  <h2>${esc(title)}</h2>
  <m3e-form-field variant="outlined" class="dialog-field" hide-subscript><label slot="label" for="dlg-text">${esc(label)}</label><input id="dlg-text" name="text" value="${esc(value)}" autocomplete="off" required /></m3e-form-field>
  <p class="dialog-error" hidden></p>
  <div class="dialog-actions">
    <m3e-button data-cancel variant="text">Cancel</m3e-button>
    <m3e-button data-ok variant="filled">${esc(action)}</m3e-button>
  </div>
</form>`,
    (dlg, done) => {
      const input = dlg.querySelector('input');
      const submit = () => {
        const text = input.value.trim();
        if (!text) return input.focus();
        done(text);
      };
      dlg.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        submit();
      });
      dlg.querySelector('[data-ok]').addEventListener('click', submit);
      dlg.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      return () => {
        input.focus();
        // Select the name without its extension, like a file manager.
        if (value) input.setSelectionRange(0, value.replace(/(\.excalidraw)?\.md$/i, '').length);
      };
    },
  );
}

/** A yes/no question in an M3 dialog (instead of the browser's confirm()). Resolves to true or false. */
export function askConfirm({ title, body = '', action = 'OK', danger = false }) {
  return open(
    `<div class="sink-dialog-body" role="alertdialog">
  <h2>${esc(title)}</h2>
  ${body ? `<p class="muted dialog-text">${esc(body)}</p>` : ''}
  <div class="dialog-actions">
    <m3e-button data-cancel variant="text">Cancel</m3e-button>
    <m3e-button data-ok variant="filled"${danger ? ' data-confirm-danger class="danger"' : ''}>${esc(action)}</m3e-button>
  </div>
</div>`,
    (dlg, done) => {
      dlg.querySelector('[data-ok]').addEventListener('click', () => done(true));
      dlg.querySelector('[data-cancel]').addEventListener('click', () => done(false));
    },
  ).then(Boolean);
}

/**
 * Picks one of `items` ({ id, label, detail?, icon? }). Resolves to its id, or null if cancelled. `empty` is shown
 * when there's nothing to pick.
 */
export function pickFromList({ title, items, empty = 'Nothing here yet.' }) {
  return open(
    `<div class="sink-dialog-body">
  <h2>${esc(title)}</h2>
  <div class="picker-list" role="listbox">${
    items.length
      ? items
          .map(
            (it) => `<button type="button" class="picker-row version-row" data-id="${esc(it.id)}">${ic(it.icon ?? 'description')}<span class="version-main"><span class="version-when">${esc(it.label)}</span>${
              it.detail ? `<span class="version-preview">${esc(it.detail)}</span>` : ''
            }</span></button>`,
          )
          .join('')
      : `<p class="muted version-empty">${esc(empty)}</p>`
  }</div>
  <div class="dialog-actions"><m3e-button data-cancel variant="text">Cancel</m3e-button></div>
</div>`,
    (dlg, done) => {
      dlg.querySelector('.picker-list').addEventListener('click', (e) => {
        const row = e.target.closest('[data-id]');
        if (row) done(row.dataset.id);
      });
      dlg.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    },
  );
}

/**
 * Editing a todo: its text, due date and reminder time. `dates` ({ label, due }) are one-tap date buttons (Today,
 * Tomorrow...). Resolves to { text, due, time } with empty fields as null, { cancel: true } to cancel the todo
 * (Tasks' `[-]`), or null if closed.
 */
export function editTodo({ text, due, time, dates }) {
  return open(
    `<form method="dialog" class="sink-dialog-body">
  <h2>Edit todo</h2>
  <m3e-form-field variant="outlined" class="dialog-field" hide-subscript><label slot="label" for="dlg-todo">Todo</label><input id="dlg-todo" name="text" value="${esc(text)}" autocomplete="off" required /></m3e-form-field>
  <div class="date-chips">${dates.map((d) => `<m3e-button type="button" variant="tonal" size="small" data-due="${esc(d.due ?? '')}">${esc(d.label)}</m3e-button>`).join('')}</div>
  <div class="dialog-row">
    <m3e-form-field variant="outlined" class="dialog-field" float-label="always" hide-subscript><label slot="label" for="dlg-due">Due</label><input id="dlg-due" name="due" type="date" value="${esc(due ?? '')}" /></m3e-form-field>
    <m3e-form-field variant="outlined" class="dialog-field" float-label="always" hide-subscript><label slot="label" for="dlg-time">Remind at</label><input id="dlg-time" name="time" type="time" value="${esc(time ?? '')}" /></m3e-form-field>
  </div>
  <div class="dialog-actions">
    <m3e-button data-drop variant="text" class="dialog-start">Cancel todo</m3e-button>
    <m3e-button data-cancel variant="text">Close</m3e-button>
    <m3e-button data-ok variant="filled">Save</m3e-button>
  </div>
</form>`,
    (dlg, done) => {
      dlg.querySelector('[data-drop]').addEventListener('click', () => done({ cancel: true }));
      const [textIn, dueIn, timeIn] = ['text', 'due', 'time'].map((n) => dlg.querySelector(`[name="${n}"]`));
      const submit = () => {
        const value = textIn.value.trim();
        if (!value) return textIn.focus();
        // A reminder time needs a day to be on.
        if (timeIn.value && !dueIn.value) dueIn.value = dates[0]?.due ?? '';
        done({ text: value, due: dueIn.value || null, time: (dueIn.value && timeIn.value) || null });
      };
      dlg.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        submit();
      });
      dlg.querySelector('.date-chips').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-due]');
        if (!chip) return;
        dueIn.value = chip.dataset.due;
        if (!chip.dataset.due) timeIn.value = '';
      });
      dlg.querySelector('[data-ok]').addEventListener('click', submit);
      dlg.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      return () => textIn.focus();
    },
  );
}

/**
 * Sharing one note: a link anyone can read, and edit if `editable`. `shared` is the current share
 * ({ url, editable, edited }) or null; `share(editable)` makes or updates one and resolves to it, `unshare()` stops it.
 * `published` is { on, searchable, url } for the account's public page (url null until it has a name);
 * `publish({ on?, searchable? })` changes it and resolves to the same. Resolves when closed.
 */
export function shareNote({ title, shared, share, unshare, published, publish }) {
  return open(
    `<div class="sink-dialog-body share-dialog">
  <h2>Share “${esc(title)}”</h2>
  <p class="muted small" data-off>Make a link anyone can open to read this note, without signing in. They can't see your other notes, or find it in search engines.</p>
  <p class="muted small" data-on>Anyone with this link can read this note. It shows the latest text.</p>
  <div class="copy-row" data-on><code class="share-url"></code><m3e-icon-button data-copy aria-label="Copy link" title="Copy">${ic('content_copy')}</m3e-icon-button></div>
  <div class="setting-row">
    <div class="grow">
      <label class="setting-title" for="share-editable">Anyone with the link can edit</label>
      <div class="muted small">They give a name first. Earlier text stays in the note's history.</div>
      <div class="muted small share-edited"></div>
    </div>
    <m3e-switch id="share-editable"></m3e-switch>
  </div>
  <div class="setting-row">
    <div class="grow">
      <label class="setting-title" for="share-publish">Show on my public page</label>
      <div class="muted small share-public"></div>
    </div>
    <m3e-switch id="share-publish"></m3e-switch>
  </div>
  <div class="setting-row">
    <div class="grow">
      <label class="setting-title" for="share-searchable">Let search engines find it</label>
      <div class="muted small">Off: only people with the link or your page's address see it.</div>
    </div>
    <m3e-switch id="share-searchable"></m3e-switch>
  </div>
  <p class="dialog-error" hidden></p>
  <div class="dialog-actions">
    <m3e-button data-stop variant="text" data-on>${ic('link_off', 'icon')}Stop sharing</m3e-button>
    <span class="spacer"></span>
    <m3e-button data-cancel variant="text">Done</m3e-button>
    <m3e-button data-make variant="filled" data-off>${ic('link', 'icon')}Create link</m3e-button>
  </div>
</div>`,
    (dlg, done) => {
      const error = dlg.querySelector('.dialog-error');
      const editable = dlg.querySelector('#share-editable');
      const show = (s) => {
        for (const el of dlg.querySelectorAll('[data-on]')) el.hidden = !s;
        for (const el of dlg.querySelectorAll('[data-off]')) el.hidden = !!s;
        dlg.querySelector('.share-url').textContent = s?.url ?? '';
        dlg.querySelector('.share-edited').textContent = s?.edited ?? '';
        if (s) editable.checked = s.editable;
      };
      const fail = (err) => {
        error.textContent = err.message;
        error.hidden = false;
      };
      show(shared);
      dlg.querySelector('[data-make]').addEventListener('click', async () => {
        try {
          const s = await share(editable.checked);
          show(s);
          await navigator.clipboard?.writeText(s.url).catch(() => {});
        } catch (err) {
          fail(err);
        }
      });
      // Before there's a link the switch only picks what Create link makes; after, it changes the link at once.
      editable.addEventListener('change', async () => {
        if (dlg.querySelector('[data-make]').hidden)
          await share(editable.checked).then(show, (err) => {
            editable.checked = !editable.checked;
            fail(err);
          });
      });
      dlg.querySelector('[data-copy]').addEventListener('click', () =>
        navigator.clipboard?.writeText(dlg.querySelector('.share-url').textContent).catch(fail),
      );
      dlg.querySelector('[data-stop]').addEventListener('click', async () => {
        try {
          await unshare();
          show(null);
        } catch (err) {
          fail(err);
        }
      });
      const pub = dlg.querySelector('#share-publish');
      const searchable = dlg.querySelector('#share-searchable');
      const showPublished = (p) => {
        pub.checked = p.on;
        pub.disabled = !p.url;
        searchable.checked = p.searchable;
        searchable.disabled = !p.on;
        const note = dlg.querySelector('.share-public');
        note.innerHTML = !p.url
          ? 'Pick a name for your public page in Settings first.'
          : p.on
            ? `Listed at <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.replace(/^https?:\/\//, ''))}</a> for anyone to read.`
            : 'Lists it on your public page for anyone to read.';
      };
      showPublished(published);
      for (const [el, key] of [[pub, 'on'], [searchable, 'searchable']])
        el.addEventListener('change', () =>
          publish({ [key]: el.checked }).then(showPublished, (err) => {
            el.checked = !el.checked;
            fail(err);
          }),
        );
      dlg.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    },
  );
}

/**
 * Version history: `versions` (newest first, from GET /api/notes/versions) as a list; picking one loads its text
 * with `load(id)` to read before restoring. `when(at)` formats a time. Resolves to the text to restore, or null.
 */
export function pickVersion({ versions, load, when }) {
  return open(
    `<div class="sink-dialog-body version-dialog">
  <h2>Version history</h2>
  <p class="muted small">Sink keeps the text from before each editing session, newest first.</p>
  <div class="picker-list" role="listbox">${
    versions.length
      ? versions
          .map(
            (v) => `<button type="button" class="picker-row version-row" data-id="${v.id}">
  ${ic('history')}<span class="version-main"><span class="version-when">${esc(when(v.at))}</span><span class="version-preview">${v.preview ? inlineHtml(v.preview) : 'Empty'}</span></span><m3e-icon name="chevron_right" class="version-go"></m3e-icon></button>`,
          )
          .join('')
      : '<p class="muted version-empty">No earlier versions yet. They start once you edit this note.</p>'
  }</div>
  <pre class="version-text" hidden></pre>
  <p class="dialog-error" hidden></p>
  <div class="dialog-actions">
    <m3e-button data-back variant="text" hidden>${ic('arrow_back', 'icon')}All versions</m3e-button>
    <span class="spacer"></span>
    <m3e-button data-cancel variant="text">Close</m3e-button>
    <m3e-button data-ok variant="filled" hidden>Restore</m3e-button>
  </div>
</div>`,
    (dlg, done) => {
      const list = dlg.querySelector('.picker-list');
      const text = dlg.querySelector('.version-text');
      const error = dlg.querySelector('.dialog-error');
      const [backBtn, okBtn] = [dlg.querySelector('[data-back]'), dlg.querySelector('[data-ok]')];
      let picked = null;
      const show = (reading) => {
        list.hidden = reading;
        text.hidden = backBtn.hidden = okBtn.hidden = !reading;
        // Back and Restore are the choices then (Escape still closes), so the row fits a phone.
        dlg.querySelector('[data-cancel]').hidden = reading;
      };
      list.addEventListener('click', async (e) => {
        const row = e.target.closest('[data-id]');
        if (!row) return;
        try {
          picked = (await load(Number(row.dataset.id))).content;
          text.textContent = picked;
          error.hidden = true;
          show(true);
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      });
      backBtn.addEventListener('click', () => show(false));
      okBtn.addEventListener('click', () => done(picked));
      dlg.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    },
  );
}

/**
 * Picks a folder. `folders` is every folder path; `exclude` hides a folder and everything in it (you can't move a
 * folder into itself); `createFolder(path)` makes a new one from inside the picker. Resolves to the path ("" for
 * the top level) or null if cancelled.
 */
export function pickFolder({ title, folders, current = '', exclude = null, action = 'Move here', createFolder }) {
  let list = [...folders];
  let selected = current;
  const visible = () =>
    list
      .filter((f) => !(exclude && (f === exclude || f.startsWith(exclude + '/'))))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const row = (path, name, depth) =>
    `<button type="button" class="picker-row${path === selected ? ' on' : ''}" data-path="${esc(path)}" style="--depth:${depth}">
  ${ic(path ? 'folder' : 'home')}<span>${esc(name)}</span></button>`;
  const rows = () =>
    row('', 'Notes', 0) + visible().map((f) => row(f, f.split('/').pop(), f.split('/').length)).join('');

  return open(
    `<div class="sink-dialog-body">
  <h2>${esc(title)}</h2>
  <div class="picker-list" role="listbox"></div>
  <p class="dialog-error" hidden></p>
  <div class="dialog-actions">
    <m3e-button data-new variant="text" aria-label="New folder">${ic('create_new_folder', 'icon')}New<span class="wide-only"> folder</span></m3e-button>
    <span class="spacer"></span>
    <m3e-button data-cancel variant="text">Cancel</m3e-button>
    <m3e-button data-ok variant="filled">${esc(action)}</m3e-button>
  </div>
</div>`,
    (dlg, done) => {
      const box = dlg.querySelector('.picker-list');
      const error = dlg.querySelector('.dialog-error');
      const render = () => {
        box.innerHTML = rows();
        box.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
      };
      render();
      box.addEventListener('click', (e) => {
        const r = e.target.closest('[data-path]');
        if (!r) return;
        selected = r.dataset.path;
        render();
      });
      box.addEventListener('dblclick', (e) => e.target.closest('[data-path]') && done(selected));
      dlg.querySelector('[data-ok]').addEventListener('click', () => done(selected));
      dlg.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      dlg.querySelector('[data-new]').addEventListener('click', async () => {
        const name = await askText({ title: selected ? `New folder in ${selected.split('/').pop()}` : 'New folder', action: 'Create' });
        if (!name) return;
        const path = selected ? `${selected}/${name}` : name;
        try {
          await createFolder(path);
          list.push(...path.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')).filter((p) => !list.includes(p)));
          selected = path;
          error.hidden = true;
          render();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      });
    },
  );
}
