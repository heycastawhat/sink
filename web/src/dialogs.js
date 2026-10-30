// Small modal dialogs on the native <dialog> element: a text prompt and a folder picker.

import { esc } from './util.js';

const ic = (name, slot) => `<m3e-icon name="${esc(name)}"${slot ? ` slot="${slot}"` : ''}></m3e-icon>`;

function open(html, wire) {
  const host = document.getElementById('theme') ?? document.body;
  const dlg = document.createElement('dialog');
  dlg.className = 'sink-dialog';
  dlg.innerHTML = html;
  host.append(dlg);
  return new Promise((resolve) => {
    const done = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    // A click on the backdrop (the dialog element itself, outside its content) cancels.
    dlg.addEventListener('mousedown', (e) => e.target === dlg && done(null));
    const afterOpen = wire(dlg, done);
    dlg.showModal();
    afterOpen?.();
  });
}

/** Asks for a line of text. Resolves to the trimmed text, or null if cancelled. */
export function askText({ title, label = 'Name', value = '', action = 'Save' }) {
  return open(
    `<form method="dialog" class="sink-dialog-body">
  <h2>${esc(title)}</h2>
  <label class="dialog-field"><span>${esc(label)}</span><input name="text" value="${esc(value)}" autocomplete="off" required /></label>
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
 * Tomorrow...). Resolves to { text, due, time } with empty fields as null, or null if cancelled.
 */
export function editTodo({ text, due, time, dates }) {
  return open(
    `<form method="dialog" class="sink-dialog-body">
  <h2>Edit todo</h2>
  <label class="dialog-field"><span>Todo</span><input name="text" value="${esc(text)}" autocomplete="off" required /></label>
  <div class="date-chips">${dates.map((d) => `<m3e-button type="button" variant="tonal" size="small" data-due="${esc(d.due ?? '')}">${esc(d.label)}</m3e-button>`).join('')}</div>
  <div class="dialog-row">
    <label class="dialog-field"><span>Due</span><input name="due" type="date" value="${esc(due ?? '')}" /></label>
    <label class="dialog-field"><span>Remind at</span><input name="time" type="time" value="${esc(time ?? '')}" /></label>
  </div>
  <div class="dialog-actions">
    <m3e-button data-cancel variant="text">Cancel</m3e-button>
    <m3e-button data-ok variant="filled">Save</m3e-button>
  </div>
</form>`,
    (dlg, done) => {
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
 * Sharing one note: a link anyone can read (not edit). `shared` is the current link or null; `share()` makes one
 * and resolves to its URL, `unshare()` stops it. Resolves when closed.
 */
export function shareNote({ title, shared, share, unshare }) {
  return open(
    `<div class="sink-dialog-body share-dialog">
  <h2>Share “${esc(title)}”</h2>
  <p class="muted small" data-off>Make a link anyone can open to read this note, without signing in. They can't edit it, see your other notes, or find it in search engines.</p>
  <p class="muted small" data-on>Anyone with this link can read this note (not edit it). It shows the latest text.</p>
  <div class="copy-row" data-on><code class="share-url"></code><m3e-icon-button data-copy aria-label="Copy link" title="Copy">${ic('content_copy')}</m3e-icon-button></div>
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
      const show = (url) => {
        for (const el of dlg.querySelectorAll('[data-on]')) el.hidden = !url;
        for (const el of dlg.querySelectorAll('[data-off]')) el.hidden = !!url;
        dlg.querySelector('.share-url').textContent = url ?? '';
      };
      const fail = (err) => {
        error.textContent = err.message;
        error.hidden = false;
      };
      show(shared);
      dlg.querySelector('[data-make]').addEventListener('click', async () => {
        try {
          const url = await share();
          show(url);
          await navigator.clipboard?.writeText(url).catch(() => {});
        } catch (err) {
          fail(err);
        }
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
  ${ic('history')}<span class="version-main"><span class="version-when">${esc(when(v.at))}</span><span class="version-preview">${esc(v.preview || 'Empty')}</span></span></button>`,
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
    <m3e-button data-new variant="text">${ic('create_new_folder')}New folder</m3e-button>
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
