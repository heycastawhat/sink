import type { Server, ServerWebSocket } from "bun";
import diff from "fast-diff";
import type { Context } from "hono";
import * as Y from "yjs";
import { cleanPath, isBoard, MAX_NOTE_BYTES, splitFrontmatter, VaultError, type Note, type Vault, type VaultEvent } from "./notes";

/**
 * Live co-editing: everyone with a note open (signed in, or through an editable share link) edits one copy of it held
 * here, and sees the others' typing and cursors as it happens.
 *
 * Each open note is a Room holding a Yjs document (a CRDT: concurrent edits merge the same way everywhere, whatever
 * order they arrive in). Clients keep their own copy and swap updates with the room over a WebSocket, so a client that
 * was offline or reconnecting just syncs what each side is missing; nothing is rebased or replayed by hand.
 *
 * The file is still the truth. The room writes it a moment after typing stops, with the hash it last wrote (so the
 * usual conflict check holds). A change made elsewhere (Obsidian, the phone, an assistant, a scan) is merged into the
 * room as an edit made on top of the file the room last wrote, so it lands among the room's own changes rather than
 * over them. The room's state is kept in the database along with the hash of the file it matches: after a restart,
 * clients still holding the old document sync into it instead of starting over (which would duplicate their text).
 *
 * Share links see the body only (frontmatter can hold things not meant for readers), so they get a second document
 * holding just the body, kept in step with the first both ways. A share client's change is checked like an editable
 * share's PUT: it can't add properties or embeds, and one that tries is undone.
 */

/** How long typing has to pause before the room writes the file. */
const SAVE_DELAY_MS = 1000;
/** How long a room with nobody in it stays open, so a quick reload picks up where it was. */
const IDLE_CLOSE_MS = 30_000;
const MAX_PEERS = 50;
/** Messages a connection may send per 10s (typing fast is a few dozen a second at most). */
const MAX_MESSAGES = 1500;
/** Cursor colours, in the order people join. Readable on light and dark backgrounds. */
const COLORS = ["#e8710a", "#1a73e8", "#d01884", "#188038", "#9334e6", "#c5221f", "#007b83", "#b06000"];

/** Binary messages: a type byte, then a Yjs state vector (step 1) or update (step 2, update). */
export const SYNC_STEP1 = 0;
export const SYNC_STEP2 = 1;
export const UPDATE = 2;
const ACK = JSON.stringify({ t: "ack" });

/** Where a change came from, besides a client: the file changed elsewhere, the other view's document, or an undo of a refused change. */
const FILE = Symbol("file");
const BRIDGE = Symbol("bridge");
const REVERT = Symbol("revert");

export type LiveView = "full" | "body";
type Cursor = { anchor: unknown; head: unknown };
type Delta = ({ retain: number } | { insert: string } | { delete: number })[];

export type Peer = {
  conn: string;
  /** Who it is, for the version history: `owner:<subject>` or `share:<id>:<name>`. */
  principal: string;
  name: string;
  color: string;
  view: LiveView;
  editor: boolean;
  /** Yjs relative positions in the peer's own document. */
  cursor: Cursor | null;
  /** Checks a share client's change: an error message, or null if it may go in. */
  allow?: (before: string, after: string) => string | null;
  shareId?: string;
  onEdit?: () => void;
  budget: { start: number; count: number };
  send: (data: string | Uint8Array) => void;
  close: () => void;
};
export type PeerInit = Omit<Peer, "conn" | "color" | "cursor" | "budget">;

export class LiveError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** The editor's documents always use \n; so does the room, and so do its writes. */
const normalize = (s: string) => s.replace(/\r\n?/g, "\n");
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const textOf = (doc: Y.Doc) => doc.getText("t");
const frame = (type: number, payload: Uint8Array) => {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
};

/** Where the body starts: the length of the frontmatter block, if there is one. */
export function frontmatterLength(s: string): number {
  return s.length - splitFrontmatter(s).body.length;
}

/** The steps that turn `a` into `b`, touching only what differs (a character diff, so edits around it survive). */
export function diffDelta(a: string, b: string): Delta {
  return diff(a, b).map(([op, text]) => (op === diff.EQUAL ? { retain: text.length } : op === diff.DELETE ? { delete: text.length } : { insert: text }));
}

