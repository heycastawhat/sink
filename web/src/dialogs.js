// Small modal dialogs on the native <dialog> element: a text prompt and a folder picker.

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ic = (name) => `<m3e-icon name="${esc(name)}"></m3e-icon>`;

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
