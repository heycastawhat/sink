import { ChangeSet, Text } from "@codemirror/state";
import { rebaseUpdates } from "@codemirror/collab";
import diff from "fast-diff";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AuthEnv } from "./auth";
import { cleanPath, isBoard, MAX_NOTE_BYTES, splitFrontmatter, VaultError, type Note, type Vault, type VaultEvent } from "./notes";

/**
 * Live co-editing: everyone with a note open (signed in, or through an editable share link) edits one copy of it held
 * here, and sees the others' typing and cursors as it happens.
 *
 * Each open note is a Room. Clients run CodeMirror's collab extension: they send their changes with the version they
 * were made against, the room rebases them over whatever landed first (`rebaseUpdates`), applies them, and sends every
 * change to everyone, the sender included (that's how a client knows its change went in). Changes are CodeMirror
 * ChangeSets, so the room never has to understand Markdown.
 *
 * The file is still the truth. The room writes it a moment after typing stops, with the hash it last wrote (so the
 * usual conflict check holds), and a change made elsewhere (Obsidian, the phone, an assistant, a scan) is merged into
 * the room instead of winning or losing: the room keeps the text it last wrote and every change since, works out what
 * the outside edit changed relative to that text, and moves it over the room's own changes.
 *
 * Share links see the body only (frontmatter can hold things not meant for readers). Every change is kept in both
 * forms: the whole note for signed-in clients, the body for share links. A share client's change is checked like an
 * editable share's PUT: it can't add properties or embeds.
 */

/** Changes kept per room for clients catching up after a dropped connection. Older ones start over (see `rejoin`). */
const MAX_LOG = 2000;
/** How long typing has to pause before the room writes the file. */
const SAVE_DELAY_MS = 1000;
/** How long a room with nobody in it stays open, so a quick reload picks up where it was. */
const IDLE_CLOSE_MS = 30_000;
const MAX_PEERS = 50;
/** Cursor colours, in the order people join. Readable on light and dark backgrounds. */
const COLORS = ["#e8710a", "#1a73e8", "#d01884", "#188038", "#9334e6", "#c5221f", "#007b83", "#b06000"];

type Update = { full: ChangeSet; body: ChangeSet; clientID: string };
export type LiveView = "full" | "body";
type Cursor = { anchor: number; head: number };

type Peer = {
  conn: string;
  clientID: string;
  /** Who it is, for telling two people apart and for the version history: `owner:<subject>` or `share:<id>`. */
  principal: string;
  name: string;
  color: string;
  view: LiveView;
  editor: boolean;
  cursor: Cursor | null;
  /** Checks a share client's change: an error message, or null if it may go in. */
  allow?: (before: string, after: string) => string | null;
  shareId?: string;
  send: (event: string, data: unknown) => void;
  close: () => void;
};

export class LiveError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 413 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** CodeMirror's documents always use \n; so does the room, and so do its writes (as the editor's always have). */
const normalize = (s: string) => s.replace(/\r\n?/g, "\n");
const textOf = (s: string) => Text.of(s.split("\n"));
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");

/** Where the body starts: the length of the frontmatter block, if there is one. */
export function frontmatterLength(s: string): number {
  return s.length - splitFrontmatter(s).body.length;
}