/** `delta` moved `by` characters along (its leading retain grown or shrunk). */
function shiftDelta(delta: Delta, by: number): Delta {
  const lead = delta[0] && "retain" in delta[0] ? delta[0].retain : 0;
  const rest = lead ? delta.slice(1) : delta;
  return lead + by > 0 ? [{ retain: lead + by }, ...rest] : rest;
}
const firstChange = (delta: Delta) => (delta[0] && "retain" in delta[0] ? delta[0].retain : 0);
const isPeer = (origin: unknown): origin is Peer => typeof origin === "object" && origin !== null && "conn" in origin;

export class Room {
  readonly doc: Y.Doc;
  private text: Y.Text;
  private str: string;
  /** The body-only document for share links, made when the first one joins. */
  private body: Y.Doc | null = null;
  private bodyStr = "";
  /** The file as the room last wrote or read it, and the document's state at that moment. */
  private savedText: string;
  savedHash: string;
  private savedState: Uint8Array;
  /** Changes made here that the file doesn't have yet. */
  dirty = false;
  private saving: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  /** An outside change turned up while a write was out: look at the file again once it's done. */
  private recheck = false;
  /** Who changed the note since the last write, and who did before: someone new means the old text is kept as a version. */
  private editors = new Set<string>();
  private lastEditors = new Set<string>();
  private keepVersion = false;
  /** Whose change a bridged one from the body document is. */
  private editingAs: string | null = null;
  readonly peers = new Map<string, Peer>();
  private colorIndex = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  closed = false;

  constructor(
    private hub: LiveHub,
    public path: string,
    note: Note,
    stored: { guid: string; state: Uint8Array; hash: string } | null,
  ) {
    const content = normalize(note.content);
    this.doc = new Y.Doc(stored ? { guid: stored.guid } : {});
    this.text = textOf(this.doc);
    if (stored) Y.applyUpdate(this.doc, stored.state, FILE);
    // Changed since the room last saw it (or never opened before): the file's text, as an edit on what was there.
    const had = this.text.toString();
    if (had !== content) this.doc.transact(() => this.text.applyDelta(diffDelta(had, content)), FILE);
    this.str = this.savedText = content;
    this.savedHash = note.hash;
    this.savedState = Y.encodeStateAsUpdate(this.doc);
    if (stored?.hash !== note.hash || had !== content) hub.store(path, this.doc.guid, this.savedState, note.hash);
    this.text.observe((e, tr) => this.fullChanged(e.delta as Delta, tr.origin));
    this.doc.on("update", (update: Uint8Array, origin: unknown) => this.relay("full", update, origin));
  }

  private docOf(view: LiveView): Y.Doc {
    if (view === "full") return this.doc;
    if (this.body) return this.body;
    const body = (this.body = new Y.Doc());
    this.bodyStr = this.str.slice(frontmatterLength(this.str));
    body.transact(() => textOf(body).insert(0, this.bodyStr), BRIDGE);
    textOf(body).observe((e, tr) => this.bodyChanged(e.delta as Delta, tr.origin));
    body.on("update", (update: Uint8Array, origin: unknown) => this.relay("body", update, origin));
    return body;
  }

  join(init: PeerInit): Peer {
    if (this.closed) throw new LiveError(503, "the note closed, try again");
    if (this.peers.size >= MAX_PEERS) throw new LiveError(503, "too many people in this note");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const peer: Peer = { ...init, conn: random(), color: COLORS[this.colorIndex++ % COLORS.length]!, cursor: null, budget: { start: Date.now(), count: 0 } };
    this.peers.set(peer.conn, peer);
    // Who comes and goes, so "I can't see them" can be answered from the logs. Names only, never the text.
    console.log(`[live] ${peer.name} (${peer.view === "full" ? "signed in" : peer.editor ? "share link, editing" : "share link, reading"}) joined a note; ${this.peers.size} there`);
    const doc = this.docOf(peer.view);
    peer.send(JSON.stringify({ t: "hello", guid: doc.guid, conn: peer.conn, hash: this.savedHash, dirty: this.dirty, color: peer.color, editor: peer.editor }));
    peer.send(frame(SYNC_STEP1, Y.encodeStateVector(doc)));
    this.sendPresence();
    return peer;
  }

