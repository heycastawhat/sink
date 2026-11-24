// Live co-editing: everyone with a note open edits the same copy on the server (server/src/live.ts), and sees the
// others' changes and cursors as they happen. Built on CodeMirror's collab extension: local changes go up with the
// version they were made on, the server rebases and applies them and sends every change back down, ours included
// (that's how a change is confirmed). The server writes the file; this only talks to it.
//
// The stream is Server-Sent Events read with fetch (so a refusal's status can be told from a dropped connection), and
// what the client sends goes in small POSTs. A dropped connection resumes where it was; if the server can't do that
// (it restarted), the editor takes the server's text and anything typed meanwhile is sent back to be merged.

import { collab, getSyncedVersion, receiveUpdates, sendableUpdates } from '@codemirror/collab';
import { ChangeSet, Compartment, EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView, layer, RectangleMarker, ViewPlugin } from '@codemirror/view';
import { normalizeLineEndings } from './util.js';

const PUSH_DELAY = 40;
const PRESENCE_DELAY = 150;

const randomId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** `a` → `b` as one replacement of the part that differs (a whole-text swap would throw the cursor about). */
function replaceDiff(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return ChangeSet.empty(a.length);
  return ChangeSet.of([{ from: start, to: endA, insert: b.slice(start, endB) }], a.length);
}

// ---- other people's cursors

const setPeople = StateEffect.define();

/**
 * Someone's caret, drawn on a layer over the text (like CodeMirror's own cursor) rather than inside it: a widget in
 * the line would push the text about, and vanish in markup that live preview hides. Their name shows for a moment
 * after it moves, then fades, so it doesn't sit over what's written.
 */
class CaretMarker {
  constructor(name, color, left, top, height) {
    Object.assign(this, { name, color, left, top, height });
  }
  eq(other) {
    return other.name === this.name && other.color === this.color && other.left === this.left && other.top === this.top && other.height === this.height;
  }
  draw() {
    const caret = document.createElement('div');
    caret.className = 'cm-remote-caret';
    Object.assign(caret.style, { left: `${this.left}px`, top: `${this.top}px`, height: `${this.height}px`, borderColor: this.color });
    const label = document.createElement('div');
    label.className = 'cm-remote-name';
    label.style.backgroundColor = this.color;
    label.textContent = this.name;
    caret.append(label);
    return caret;
  }
}