/** A ChangeSet that turns `a` into `b`, touching only what differs (character diff, so concurrent edits survive). */
export function diffChanges(a: string, b: string): ChangeSet {
  const specs: { from: number; to?: number; insert?: string }[] = [];
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

/** `changes` (on a document of `length`) moved by `offset`, on a document of `total`. */
function shift(changes: ChangeSet, offset: number, total: number): ChangeSet {
  const specs: { from: number; to: number; insert: string }[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => specs.push({ from: fromA + offset, to: toA + offset, insert: inserted.toString() }));
  return ChangeSet.of(specs, total);
}

/** The body's share of a change to the whole note: a plain shift unless it touched the frontmatter. */
function project(full: ChangeSet, before: string, after: string): ChangeSet {
  const fmBefore = frontmatterLength(before);
  const fmAfter = frontmatterLength(after);
  let inBody = fmBefore === fmAfter;
  if (inBody && fmBefore > 0) full.iterChangedRanges((fromA) => void (fromA < fmBefore && (inBody = false)));
  if (inBody) {
    const specs: { from: number; to: number; insert: string }[] = [];
    full.iterChanges((fromA, toA, _fb, _tb, inserted) => specs.push({ from: fromA - fmBefore, to: toA - fmBefore, insert: inserted.toString() }));
    return ChangeSet.of(specs, before.length - fmBefore);
  }
  return diffChanges(before.slice(fmBefore), after.slice(fmAfter));
}

export class Room {
  readonly epoch = random();
  private text: Text;
  private str: string;
  /** The version after the newest change; `log[0]` took the room from `logStart` to `logStart + 1`. */
  version = 0;
  private log: Update[] = [];
  private logStart = 0;
  /** The file as the room last wrote or read it, and the changes made here since (savedText → str). */
  private savedText: string;
  savedHash: string;
  private sinceSave: ChangeSet;
  /** While a write is out: the changes made since it started, which is what will be unsaved once it lands. */
  private duringSave: ChangeSet | null = null;
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
  readonly peers = new Map<string, Peer>();
  private colorIndex = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  closed = false;

  constructor(
    private hub: LiveHub,
    public path: string,
    note: Note,
  ) {
    this.str = normalize(note.content);
    this.text = textOf(this.str);
    this.savedText = this.str;
    this.savedHash = note.hash;
    this.sinceSave = ChangeSet.empty(this.str.length);
  }

  private viewText(view: LiveView) {
    return view === "full" ? this.str : this.str.slice(frontmatterLength(this.str));
  }

  join(peer: Omit<Peer, "color" | "cursor" | "conn">): Peer {
    if (this.peers.size >= MAX_PEERS) throw new LiveError(503, "too many people in this note");
    // The same client reconnecting before its old stream noticed it was gone. Someone else's id is refused, so
    // nobody can push someone else off.
    for (const other of this.peers.values()) {
      if (other.clientID !== peer.clientID) continue;
      if (other.principal !== peer.principal) throw new LiveError(409, "client id in use");
      this.leave(other.conn);
      other.close();
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const full: Peer = { ...peer, conn: random(), color: COLORS[this.colorIndex++ % COLORS.length]!, cursor: null };
    this.peers.set(full.conn, full);
    this.hub.conns.set(full.conn, this);
    return full;
  }

  /** What a client gets on (re)connecting: the changes it missed, if they're still here, else the whole text. */
  hello(peer: Peer, epoch: string | undefined, version: number | undefined) {
    const base = { epoch: this.epoch, clientID: peer.clientID, conn: peer.conn, hash: this.savedHash, dirty: this.dirty, color: peer.color };
    if (epoch === this.epoch && version !== undefined && version >= this.logStart && version <= this.version) {
      return { type: "resume", ...base, version, updates: this.updatesSince(version, peer.view) };
    }
    return { type: "init", ...base, version: this.version, text: this.viewText(peer.view) };
  }

  leave(conn: string) {
    if (!this.peers.delete(conn)) return;
    this.hub.conns.delete(conn);
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

  private updatesSince(version: number, view: LiveView) {
    return this.log.slice(version - this.logStart).map((u) => ({ clientID: u.clientID, changes: (view === "full" ? u.full : u.body).toJSON() }));
  }

  /** A client's changes, made against `version`. Applied in order; a refused one stops the rest. */
  push(conn: string, version: number, raw: { clientID: string; changes: unknown }[], opts: { keepVersion?: boolean } = {}) {
    const peer = this.peers.get(conn);
    if (!peer) throw new LiveError(409, "not connected");
    if (!peer.editor) throw new LiveError(403, "read only");
    if (version < this.logStart) throw new LiveError(409, "too far behind");
    if (version > this.version) throw new LiveError(400, "unknown version");
    let updates: { clientID: string; changes: ChangeSet }[];
    try {
      updates = raw.map((u) => {
        if (u.clientID !== peer.clientID) throw new LiveError(400, "not your client id");
        return { clientID: u.clientID, changes: ChangeSet.fromJSON(u.changes) };
      });
    } catch (err) {
      throw err instanceof LiveError ? err : new LiveError(400, "invalid changes");
    }
    const over = this.log.slice(version - this.logStart).map((u) => ({ clientID: u.clientID, changes: peer.view === "full" ? u.full : u.body }));
    updates = rebaseUpdates(updates, over) as typeof updates;
    if (opts.keepVersion) this.keepVersion = true;
    const sent: Update[] = [];
    try {
      for (const u of updates) {
        const fm = peer.view === "full" ? 0 : frontmatterLength(this.str);
        if (u.changes.length !== this.str.length - fm) throw new LiveError(400, "changes don't fit the note");
        const full = peer.view === "full" ? u.changes : shift(u.changes, fm, this.str.length);
        const after = full.apply(this.text);
        if (after.length > MAX_NOTE_BYTES) throw new LiveError(413, "note too large");
        if (peer.allow) {
          const refused = peer.allow(this.str, after.toString());
          if (refused) throw new LiveError(400, refused);
        }
        sent.push(this.apply(full, u.clientID, peer.principal, after));
      }
    } finally {
      this.broadcast(sent);
    }
  }

  /**
   * A client whose changes the room never saw (the server restarted, or it was away too long) sends its whole text
   * and the hash of the file it started from. If that is still the room's starting point, what it changed is worked
   * out and merged like an outside edit; if not, there's nothing safe to merge it onto.
   */
  rejoin(conn: string, baseHash: string, text: string) {
    const peer = this.peers.get(conn);
    if (!peer?.editor) throw new LiveError(403, "read only");
    if (baseHash !== this.savedHash) throw new LiveError(409, "the note changed since");
    text = normalize(text);
    const fm = peer.view === "full" ? 0 : frontmatterLength(this.savedText);
    const changes = shift(diffChanges(this.savedText.slice(fm), text), fm, this.savedText.length);
    if (changes.empty) return;
    const mapped = changes.map(this.sinceSave, true);
    const after = mapped.apply(this.text);
    if (after.length > MAX_NOTE_BYTES) throw new LiveError(413, "note too large");
    if (peer.allow) {
      const refused = peer.allow(this.str, after.toString());
      if (refused) throw new LiveError(400, refused);
    }
    this.broadcast([this.apply(mapped, `rejoin-${peer.clientID}`, peer.principal, after)]);
  }

  presence(conn: string, version: number, cursor: Cursor | null) {
    const peer = this.peers.get(conn);
    if (!peer) throw new LiveError(409, "not connected");
    if (cursor && version >= this.logStart && version <= this.version) {
      let { anchor, head } = cursor;
      for (const u of this.log.slice(version - this.logStart)) {
        const changes = peer.view === "full" ? u.full : u.body;
        if (anchor > changes.length || head > changes.length) return;
        anchor = changes.mapPos(anchor);
        head = changes.mapPos(head);
      }
      const fm = peer.view === "full" ? 0 : frontmatterLength(this.str);
      const max = this.str.length;
      peer.cursor = { anchor: Math.min(anchor + fm, max), head: Math.min(head + fm, max) };
    } else if (!cursor) peer.cursor = null;
    else return;
    this.sendPresence();
  }

  /** Applies a change to the whole note. `principal` is who made it (null: the file changed elsewhere). */
  private apply(full: ChangeSet, clientID: string, principal: string | null, after = full.apply(this.text)): Update {
    const before = this.str;
    this.text = after;
    this.str = after.toString();
    const update = { full, body: project(full, before, this.str), clientID };
    this.log.push(update);
    this.version++;
    if (this.log.length > MAX_LOG) {
      this.log.shift();
      this.logStart++;
    }
    for (const peer of this.peers.values()) {
      if (peer.cursor) peer.cursor = { anchor: full.mapPos(peer.cursor.anchor), head: full.mapPos(peer.cursor.head) };
    }
    if (principal) {
      this.sinceSave = this.sinceSave.compose(full);
      if (this.duringSave) this.duringSave = this.duringSave.compose(full);
      this.editors.add(principal);
      this.dirty = true;
      this.scheduleSave(SAVE_DELAY_MS);
    }
    return update;
  }

  private broadcast(updates: Update[]) {
    if (!updates.length) return;
    for (const peer of this.peers.values()) {
      peer.send("update", {
        version: this.version,
        dirty: this.dirty,
        updates: updates.map((u) => ({ clientID: u.clientID, changes: (peer.view === "full" ? u.full : u.body).toJSON() })),
      });
    }
  }

  /** Who is here and where their cursors are, to everyone (each in their own view). */
  sendPresence() {
    for (const peer of this.peers.values()) {
      const fm = peer.view === "full" ? 0 : frontmatterLength(this.str);
      const people = [...this.peers.values()]
        .filter((p) => p.editor || p.view === "full")
        .map((p) => {
          const cursor = p.cursor && p.cursor.head >= fm && p.cursor.anchor >= fm ? { anchor: p.cursor.anchor - fm, head: p.cursor.head - fm } : null;
          return { id: p.clientID, name: p.name, color: p.color, cursor, me: p === peer };
        });
      peer.send("presence", { version: this.version, people });
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
    if (text === this.savedText) {
      this.dirty = false;
      this.sinceSave = ChangeSet.empty(text.length);
      return this.sendSaved();
    }
    // Someone new editing (a share link's visitor, or a second person after the first) keeps what was there as a
    // version, so the owner can undo it. One person typing on their own gets the usual one version per sitting.
    const fresh = [...this.editors].some((e) => !this.lastEditors.has(e) && (this.lastEditors.size > 0 || e.startsWith("share:")));
    this.duringSave = ChangeSet.empty(text.length);
    try {
      const saved = await this.hub.vault.write(this.path, text, this.savedHash, { keepVersion: this.keepVersion || fresh });
      this.savedText = text;
      this.savedHash = saved.hash;
      this.sinceSave = this.duringSave;
      this.duringSave = null;
      this.dirty = this.str !== text;
      if (this.editors.size) this.lastEditors = this.editors;
      this.editors = new Set();
      this.keepVersion = false;
      this.failures = 0;
      this.sendSaved();
    } catch (err) {
      this.duringSave = null;
      if (!(err instanceof VaultError)) throw err;
      if (err.status === 409 && err.current && "content" in err.current) {
        // Changed elsewhere since the room last wrote it: take that in, then write again on top of it.
        this.absorb(err.current);
        this.scheduleSave(0);
      } else if (err.status === 404 || err.status === 409) this.gone();
      else {
        this.failures++;
        for (const peer of this.peers.values()) peer.send("status", { error: "Can't save, retrying" });
        this.scheduleSave(Math.min(30_000, 2000 * 2 ** Math.min(this.failures, 4)));
      }
    }
  }

  private sendSaved() {
    for (const peer of this.peers.values()) peer.send("saved", { hash: this.savedHash, version: this.version, dirty: this.dirty });
  }

  /** The file as it is now, merged in: what changed since the room's last write, moved over the room's own changes. */
  private absorb(current: { content: string; hash: string }) {
    const theirs = normalize(current.content);
    const changes = diffChanges(this.savedText, theirs);
    const mapped = changes.map(this.sinceSave, true);
    this.sinceSave = this.sinceSave.map(changes);
    this.savedText = theirs;
    this.savedHash = current.hash;
    if (!mapped.empty) this.broadcast([this.apply(mapped, "server", null)]);
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
    for (const peer of this.peers.values()) if (peer.view === "full") peer.send("moved", { path: to });
  }

  /** Deleted (or moved away, or no longer shared): everyone's told, and the room closes. */
  gone() {
    for (const peer of this.peers.values()) {
      peer.send("gone", {});
      peer.close();
    }
    this.close();
  }

  /** A share link's editing was turned off, or the link stopped. */
  shareChanged(shareId: string, editable: boolean | null) {
    for (const peer of [...this.peers.values()]) {
      if (peer.shareId !== shareId) continue;
      if (editable === null) {
        peer.send("gone", {});
        peer.close();
        this.leave(peer.conn);
      } else if (!editable && peer.editor) {
        peer.editor = false;
        peer.send("readonly", {});
        this.sendPresence();
      }
    }
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const conn of this.peers.keys()) this.hub.conns.delete(conn);
    this.peers.clear();
    this.hub.forget(this);
  }
}

/** The open rooms of one vault. */
export class LiveHub {
  private rooms = new Map<string, Room>();
  private opening = new Map<string, Promise<Room>>();
  readonly conns = new Map<string, Room>();

  constructor(readonly vault: Vault) {
    vault.events.on("event", (e: VaultEvent) => this.onEvent(e));
  }

  private onEvent(e: VaultEvent) {
    if (e.type === "note.moved") {
      const room = this.rooms.get(e.from);
      if (!room) return;
      this.rooms.delete(e.from);
      this.rooms.get(e.path)?.gone();
      this.rooms.set(e.path, room);
      room.moved(e.path);
      return;
    }
    const room = this.rooms.get(e.path);
    if (!room) return;
    if (e.type === "note.deleted") room.gone();
    else if (e.type === "note.updated" || e.type === "note.created") void room.checkFile();
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
          const room = this.rooms.get(path) ?? new Room(this, path, note);
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

// ---- HTTP: a Server-Sent Events stream per client, and POSTs for what it sends

const CLIENT_ID = /^[A-Za-z0-9_-]{6,40}$/;
export const streamQuery = z.object({
  epoch: z.string().max(64).optional(),
  version: z.coerce.number().int().min(0).optional(),
  client: z.string().regex(CLIENT_ID),
});
const pushBody = z.object({
  conn: z.string().max(64),
  version: z.number().int().min(0),
  updates: z.array(z.object({ clientID: z.string().max(64), changes: z.unknown() })).max(500),
  keep_version: z.boolean().optional(),
});
const presenceBody = z.object({
  conn: z.string().max(64),
  version: z.number().int().min(0),
  cursor: z.object({ anchor: z.number().int().min(0), head: z.number().int().min(0) }).nullable(),
});
const rejoinBody = z.object({ conn: z.string().max(64), base_hash: z.string().max(128), text: z.string() });
const connBody = z.object({ conn: z.string().max(64) });

/** Opens the stream: the first event is `init` or `resume` (see Room.hello), then updates, presence and saves. */
export function liveStream(c: Context, room: Room, peer: Omit<Peer, "color" | "cursor" | "conn" | "send" | "close">, q: z.infer<typeof streamQuery>, keepAliveMs = 25_000) {
  c.header("cache-control", "no-store");
  c.header("x-accel-buffering", "no");
  return streamSSE(c, async (stream) => {
    let open = true;
    let joined: Peer | undefined;
    // One write at a time, in order; closing waits for what's queued (a "gone" has to arrive before the end).
    let queue = Promise.resolve();
    // A write that fails means the client has gone (a closed tab often says nothing until then).
    const lost = () => {
      if (!open) return;
      open = false;
      if (joined) room.leave(joined.conn);
    };
    const send = (event: string, data: unknown) => {
      if (open) queue = queue.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(lost);
    };
    const close = () => {
      open = false;
      queue = queue.then(() => stream.close()).catch(() => {});
    };
    try {
      joined = room.join({ ...peer, send, close });
    } catch (err) {
      if (!(err instanceof LiveError)) throw err;
      await stream.writeSSE({ event: "refused", data: JSON.stringify({ error: err.message, status: err.status }) });
      return;
    }
    stream.onAbort(() => {
      open = false;
    });
    try {
      send("hello", room.hello(joined, q.epoch, q.version));
      room.sendPresence();
      while (open && !room.closed) {
        await stream.sleep(keepAliveMs);
        if (open) queue = queue.then(() => stream.write(": ping\n\n")).then(() => {}, lost);
      }
    } finally {
      open = false;
      room.leave(joined!.conn);
    }
  });
}

/** The POSTs a live client makes. `who` finds the caller's room and checks it may use that connection. */
export function liveActions(who: (c: Context, conn: string) => Room | null | Promise<Room | null>) {
  const app = new Hono<AuthEnv>();
  const run = async <T extends z.ZodTypeAny>(c: Context, schema: T, act: (room: Room, body: z.infer<T>) => unknown | Promise<unknown>) => {
    const body = schema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const room = await who(c, (body.data as { conn: string }).conn);
    if (!room || room.closed) return c.json({ error: "not connected" }, 409);
    try {
      const result = await act(room, body.data);
      return c.json(result ?? { ok: true });
    } catch (err) {
      if (err instanceof LiveError || err instanceof VaultError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  };
  app.post("/push", (c) => run(c, pushBody, (room, b) => room.push(b.conn, b.version, b.updates, { keepVersion: b.keep_version })));
  app.post("/presence", (c) => run(c, presenceBody, (room, b) => room.presence(b.conn, b.version, b.cursor)));
  app.post("/rejoin", (c) => run(c, rejoinBody, (room, b) => room.rejoin(b.conn, b.base_hash, b.text)));
  // "Save now" (before leaving the note, changing its properties, or reading its history).
  app.post("/save", (c) =>
    run(c, connBody, async (room) => {
      await room.save();
      return { hash: room.savedHash, dirty: room.dirty };
    }),
  );
  return app;
}

/** Signed in: `/live?path=…` streams a note, `/live/*` takes what the client sends. Full-scope tokens only (see app.ts). */
export function liveRoutes(vault: Vault, nameOf: (subject: string) => string) {
  const hub = liveFor(vault);
  const app = new Hono<AuthEnv>();
  app.get("/live", async (c) => {
    const q = streamQuery.safeParse(c.req.query());
    const path = c.req.query("path");
    if (!q.success || !path) return c.json({ error: "invalid query" }, 400);
    let room: Room;
    try {
      room = await hub.open(path);
    } catch (err) {
      if (err instanceof LiveError || err instanceof VaultError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    const subject = c.get("subject");
    return liveStream(c, room, { clientID: q.data.client, principal: `owner:${subject}`, name: nameOf(subject), view: "full", editor: true }, q.data);
  });
  app.route(
    "/live",
    liveActions((c, conn) => {
      const room = hub.conns.get(conn);
      const peer = room?.peers.get(conn);
      return peer?.principal === `owner:${c.get("subject")}` ? room! : null;
    }),
  );
  return app;
}