  leave(conn: string) {
    const peer = this.peers.get(conn);
    if (!peer) return;
    this.peers.delete(conn);
    console.log(`[live] ${peer.name} left a note; ${this.peers.size} there`);
    this.sendPresence();
    if (this.peers.size) return;
    void this.save();
    this.idleTimer = setTimeout(() => void this.closeIfIdle(), IDLE_CLOSE_MS);
  }

  private async closeIfIdle() {
    if (this.peers.size || this.closed) return;
    await this.save();
    if (this.peers.size) return;
    // Still can't write it (storage down): stay open, holding the text, and try again later.
    if (this.dirty) this.idleTimer = setTimeout(() => void this.closeIfIdle(), IDLE_CLOSE_MS);
    else this.close();
  }

  /** A message from a client: Yjs sync (binary) or a JSON control message. */
  receive(peer: Peer, data: string | Uint8Array) {
    if (!this.peers.has(peer.conn)) return;
    const now = Date.now();
    if (now - peer.budget.start > 10_000) peer.budget = { start: now, count: 0 };
    if (++peer.budget.count > MAX_MESSAGES) return peer.close();
    if (typeof data === "string") return this.control(peer, data);
    const doc = this.docOf(peer.view);
    try {
      if (data[0] === SYNC_STEP1) peer.send(frame(SYNC_STEP2, Y.encodeStateAsUpdate(doc, data.subarray(1))));
      else if (data[0] === SYNC_STEP2 || data[0] === UPDATE) {
        // A reader's copy has nothing of its own to give; anything it sends is ignored.
        if (peer.editor) Y.applyUpdate(doc, data.subarray(1), peer);
        peer.send(ACK);
      }
    } catch {
      peer.send(JSON.stringify({ t: "status", error: "couldn't read that change" }));
      peer.close();
    }
  }

  private control(peer: Peer, raw: string) {
    let msg: { t?: unknown; anchor?: unknown; head?: unknown };
    try {
      msg = raw.length < 4096 ? JSON.parse(raw) : {};
    } catch {
      return;
    }
    if (msg.t === "cursor") {
      peer.cursor = msg.anchor && msg.head && typeof msg.anchor === "object" && typeof msg.head === "object" ? { anchor: msg.anchor, head: msg.head } : null;
      this.sendPresence();
    } else if (msg.t === "save") {
      // "Save now" (before leaving the note, changing its properties, or reading its history).
      void this.save().then(() => peer.send(JSON.stringify({ t: "saved", hash: this.savedHash, dirty: this.dirty })));
    } else if (msg.t === "keep" && peer.editor) {
      // The next write keeps what it replaces as a version (restoring an old one).
      this.keepVersion = true;
    }
  }

  /** The note changed: tell the body document, and mark it to be written. */
  private fullChanged(delta: Delta, origin: unknown) {
    const before = this.str;
    this.str = this.text.toString();
    if (origin === REVERT) return;
    if (isPeer(origin) && this.str.length > MAX_NOTE_BYTES) return this.refuse(origin, this.doc, this.str, before, "note too large");
    if (this.body && origin !== BRIDGE) {
      const fmBefore = frontmatterLength(before);
      const fmAfter = frontmatterLength(this.str);
      // Only the body changed: the same steps, moved past the frontmatter. Otherwise the body's difference.
      const bodyDelta =
        fmBefore === fmAfter && firstChange(delta) >= fmBefore ? shiftDelta(delta, -fmBefore) : diffDelta(before.slice(fmBefore), this.str.slice(fmAfter));
      const body = this.body;
      body.transact(() => textOf(body).applyDelta(bodyDelta), BRIDGE);
    }
    const who = origin === BRIDGE ? this.editingAs : isPeer(origin) ? origin.principal : null;
    if (!who) return;
    this.editors.add(who);
    if (!this.dirty) {
      this.dirty = true;
      for (const peer of this.peers.values()) peer.send(JSON.stringify({ t: "dirty" }));
    }
    this.scheduleSave(SAVE_DELAY_MS);
  }