/** A highlighted stretch of someone's selection, in their colour. */
class SelectionMarker {
  constructor(color, rect) {
    Object.assign(this, { color, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  }
  eq(other) {
    return other.color === this.color && other.left === this.left && other.top === this.top && other.width === this.width && other.height === this.height;
  }
  draw() {
    const el = document.createElement('div');
    el.className = 'cm-remote-selection';
    Object.assign(el.style, { left: `${this.left}px`, top: `${this.top}px`, height: `${this.height}px`, backgroundColor: `${this.color}33` });
    if (this.width != null) el.style.width = `${this.width}px`;
    return el;
  }
}

const peopleField = StateField.define({
  create: () => [],
  update(people, tr) {
    for (const e of tr.effects) if (e.is(setPeople)) return e.value;
    if (!tr.docChanged) return people;
    return people.map((p) => ({ ...p, cursor: p.cursor && { anchor: tr.changes.mapPos(p.cursor.anchor), head: tr.changes.mapPos(p.cursor.head, 1) } }));
  },
});

const remoteSelections = layer({
  above: false,
  class: 'cm-remote-selections',
  update: (u) => u.docChanged || u.viewportChanged || u.geometryChanged || u.startState.field(peopleField) !== u.state.field(peopleField),
  markers(view) {
    const out = [];
    const len = view.state.doc.length;
    for (const p of view.state.field(peopleField)) {
      if (!p.cursor) continue;
      const anchor = Math.min(p.cursor.anchor, len);
      const head = Math.min(p.cursor.head, len);
      if (anchor === head) continue;
      for (const rect of RectangleMarker.forRange(view, '', EditorSelection.range(anchor, head))) out.push(new SelectionMarker(p.color, rect));
    }
    return out;
  },
});

const remoteCarets = layer({
  above: true,
  class: 'cm-remote-carets',
  update: (u) => u.docChanged || u.viewportChanged || u.geometryChanged || u.startState.field(peopleField) !== u.state.field(peopleField),
  markers(view) {
    const out = [];
    const len = view.state.doc.length;
    for (const p of view.state.field(peopleField)) {
      if (!p.cursor) continue;
      const [rect] = RectangleMarker.forRange(view, '', EditorSelection.cursor(Math.min(p.cursor.head, len)));
      if (rect) out.push(new CaretMarker(p.name, p.color, rect.left, rect.top, rect.height));
    }
    return out;
  },
});

/** Avatars for who else is in the note: a coloured initial each, the name on hover. */
export function renderPeople(el, people) {
  const others = people.filter((p) => !p.me);
  el.hidden = !others.length;
  el.replaceChildren(
    ...others.slice(0, 5).map((p) => {
      const chip = document.createElement('span');
      chip.className = 'live-person';
      chip.style.backgroundColor = p.color;
      chip.textContent = (p.name.trim()[0] ?? '?').toUpperCase();
      chip.title = `${p.name} is here`;
      return chip;
    }),
  );
  if (others.length > 5) {
    const more = document.createElement('span');
    more.className = 'live-person more';
    more.textContent = `+${others.length - 5}`;
    el.append(more);
  }
  el.setAttribute('aria-label', others.length ? `Also here: ${others.map((p) => p.name).join(', ')}` : '');
}

/**
 * A live session for one editor. `extension` goes into the editor; it connects once the editor is up.
 *
 * opts:
 * - streamUrl(params), actionUrl(name): where the stream and the POSTs go
 * - base: { text, hash }: what the editor was loaded with, so typing before the stream is up isn't lost
 * - onStatus(text, kind), onPeople(people), onConflict(text), onGone(), onMoved(path), onReadOnly(), onRefused(message)
 * - onUnavailable(): live editing can't be had here (an older server); the caller saves the old way
 * - start: false to wait for `start(base)` (a new note has no file to edit together until its first save)
 */
export function liveSession(opts) {
  opts.base = { ...opts.base, text: normalizeLineEndings(opts.base.text) };
  const clientID = randomId();
  const editable = new Compartment();
  let view = null;
  let conn = null;
  let epoch = null;
  let offset = 0;
  let hash = opts.base.hash;
  let serverDirty = false;
  let connected = false;
  let everConnected = false;
  let destroyed = false;
  let unavailable = false;
  let controller = null;
  let retries = 0;
  let retryTimer = null;
  let pushing = null;
  let pushTimer = null;
  let presenceTimer = null;
  let keepVersion = false;
  /** Throw away what's typed but unconfirmed on the next start (the server refused it). */
  let discard = false;
  const waiters = new Set();
  // Now and then even when nothing moves, so the server can tell an open tab from one that closed without a word.
  let heartbeat = null;

  const serverVersion = () => getSyncedVersion(view.state) + offset;
  const unconfirmed = () => (view ? sendableUpdates(view.state) : []);
  // Before joining, the REST create may already have saved queued edits. Only text beyond that snapshot is unsaved.
  const pending = () => (everConnected ? unconfirmed().length > 0 : !!view && view.state.doc.toString() !== opts.base.text) || serverDirty;
  const wake = () => {
    for (const w of [...waiters]) w();
  };

  let lastPresence = '';
  // A refusal's message stays up a while before "Saved" replaces it.
  let holdStatus = 0;
  function status() {
    if (Date.now() < holdStatus) return;
    if (!connected) return opts.onStatus?.(navigator.onLine ? 'Reconnecting…' : 'Offline, will sync', 'error');
    opts.onStatus?.(pending() ? 'Saving…' : 'Saved');
  }

  async function post(name, body, init = {}) {
    return fetch(opts.actionUrl(name), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init });
  }

  async function connect() {
    if (destroyed || unavailable) return;
    clearTimeout(retryTimer);
    const params = new URLSearchParams({ client: clientID });
    if (epoch && view) {
      params.set('epoch', epoch);
      params.set('version', String(serverVersion()));
    }
    controller = new AbortController();
    let res;
    try {
      res = await fetch(opts.streamUrl(params), { signal: controller.signal, cache: 'no-store', headers: { accept: 'text/event-stream' } });
    } catch {
      return retry();
    }
    if (!res.ok) {
      if (res.status === 404 && everConnected) return gone();
      // Before ever connecting, a refusal means live editing isn't on offer here; after, it's a blip.
      if (!everConnected && res.status >= 400 && res.status < 500) {
        console.warn(`[live] not available here (${res.status}); saving the usual way`);
        unavailable = true;
        return opts.onUnavailable?.(res.status);
      }
      return retry();
    }
    try {
      await read(res.body);
    } catch {}
    if (connected) {
      connected = false;
      status();
    }
    retry();
  }

  function retry() {
    if (destroyed || unavailable) return;
    connected = false;
    status();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(retries++, 5)));
  }

  async function read(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done || destroyed) return;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        handle(event, parsed);
      }
    }
  }

  function handle(event, d) {
    if (destroyed) return;
    if (event === 'hello') hello(d);
    else if (event === 'update') {
      receive(d.updates);
      serverDirty = d.dirty;
      // Out of step (shouldn't happen): start over from the server's text, keeping what's typed.
      if (serverVersion() !== d.version) {
        epoch = null;
        controller?.abort();
        return;
      }
      schedulePush(0);
      schedulePresence();
      status();
      wake();
    } else if (event === 'presence') showPeople(d);
    else if (event === 'saved') {
      hash = d.hash;
      serverDirty = d.dirty;
      opts.onSaved?.(hash);
      status();
      wake();
    } else if (event === 'status') opts.onStatus?.(d.error, 'error');
    else if (event === 'moved') opts.onMoved?.(d.path);
    else if (event === 'readonly') readOnly();
    else if (event === 'gone') gone();
    else if (event === 'refused') {
      console.warn(`[live] refused: ${d.error}; saving the usual way`);
      unavailable = true;
      opts.onUnavailable?.(d.status);
    }
  }

  function hello(d) {
    conn = d.conn;
    serverDirty = d.dirty;
    const lastHash = hash;
    hash = d.hash;
    let rejoining = false;
    if (d.type === 'resume') {
      receive(d.updates);
    } else {
      // A fresh start: the editor becomes the server's text. What's typed here and not yet in (typing before the
      // first connection, or while the server was away) is sent back afterwards to be merged.
      const local = view.state.doc.toString();
      const mine = unconfirmed();
      const keep = !discard && (everConnected ? mine.length > 0 : local !== opts.base.text) ? local : null;
      const baseHash = everConnected ? lastHash : opts.base.hash;
      discard = false;
      view.dispatch(
        receiveUpdates(view.state, [
          // Ours, as if confirmed, so they're no longer waiting to go; then the step to the server's text.
          ...mine.map(() => ({ clientID, changes: ChangeSet.empty(0) })),
          { clientID: '~sync', changes: replaceDiff(local, d.text) },
        ]),
      );
      offset = d.version - getSyncedVersion(view.state);
      if (keep !== null && keep !== d.text) {
        rejoining = true;
        void rejoin(baseHash, keep);
      }
    }
    epoch = d.epoch;
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      lastPresence = '';
      void sendPresence();
    }, 25_000);
    connected = true;
    everConnected = true;
    retries = 0;
    if (!rejoining && !pending()) opts.onSaved?.(hash);
    schedulePush(0);
    schedulePresence();
    status();
    wake();
  }

  function receive(updates) {
    if (!updates.length) return;
    view.dispatch(receiveUpdates(view.state, updates.map((u) => ({ clientID: u.clientID, changes: ChangeSet.fromJSON(u.changes) }))));
  }

  async function rejoin(baseHash, text) {
    try {
      const res = await post('rejoin', { conn, base_hash: baseHash, text });
      if (res.status === 409 || res.status === 400 || res.status === 413) opts.onConflict?.(text);
    } catch {
      opts.onConflict?.(text);
    }
  }

  function schedulePush(ms = PUSH_DELAY) {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void push();
    }, ms);
  }

  async function push() {
    if (!connected || pushing || destroyed) return;
    const updates = unconfirmed();
    if (!updates.length) return;
    pushing = (async () => {
      const version = serverVersion();
      try {
        const res = await post('push', {
          conn,
          version,
          updates: updates.map((u) => ({ clientID: u.clientID, changes: u.changes.toJSON() })),
          ...(keepVersion && { keep_version: true }),
        });
        if (res.ok) {
          keepVersion = false;
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          // The connection is gone, or the server can't rebase from so far back: reconnect.
          controller?.abort();
        } else if (res.status === 400 || res.status === 403 || res.status === 413) {
          // Refused (an image added through a share link, say): undo it by starting over from the server's text.
          holdStatus = Date.now() + 5000;
          setTimeout(status, 5100);
          opts.onRefused?.(body.error ?? 'That change wasn’t allowed');
          discard = true;
          epoch = null;
          controller?.abort();
        } else setTimeout(() => schedulePush(0), 2000);
      } catch {
        setTimeout(() => schedulePush(0), 2000);
      }
    })();
    await pushing;
    pushing = null;
  }

  function schedulePresence() {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      void sendPresence();
    }, PRESENCE_DELAY);
  }

  async function sendPresence() {
    if (!connected || destroyed) return;
    // Positions only make sense to the server once our changes are in; this runs again when they are.
    if (unconfirmed().length) return;
    // Where they last were, focused or not: with two windows side by side, only one ever has focus.
    const { anchor, head } = view.state.selection.main;
    const cursor = { anchor, head };
    const key = JSON.stringify([serverVersion(), cursor]);
    if (key === lastPresence) return;
    lastPresence = key;
    try {
      await post('presence', { conn, version: serverVersion(), cursor });
    } catch {}
  }

  function showPeople(d) {
    // The server's positions are for its version; ours may have changes it hasn't confirmed yet on top.
    const mine = unconfirmed();
    const mapPos = (pos, assoc) => mine.reduce((p, u) => u.changes.mapPos(Math.min(p, u.changes.length), assoc), pos);
    const len = view.state.doc.length;
    const people = d.people.map((p) => ({
      ...p,
      cursor: p.cursor && { anchor: Math.min(mapPos(p.cursor.anchor, -1), len), head: Math.min(mapPos(p.cursor.head, 1), len) },
    }));
    view.dispatch({ effects: setPeople.of(people.filter((p) => !p.me)) });
    opts.onPeople?.(people);
  }

  function readOnly() {
    view?.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)]) });
    opts.onReadOnly?.();
  }

  function gone() {
    connected = false;
    destroy();
    opts.onGone?.();
  }

  function destroy() {
    destroyed = true;
    clearTimeout(retryTimer);
    clearTimeout(pushTimer);
    clearTimeout(presenceTimer);
    clearInterval(heartbeat);
    controller?.abort();
    wake();
  }

  let started = opts.start !== false;
  const plugin = ViewPlugin.define((v) => {
    view = v;
    if (started) queueMicrotask(connect);
    return {
      update(u) {
        // Remote changes leave nothing to send, so push() has nothing to do for them.
        if (u.docChanged) schedulePush();
        if (u.docChanged || u.selectionSet) schedulePresence();
        if (u.docChanged) status();
      },
      destroy,
    };
  });

  return {
    extension: [collab({ clientID, startVersion: 0 }), peopleField, remoteSelections, remoteCarets, editable.of([]), plugin],
    /** Connects now (with `start: false`): `base` is the file as it was just saved. */
    start(base) {
      if (started) return;
      started = true;
      opts.base = { ...base, text: normalizeLineEndings(base.text) };
      hash = base.hash;
      if (view) void connect();
    },
    /** Started, and in an editor (whose plugin is what connects). */
    get started() {
      return started && !!view;
    },
    get connected() {
      return connected;
    },
    get unavailable() {
      return unavailable;
    },
    get hash() {
      return hash;
    },
    pending,
    /** The next write keeps what it replaces as a version (restoring an old version). */
    keepVersion() {
      keepVersion = true;
    },
    /** Sends what's typed and has the server write the file. True once nothing is left unsaved. */
    async flush(timeoutMs = 5000) {
      if (!connected) return !pending();
      const end = Date.now() + timeoutMs;
      while (unconfirmed().length && connected && Date.now() < end) {
        await push();
        if (!unconfirmed().length) break;
        // Confirmed when they come back down the stream.
        await new Promise((r) => {
          const done = () => {
            waiters.delete(done);
            r();
          };
          waiters.add(done);
          setTimeout(done, 200);
        });
      }
      if (!connected) return !pending();
      try {
        const res = await post('save', { conn });
        if (res.ok) {
          const body = await res.json();
          hash = body.hash;
          serverDirty = body.dirty;
          status();
        }
      } catch {}
      return !pending();
    },
    /** The page is going away: send what's unconfirmed with a request that outlives it. The server writes it. */
    sendNow() {
      const updates = unconfirmed();
      if (!connected || !updates.length) return;
      post(
        'push',
        { conn, version: serverVersion(), updates: updates.map((u) => ({ clientID: u.clientID, changes: u.changes.toJSON() })) },
        { keepalive: true },
      ).catch(() => {});
    },
    destroy,
  };
}
