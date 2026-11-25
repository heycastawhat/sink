// Live co-editing: everyone with a note open edits the same document and sees the others' typing and cursors as it
// happens (server/src/live.ts). The document is Yjs, a CRDT: this tab keeps its own copy, the editor and the copy are
// kept in step, and the copy swaps updates with the server's over a WebSocket. Edits made while the connection is down
// stay in the copy and sync when it's back, merged with everyone else's however they interleave. The server writes
// the file; this only talks to it.

import { Annotation, ChangeSet, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView, layer, RectangleMarker, ViewPlugin } from '@codemirror/view';
import diff from 'fast-diff';
import * as Y from 'yjs';
import { normalizeLineEndings } from './util.js';

const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const UPDATE = 2;
const PRESENCE_DELAY = 100;
/** Changes from the server, and the editor's own going the other way. */
const REMOTE = Symbol('remote');
const LOCAL = Symbol('local');
const fromDoc = Annotation.define();

const frame = (type, payload) => {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
};

/** `a` → `b` as changes to just the parts that differ. */
function diffChanges(a, b) {
  const specs = [];
  let pos = 0;
  for (const [op, text] of diff(a, b)) {
    if (op === diff.EQUAL) pos += text.length;
    else if (op === diff.DELETE) {
      specs.push({ from: pos, to: pos + text.length });
      pos += text.length;
    } else specs.push({ from: pos, insert: text });
  }
  return ChangeSet.of(specs, a.length);
}

// ---- other people's cursors