  /** A share client changed the body: checked, then made in the note. */
  private bodyChanged(delta: Delta, origin: unknown) {
    const before = this.bodyStr;
    this.bodyStr = textOf(this.body!).toString();
    if (!isPeer(origin)) return;
    const fm = frontmatterLength(this.str);
    const full = this.str.slice(0, fm) + this.bodyStr;
    const refused = full.length > MAX_NOTE_BYTES ? "note too large" : (origin.allow?.(this.str, full) ?? null);
    if (refused) return this.refuse(origin, this.body!, this.bodyStr, before, refused);
    this.editingAs = origin.principal;
    this.doc.transact(() => this.text.applyDelta(shiftDelta(delta, fm)), BRIDGE);
    this.editingAs = null;
    origin.onEdit?.();
  }

  /** Undoes a change that isn't allowed, for everyone (as soon as the change that made it has finished). */
  private refuse(peer: Peer, doc: Y.Doc, now: string, before: string, error: string) {
    peer.send(JSON.stringify({ t: "refused", error }));
    const undo = diffDelta(now, before);
    queueMicrotask(() => doc.transact(() => textOf(doc).applyDelta(undo), REVERT));
  }

  /** A change to one view's document, to everyone else on it. */
  private relay(view: LiveView, update: Uint8Array, origin: unknown) {
    const msg = frame(UPDATE, update);
    for (const peer of this.peers.values()) if (peer.view === view && peer !== origin) peer.send(msg);
  }

  /** Someone's cursor as a position in `view`'s document. */
  private cursorFor(p: Peer, view: LiveView): Cursor | null {
    if (!p.cursor || p.view === view) return p.cursor;
    const from = this.docOf(p.view);
    const to = textOf(this.docOf(view));
    const fm = frontmatterLength(this.str);
    const convert = (rel: unknown) => {
      try {
        const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel), from);
        if (!abs) return null;
        const index = p.view === "full" ? abs.index - fm : abs.index + fm;
        return index < 0 ? null : Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(to, index));
      } catch {
        return null;
      }
    };
    const anchor = convert(p.cursor.anchor);
    const head = convert(p.cursor.head);
    return anchor && head ? { anchor, head } : null;
  }

  /** Who is here and where their cursors are, to everyone (each in their own view). */
  sendPresence() {
    for (const peer of this.peers.values()) {
      const people = [...this.peers.values()]
        .filter((p) => p.editor || p.view === "full")
        .map((p) => ({ id: p.conn, name: p.name, color: p.color, cursor: this.cursorFor(p, peer.view), me: p === peer }));
      peer.send(JSON.stringify({ t: "presence", people }));
    }
  }

  private scheduleSave(ms: number) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), ms);
  }

  /** Writes the file now if it's behind. Resolves once it's written (or couldn't be). */
  async save(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.saving) {
      await this.saving;
      if (this.dirty && !this.closed) return this.save();
      return;
    }
    if (!this.dirty || this.closed) return;
    this.saving = this.write().finally(() => (this.saving = null));
    await this.saving;
    if (this.recheck) {
      this.recheck = false;
      await this.checkFile();
    }
  }

  private async write() {
    const text = this.str;
    const state = Y.encodeStateAsUpdate(this.doc);
    if (text === this.savedText) {
      this.dirty = false;
      this.savedState = state;
      return this.sendSaved();
    }
    // Someone new editing (a share link's visitor, or a second person after the first) keeps what was there as a
    // version, so the owner can undo it. One person typing on their own gets the usual one version per sitting.
    const fresh = [...this.editors].some((e) => !this.lastEditors.has(e) && (this.lastEditors.size > 0 || e.startsWith("share:")));
    try {
      const saved = await this.hub.vault.write(this.path, text, this.savedHash, { keepVersion: this.keepVersion || fresh });
      this.savedText = text;
      this.savedHash = saved.hash;
      this.savedState = state;
      this.hub.store(this.path, this.doc.guid, state, saved.hash);
      this.dirty = this.str !== text;
      if (this.editors.size) this.lastEditors = this.editors;
      this.editors = new Set();
      this.keepVersion = false;
      this.failures = 0;
      this.sendSaved();
    } catch (err) {
      if (!(err instanceof VaultError)) throw err;
      if (err.status === 409 && err.current && "content" in err.current) {
        // Changed elsewhere since the room last wrote it: take that in, then write again on top of it.
        this.absorb(err.current);
        this.scheduleSave(0);
      } else if (err.status === 404 || err.status === 409) this.gone();
      else {
        this.failures++;
        for (const peer of this.peers.values()) peer.send(JSON.stringify({ t: "status", error: "Can't save, retrying" }));
        this.scheduleSave(Math.min(30_000, 2000 * 2 ** Math.min(this.failures, 4)));
      }
    }
  }

  private sendSaved() {
    const msg = JSON.stringify({ t: "saved", hash: this.savedHash, dirty: this.dirty });
    for (const peer of this.peers.values()) peer.send(msg);
  }

  /**
   * The file as it is now, merged in. What changed since the room's last write is made as an edit on a copy of the
   * document as it was then, and that edit merged into the room: Yjs puts it among everything typed since.
   */
  private absorb(current: { content: string; hash: string }) {
    const theirs = normalize(current.content);
    if (theirs !== this.savedText) {
      const fork = new Y.Doc({ guid: this.doc.guid });
      Y.applyUpdate(fork, this.savedState);
      const before = Y.encodeStateVector(fork);
      fork.transact(() => textOf(fork).applyDelta(diffDelta(this.savedText, theirs)));
      const update = Y.encodeStateAsUpdate(fork, before);
      this.savedState = Y.encodeStateAsUpdate(fork);
      fork.destroy();
      Y.applyUpdate(this.doc, update, FILE);
    }
    this.savedText = theirs;
    this.savedHash = current.hash;
    this.hub.store(this.path, this.doc.guid, this.savedState, current.hash);
    this.dirty = this.str !== theirs;
    if (this.dirty) this.scheduleSave(SAVE_DELAY_MS);
    this.sendSaved();
  }

  /** After an outside change to the file (a scan, another device, an assistant): merge it in if it's new. */
  async checkFile() {
    if (this.closed) return;
    if (this.saving) {
      this.recheck = true;
      return;
    }
    const before = this.savedHash;
    let note: Note;
    try {
      note = await this.hub.vault.read(this.path);
    } catch (err) {
      if (err instanceof VaultError && err.status === 404) return this.gone();
      return;
    }
    // A write of ours started or landed meanwhile: what was read may be older than it.
    if (this.saving || this.savedHash !== before) {
      this.recheck = true;
      if (!this.saving) void this.save().then(() => this.checkFile());
      return;
    }
    if (note.hash !== this.savedHash) this.absorb(note);
  }

  moved(to: string) {
    this.path = to;
    for (const peer of this.peers.values()) if (peer.view === "full") peer.send(JSON.stringify({ t: "moved", path: to }));
  }

  /** Deleted (or moved away, or no longer shared): everyone's told, and the room closes. */
  gone() {
    for (const peer of this.peers.values()) {
      peer.send(JSON.stringify({ t: "gone" }));
      peer.close();
    }
    this.close();
  }

  /** A share link's editing was turned off, or the link stopped. */
  shareChanged(shareId: string, editable: boolean | null) {
    for (const peer of [...this.peers.values()]) {
      if (peer.shareId !== shareId) continue;
      if (editable === null) {
        peer.send(JSON.stringify({ t: "gone" }));
        peer.close();
        this.leave(peer.conn);
      } else if (!editable && peer.editor) {
        peer.editor = false;
        peer.send(JSON.stringify({ t: "readonly" }));
        this.sendPresence();
      }
    }
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.peers.clear();
    this.hub.forget(this);
    this.doc.destroy();
    this.body?.destroy();
  }
}

/** The open rooms of one vault, and the stored state of every note that has been open. */
export class LiveHub {
  private rooms = new Map<string, Room>();
  private opening = new Map<string, Promise<Room>>();

  constructor(readonly vault: Vault) {
    vault.events.on("event", (e: VaultEvent) => this.onEvent(e));
  }

  private onEvent(e: VaultEvent) {
    if (e.type === "note.moved") {
      this.vault.db.query("DELETE FROM live_docs WHERE path = ?").run(e.path);
      this.vault.db.query("UPDATE live_docs SET path = ? WHERE path = ?").run(e.path, e.from);
      const room = this.rooms.get(e.from);
      if (!room) return;
      this.rooms.delete(e.from);
      this.rooms.get(e.path)?.gone();
      this.rooms.set(e.path, room);
      room.moved(e.path);
      return;
    }
    if (e.type === "note.deleted") this.vault.db.query("DELETE FROM live_docs WHERE path = ?").run(e.path);
    const room = this.rooms.get(e.path);
    if (!room) return;
    if (e.type === "note.deleted") room.gone();
    else if (e.type === "note.updated" || e.type === "note.created") void room.checkFile();
  }