const setPeople = StateEffect.define();
const peopleField = StateField.define({
  create: () => [],
  update: (people, tr) => tr.effects.find((e) => e.is(setPeople))?.value ?? people,
});

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
 * - url(): the socket's path (`/api/live?path=…`)
 * - socket(url): makes the socket, if not a browser WebSocket (the Android app's goes through its bridge). Something
 *   WebSocket-like: readyState, send, close, onmessage, onclose; on close, `status` is the HTTP status if it never opened.
 * - base: { text, hash }: what the editor was loaded with, so typing before the socket is up isn't lost
 * - onStatus(text, kind), onPeople(people), onSaved(hash), onGone(), onMoved(path), onReadOnly(), onRefused(message)
 * - onUnavailable(): live editing can't be had here (an older server); the caller saves the old way
 * - start: false to wait for `start(base)` (a new note has no file to edit together until its first save)
 */
export function liveSession(opts) {
  opts.base = { ...opts.base, text: normalizeLineEndings(opts.base.text) };
  const editable = new Compartment();
  let view = null;
  let doc = null;
  let ws = null;
  let hash = opts.base.hash;
  let serverDirty = false;
  let connected = false;
  let everConnected = false;
  let destroyed = false;
  let unavailable = false;
  let retries = 0;
  let retryTimer = null;
  let presenceTimer = null;
  let heartbeat = null;
  let keepNext = false;
  let lastPresence = '';
  /** The editor and the document hold the same text (once the first sync has settled what that is). */
  let bound = false;
  /** On the first sync: the text the editor started from, so what was typed before it can be worked out and kept. */
  let base = opts.base.text;
  /** Our changes made and those the server has confirmed (in order: one ack per update it took). */
  let made = 0;
  let confirmed = 0;
  let inFlight = [];
  /** The text the server last wrote with nothing of ours outstanding: what a document it lost is rebuilt on. */
  let lastSaved = opts.base.text;
  let saves = 0;
  const waiters = new Set();

  const ytext = () => doc.getText('t');
  const unconfirmed = () => made > confirmed;
  const pending = () => unconfirmed() || serverDirty;
  const wake = () => {
    for (const w of [...waiters]) w();
  };
  const waitFor = (ok, ms) =>
    new Promise((resolve) => {
      const end = Date.now() + ms;
      const check = () => {
        if (ok() || destroyed || Date.now() > end) {
          waiters.delete(check);
          resolve();
        }
      };
      waiters.add(check);
      setTimeout(check, ms);
      check();
    });

  // A refusal's message stays up a while before "Saved" replaces it.
  let holdStatus = 0;
  function status() {
    if (Date.now() < holdStatus) return;
    if (!connected) return opts.onStatus?.(navigator.onLine ? 'Reconnecting…' : 'Offline, will sync', 'error');
    opts.onStatus?.(pending() ? 'Saving…' : 'Saved');
  }

  function send(data) {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(data);
    return true;
  }

  /** Sends one of our updates (or the batch of them the server lacks), counted until the server confirms it. */
  function sendChanges(type, update) {
    if (send(frame(type, update))) inFlight.push(made);
  }

  // The editor's changes into the document, and the document's (from the server) into the editor.
  function onDocChange(event, tr) {
    if (tr.origin === LOCAL || !bound || !view) return;
    const changes = [];
    let pos = 0;
    for (const d of event.delta) {
      if (d.insert != null) changes.push({ from: pos, insert: d.insert });
      else if (d.delete != null) {
        changes.push({ from: pos, to: pos + d.delete });
        pos += d.delete;
      } else pos += d.retain;
    }
    // Not undoable: Ctrl+Z undoes your own typing, never someone else's.
    view.dispatch({ changes, annotations: [fromDoc.of(true), Transaction.remote.of(true), Transaction.addToHistory.of(false)] });
  }
  function onUpdate(update, origin) {
    if (origin === REMOTE) return;
    made++;
    sendChanges(UPDATE, update);
    status();
  }
  function useDoc(next) {
    if (doc) {
      doc.off('update', onUpdate);
      doc.destroy();
    }
    doc = next;
    doc.on('update', onUpdate);
    ytext().observe(onDocChange);
  }
  useDoc(new Y.Doc());

  function editorToDoc(tr) {
    doc.transact(() => {
      let shift = 0;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const at = fromA + shift;
        if (toA > fromA) ytext().delete(at, toA - fromA);
        if (inserted.length) ytext().insert(at, inserted.toString());
        shift += inserted.length - (toA - fromA);
      });
    }, LOCAL);
  }

  /**
   * The first sync is in: the editor takes the document's text, then what was typed here before it (since `base`)
   * goes in on top, moved over whatever changed meanwhile.
   */
  function bind() {
    const server = ytext().toString();
    const local = view.state.doc.toString();
    if (local !== server) view.dispatch({ changes: diffChanges(local, server), annotations: [fromDoc.of(true), Transaction.addToHistory.of(false)] });
    bound = true;
    // (Already in: the same edit saved some other way, like the last save as the page closed.)
    if (local !== base && local !== server) {
      const mine = diffChanges(base, local).map(diffChanges(base, server), true);
      if (!mine.empty) view.dispatch({ changes: mine, annotations: Transaction.addToHistory.of(false) });
    }
    // Nothing of ours to send: what the editor holds is saved (a draft kept for it can go).
    if (!pending()) opts.onSaved?.(hash);
  }

  function socketUrl() {
    const url = new URL(opts.url(), location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  }

  function connect() {
    if (destroyed || unavailable || !view) return;
    clearTimeout(retryTimer);
    let greeted = false;
    const socket = (ws = opts.socket ? opts.socket(socketUrl()) : new WebSocket(socketUrl()));
    socket.binaryType = 'arraybuffer';
    socket.onmessage = (e) => {
      if (destroyed || ws !== socket) return;
      if (typeof e.data !== 'string') return receive(new Uint8Array(e.data));
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'hello') greeted = true;
      handle(msg);
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      connected = false;
      inFlight = [];
      clearInterval(heartbeat);
      if (destroyed || unavailable) return;
      status();
      if (greeted) return retry();
      // Never got in: was it refused, or did the connection fail? Asked over plain HTTP if the socket can't say
      // (426: live editing is here, the socket just failed).
      if (socket.status != null) return judge(socket.status);
      fetch(socketUrl().replace(/^ws/, 'http'), { cache: 'no-store' })
        .then((res) => judge(res.status))
        .catch(retry);
    };
  }

  function judge(code) {
    if (code === 404 && everConnected) return gone();
    if (code >= 400 && code < 500 && code !== 426 && code !== 429) return giveUp(code);
    retry();
  }

  function retry() {
    if (destroyed || unavailable) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(retries++, 5)));
  }

  function giveUp(code) {
    console.warn(`[live] not available here (${code}); saving the usual way`);
    unavailable = true;
    opts.onUnavailable?.(code);
  }

  function receive(data) {
    const type = data[0];
    const payload = data.subarray(1);
    if (type === SYNC_STEP1) return sendChanges(SYNC_STEP2, Y.encodeStateAsUpdate(doc, payload));
    Y.applyUpdate(doc, payload, REMOTE);
    if (type === SYNC_STEP2 && !bound) {
      bind();
      schedulePresence();
    }
    status();
    wake();
  }

  function handle(d) {
    if (d.t === 'hello') hello(d);
    else if (d.t === 'ack') {
      if (inFlight.length) confirmed = Math.max(confirmed, inFlight.shift());
      if (!unconfirmed()) schedulePresence();
      status();
      wake();
    } else if (d.t === 'presence') showPeople(d.people);
    else if (d.t === 'dirty') {
      serverDirty = true;
      status();
    } else if (d.t === 'saved') {
      hash = d.hash;
      serverDirty = d.dirty;
      saves++;
      if (bound && !d.dirty && !unconfirmed()) lastSaved = ytext().toString();
      opts.onSaved?.(hash);
      status();
      wake();
    } else if (d.t === 'status') opts.onStatus?.(d.error, 'error');
    else if (d.t === 'refused') {
      // The server undoes it for everyone; this just says why.
      if (!connected) return d.status === 503 ? undefined : giveUp(d.status);
      holdStatus = Date.now() + 5000;
      setTimeout(status, 5100);
      opts.onRefused?.(d.error ?? 'That change wasn’t allowed');
    } else if (d.t === 'moved') opts.onMoved?.(d.path);
    else if (d.t === 'readonly') readOnly();
    else if (d.t === 'gone') gone();
  }

  function hello(d) {
    serverDirty = d.dirty;
    hash = d.hash;
    if (d.guid !== doc.guid) {
      // Not the server's document: ours is from before it lost track (or this is the first connection). Start from
      // the server's, keeping what we have that it may not: the next sync puts it back on top (see bind).
      if (bound) base = lastSaved;
      bound = false;
      made = confirmed = 0;
      useDoc(new Y.Doc({ guid: d.guid }));
    }
    send(frame(SYNC_STEP1, Y.encodeStateVector(doc)));
    if (keepNext) send(JSON.stringify({ t: 'keep' }));
    keepNext = false;
    clearInterval(heartbeat);
    // Proxies close sockets that are quiet for a minute or two.
    heartbeat = setInterval(() => send('{"t":"ping"}'), 30_000);
    connected = true;
    everConnected = true;
    retries = 0;
    lastPresence = '';
    status();
  }

  function schedulePresence() {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      sendPresence();
    }, PRESENCE_DELAY);
  }

  function sendPresence() {
    if (!connected || !bound || destroyed) return;
    // Where they last were, focused or not: with two windows side by side, only one ever has focus.
    const { anchor, head } = view.state.selection.main;
    const rel = (i) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext(), i));
    const key = `${anchor}:${head}:${ytext().length}`;
    if (key === lastPresence) return;
    lastPresence = key;
    send(JSON.stringify({ t: 'cursor', anchor: rel(anchor), head: rel(head) }));
  }

  function showPeople(people) {
    view?.dispatch({ effects: setPeople.of(people.filter((p) => !p.me)) });
    opts.onPeople?.(people);
  }

  /** A remote position in the editor's text, or null if it isn't here yet (or the editor isn't in step). */
  const resolve = (rel, len) => {
    if (!bound || !rel) return null;
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel), doc);
      return abs ? Math.min(abs.index, len) : null;
    } catch {
      return null;
    }
  };
  const peopleChanged = (u) => u.docChanged || u.viewportChanged || u.geometryChanged || u.startState.field(peopleField) !== u.state.field(peopleField);
  const remoteSelections = layer({
    above: false,
    class: 'cm-remote-selections',
    update: peopleChanged,
    markers(v) {
      const out = [];
      const len = v.state.doc.length;
      for (const p of v.state.field(peopleField)) {
        const anchor = resolve(p.cursor?.anchor, len);
        const head = resolve(p.cursor?.head, len);
        if (anchor == null || head == null || anchor === head) continue;
        for (const rect of RectangleMarker.forRange(v, '', EditorSelection.range(anchor, head))) out.push(new SelectionMarker(p.color, rect));
      }
      return out;
    },
  });
  const remoteCarets = layer({
    above: true,
    class: 'cm-remote-carets',
    update: peopleChanged,
    markers(v) {
      const out = [];
      const len = v.state.doc.length;
      for (const p of v.state.field(peopleField)) {
        const head = resolve(p.cursor?.head, len);
        if (head == null) continue;
        const [rect] = RectangleMarker.forRange(v, '', EditorSelection.cursor(head));
        if (rect) out.push(new CaretMarker(p.name, p.color, rect.left, rect.top, rect.height));
      }
      return out;
    },
  });

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
    if (destroyed) return;
    destroyed = true;
    clearTimeout(retryTimer);
    clearTimeout(presenceTimer);
    clearInterval(heartbeat);
    ws?.close();
    ws = null;
    wake();
    doc.destroy();
  }

  let started = opts.start !== false;
  const plugin = ViewPlugin.define((v) => {
    view = v;
    if (started) queueMicrotask(connect);
    return {
      update(u) {
        if (bound && !destroyed) for (const tr of u.transactions) if (tr.docChanged && !tr.annotation(fromDoc)) editorToDoc(tr);
        if (u.docChanged || u.selectionSet) schedulePresence();
        // Typed before the first sync (or with no file yet): not in the document, but not saved either.
        if (u.docChanged && !bound) status();
      },
      destroy,
    };
  });

  return {
    extension: [peopleField, remoteSelections, remoteCarets, editable.of([]), plugin],
    /** Connects now (with `start: false`): `base` is the file as it was just saved. */
    start(next) {
      if (started) return;
      started = true;
      opts.base = { ...next, text: normalizeLineEndings(next.text) };
      base = lastSaved = opts.base.text;
      hash = next.hash;
      connect();
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
    /** In step with the server's document (since the first sync), so edits sync from here, not by saving. */
    get bound() {
      return bound && !destroyed;
    },
    pending: () => pending() || (!bound && view?.state.doc.toString() !== base),
    snapshot: () => bound && !destroyed ? { guid: doc.guid, update: Y.encodeStateAsUpdate(doc) } : null,
    /** The next write keeps what it replaces as a version (restoring an old version). */
    keepVersion() {
      if (!connected || !send(JSON.stringify({ t: 'keep' }))) keepNext = true;
    },
    /** Waits for what's typed to reach the server and has it write the file. True once nothing is left unsaved. */
    async flush(timeoutMs = 5000) {
      if (!connected) return !pending();
      const end = Date.now() + timeoutMs;
      await waitFor(() => bound && !unconfirmed(), timeoutMs);
      if (!connected || unconfirmed()) return false;
      const before = saves;
      send(JSON.stringify({ t: 'save' }));
      await waitFor(() => saves > before || !connected, Math.max(0, end - Date.now()));
      return !pending();
    },
    /** Updates go out as they're made, so there's nothing left to send when the page goes. */
    sendNow() {},
    destroy,
  };
}