  store(path: string, guid: string, state: Uint8Array, hash: string) {
    this.vault.db
      .query("INSERT OR REPLACE INTO live_docs (path, guid, state, hash, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(path, guid, state, hash, Date.now());
  }

  async open(path: string): Promise<Room> {
    path = cleanPath(path, "note");
    if (isBoard(path)) throw new LiveError(400, "boards aren't edited live");
    const open = this.rooms.get(path);
    if (open) return open;
    let opening = this.opening.get(path);
    if (!opening) {
      opening = this.vault
        .read(path)
        .then((note) => {
          const stored = this.vault.db
            .query<{ guid: string; state: Uint8Array; hash: string }, [string]>("SELECT guid, state, hash FROM live_docs WHERE path = ?")
            .get(path);
          const room = this.rooms.get(path) ?? new Room(this, path, note, stored);
          this.rooms.set(path, room);
          return room;
        })
        .finally(() => this.opening.delete(path));
      this.opening.set(path, opening);
    }
    return opening;
  }

  room(path: string) {
    return this.rooms.get(path);
  }

  forget(room: Room) {
    if (this.rooms.get(room.path) === room) this.rooms.delete(room.path);
  }

  /** Writes every room that's behind (shutting down, tests). */
  async flush() {
    await Promise.all([...this.rooms.values()].map((r) => r.save()));
  }
}

const hubs = new WeakMap<Vault, LiveHub>();
export function liveFor(vault: Vault): LiveHub {
  let hub = hubs.get(vault);
  if (!hub) hubs.set(vault, (hub = new LiveHub(vault)));
  return hub;
}

// ---- WebSockets: Bun.serve's `websocket` handlers hand each socket to the room it was opened for

type SocketData = { open(ws: ServerWebSocket<SocketData>): void; message(data: string | Uint8Array): void; close(): void };
export const liveSocket = {
  open: (ws: ServerWebSocket<SocketData>) => ws.data.open(ws),
  message: (ws: ServerWebSocket<SocketData>, data: string | Buffer) => ws.data.message(data),
  close: (ws: ServerWebSocket<SocketData>) => ws.data.close(),
};

/**
 * Upgrades the request to a live socket in `room`. A plain GET (no upgrade) gets 426: the client asks that way after a
 * socket fails, to tell "live editing is here, the connection dropped" from a refusal.
 */
export function liveSocketResponse(c: Context, room: Room, init: Omit<PeerInit, "send" | "close">) {
  const server = c.env as Server<SocketData> | undefined;
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket" || typeof server?.upgrade !== "function")
    return c.json({ error: "live editing needs a WebSocket" }, 426);
  let peer: Peer | null = null;
  const data: SocketData = {
    open(ws) {
      try {
        peer = room.join({ ...init, send: (d) => void ws.send(d), close: () => ws.close() });
      } catch (err) {
        if (!(err instanceof LiveError)) throw err;
        ws.send(JSON.stringify({ t: "refused", error: err.message, status: err.status }));
        ws.close();
      }
    },
    message: (d) => peer && room.receive(peer, d),
    close() {
      if (peer) room.leave(peer.conn);
      peer = null;
    },
  };
  return server.upgrade(c.req.raw, { data }) ? new Response(null) : c.json({ error: "couldn't upgrade" }, 400);
}

/** Signed in: `/api/live?path=…`. Full-scope tokens only (see app.ts). */
export async function signedInSocket(c: Context, vault: Vault, subject: string, name: string, publicUrls: string[]) {
  // The browser sends the session cookie with a socket from any page, so it must come from Sink's own.
  const origin = c.req.header("origin");
  if (!c.req.header("authorization") && !(origin && publicUrls.includes(origin))) return c.json({ error: "cross-origin request refused" }, 403);
  let room: Room;
  try {
    room = await liveFor(vault).open(c.req.query("path") ?? "");
  } catch (err) {
    if (err instanceof LiveError || err instanceof VaultError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  return liveSocketResponse(c, room, { principal: `owner:${subject}`, name, view: "full", editor: true });
}
