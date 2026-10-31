import type { Database } from "bun:sqlite";
import { mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { now } from "./db";
import { parseTodos } from "./todos";

/**
 * The notes vault: plain markdown files in a folder (often a NAS share), laid out the way Obsidian expects.
 * Files are the truth; the `notes` table is an index a scan can always rebuild.
 */

export const TRASH = ".trash";
export const ATTACHMENTS = "attachments";
const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules"]);
/**
 * Version history (boards excluded): a new version at most every VERSION_GAP_MS per note, or whenever a write comes
 * after SITTING_GAP_MS without one; MAX_VERSIONS kept per note.
 */
const VERSION_GAP_MS = 10 * 60_000;
const SITTING_GAP_MS = 2 * 60_000;
const MAX_VERSIONS = 50;

export type NoteMeta = {
  path: string;
  title: string;
  tags: string[];
  mtime: number;
  size: number;
  hash: string;
  pinned: boolean;
  color: string | null;
};
export type Note = NoteMeta & { content: string };
/** A note in `.trash/`: `path` is inside the trash, `original` is where a restore puts it back. */
export type TrashedNote = {
  path: string;
  original: string;
  title: string;
  excerpt: string;
  deleted_at: number;
  size: number;
  /** Set when the note went to the trash inside a folder: that folder's path in the trash (restore it whole). */
  folder?: string;
};

/** 404 / 409 / 400 / 503 for the routes, so file system detail never reaches clients. */
export class VaultError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 413 | 503,
    message: string,
    public current?: Note,
  ) {
    super(message);
  }
}

/** Maps errno codes from fs (and CIFS's `soft` mount timeouts) onto statuses. */
function fsError(err: unknown, what: string): never {
  if (err instanceof VaultError) throw err;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") throw new VaultError(404, `${what} not found`);
  if (code === "EEXIST" || code === "ENOTEMPTY") throw new VaultError(409, `${what} already exists`);
  console.warn(`[notes] ${what}: ${(err as Error).message}`);
  throw new VaultError(503, "notes storage unavailable");
}

/**
 * Checks a vault-relative path from a client: forward slashes, no `..`, no hidden segments (those belong to
 * Obsidian, git and Sink's trash), nothing Windows or SMB would choke on.
 */
export function cleanPath(raw: string, kind: "note" | "folder" | "file"): string {
  const path = raw.trim().replace(/^\/+|\/+$/g, "");
  const parts = path.split("/");
  const ok =
    path.length > 0 &&
    path.length <= 1024 &&
    parts.every((p) => p.length > 0 && p.length <= 255 && !p.startsWith(".") && !/[\\:*?"<>|\u0000-\u001f]/.test(p) && p.trim() === p);
  if (!ok) throw new VaultError(400, "invalid path");
  if (kind === "note" && !path.toLowerCase().endsWith(".md")) throw new VaultError(400, "notes must end in .md");
  return path;
}

/** A title made safe to use as a file name (Obsidian refuses the same characters). */
export function fileNameFor(title: string): string {
  const name = title
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100)
    .trim();
  return name || "Untitled";
}

/** Turns free text into a safe FTS5 query: every word becomes a quoted prefix term. */
export function toFtsQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}]+/gu);
  if (!words?.length) return null;
  return words.map((w) => `"${w}"*`).join(" ");
}

export const sha256 = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** Splits `---` frontmatter off the top. Returns the raw YAML lines and the body after it. */
export function splitFrontmatter(content: string): { yaml: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  return m ? { yaml: m[1]!, body: content.slice(m[0].length) } : { yaml: null, body: content };
}

/**
 * Just enough YAML for the keys Sink reads: `title: x`, `tags: [a, b]`, `tags: a, b`, and block lists.
 * Anything fancier is left alone (it's still in the file; Sink only indexes it).
 */
export function readFrontmatter(yaml: string): { title?: string; tags: string[]; pinned?: boolean; color?: string } {
  const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  const out: { title?: string; tags: string[]; pinned?: boolean; color?: string } = { tags: [] };
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\w[\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "title" && value) out.title = unquote(value);
    if (key === "pinned") out.pinned = /^(true|yes|1)$/i.test(unquote(value!));
    if (key === "color" && COLORS.includes(unquote(value!).toLowerCase())) out.color = unquote(value!).toLowerCase();
    if (key === "tags" || key === "tag") {
      if (value) {
        out.tags.push(...value.replace(/^\[|\]$/g, "").split(/[,\s]+/).map(unquote));
      } else {
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]!)) out.tags.push(unquote(lines[++i]!.replace(/^\s*-\s+/, "")));
      }
    }
  }
  out.tags = out.tags.map((t) => t.replace(/^#/, "")).filter(Boolean);
  return out;
}

/** `#tags` in the text, Obsidian rules: not in code, not all digits, may nest with `/`. */
export function inlineTags(body: string): string[] {
  const text = body.replace(/```[\s\S]*?```|`[^`\n]*`/g, " ");
  const tags = [...text.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_\-/]+)/gu)].map((m) => m[1]!.replace(/\/+$/, ""));
  return tags.filter((t) => t && !/^[\d/]+$/.test(t));
}

/** Keep's card colours; anything else in `color:` is ignored. */
export const COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "gray"];

/** Sets (or with null, removes) one `key: value` line in the frontmatter, creating the block if needed. */
export function setFrontmatterKey(content: string, key: string, value: string | null): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(\r?\n|$)/.exec(content);
  const line = value === null ? null : `${key}: ${value}`;
  if (!m) return line ? `---\n${line}\n---\n${content}` : content;
  const lines = m[1] ? m[1].split(/\r?\n/) : [];
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at >= 0) line ? (lines[at] = line) : lines.splice(at, 1);
  else if (line) lines.push(line);
  const rest = content.slice(m[0].length);
  // Nothing left but our own key: drop the block rather than leave an empty one.
  if (!lines.some((l) => l.trim())) return rest;
  return `---\n${lines.join("\n")}\n---\n${rest}`;
}

export const isBoard = (path: string) => path.toLowerCase().endsWith(".excalidraw.md");

/** Title, tags and searchable body of a note's text. */
export function parseNote(
  path: string,
  content: string,
): { title: string; tags: string[]; body: string; pinned: boolean; color: string | null } {
  const { yaml, body: full } = splitFrontmatter(content);
  // `%% … %%` is an Obsidian comment; Excalidraw boards keep their whole drawing JSON in one.
  // The Excalidraw plugin's "==⚠ Switch to EXCALIDRAW VIEW … ==" banner isn't content either.
  const body = full.replace(/%%[\s\S]*?(?:%%|$)/g, " ").replace(/^==⚠[^\n]*$/gm, "");
  const fm = yaml ? readFrontmatter(yaml) : { tags: [] };
  const heading = isBoard(path) ? undefined : /^#[ \t]+(.+?)[ \t#]*$/m.exec(body)?.[1]?.trim();
  const title = heading || fm.title || basename(path).replace(/(\.excalidraw)?\.md$/i, "");
  const seen = new Map<string, string>();
  for (const t of [...fm.tags, ...inlineTags(body)]) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  return { title, tags: [...seen.values()], body, pinned: fm.pinned ?? false, color: fm.color ?? null };
}

type Row = { path: string; title: string; tags: string; mtime: number; size: number; hash: string; pinned: number; color: string | null };

/** Card preview: the body without the heading that became the title, trimmed to whole lines. */
/**
 * Every link to another note in a file, frontmatter included: `[[target]]` (with `#heading`, `|alias`, or `!` embed)
 * and `[text](target.md)`. Targets come back as the backlinks lookup wants them: lower case, no `.md` or `#heading`,
 * no leading `./`, `../` or `/`. One entry per target per line, with the line trimmed for display.
 */
export function parseLinks(content: string): { target: string; line: string }[] {
  const out: { target: string; line: string }[] = [];
  const norm = (ref: string) =>
    ref.trim().replace(/#.*$/, "").replace(/^(\.{1,2}\/|\/)+/, "").replace(/\.md$/i, "").toLowerCase();
  for (const raw of content.split("\n")) {
    if (!raw.includes("[[") && !raw.includes("](")) continue;
    const targets = new Set<string>();
    for (const m of raw.matchAll(/!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) targets.add(norm(m[1]!));
    for (const m of raw.matchAll(/\]\(<?([^)>\s]+\.md)(?:#[^)>]*)?>?\)/gi)) {
      let href = m[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      try {
        href = decodeURIComponent(href);
      } catch {}
      targets.add(norm(href));
    }
    targets.delete("");
    const line = raw.trim().slice(0, 240);
    for (const target of targets) out.push({ target, line });
  }
  return out;
}

/** Rewrites links to a note that moved (see Vault.relink). `oldFull`/`oldName` are lower case, without ".md". */
export function rewriteLinks(
  content: string,
  m: { oldFull: string; oldName: string; newFull: string; newName: string; byName: boolean },
): string {
  const norm = (t: string) => t.trim().replace(/^(\.{1,2}\/|\/)+/, "").replace(/\.md$/i, "").toLowerCase();
  const wiki = content.replace(/(!?\[\[)([^\]|#]+)((?:#[^\]|]*)?(?:\|[^\]]*)?\]\])/g, (all, open: string, t: string, rest: string) => {
    const n = norm(t);
    const ext = /\.md\s*$/i.test(t) ? ".md" : "";
    if (t.includes("/")) return n === m.oldFull || m.oldFull.endsWith("/" + n) ? `${open}${m.newFull}${ext}${rest}` : all;
    return m.byName && n === m.oldName ? `${open}${m.newName}${ext}${rest}` : all;
  });
  return wiki.replace(/\]\(<?([^)>\s]+\.md)(#[^)>]*)?(>?)\)/gi, (all, href: string, anchor = "", close: string) => {
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {}
    if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) || norm(decoded) !== m.oldFull) return all;
    const next = close ? `${m.newFull}.md` : encodeURI(`${m.newFull}.md`);
    return `](${close ? "<" : ""}${next}${anchor}${close})`;
  });
}

/**
 * The first image a note embeds (`![[photo.jpg|300]]` or `![alt](Attachments/photo.jpg)`), as the name or vault path
 * the attachment route takes, for the card. Images on the web aren't fetched for cards.
 */
export function firstImage(body: string): string | null {
  for (const m of body.matchAll(/!\[\[([^\]|#]+)[^\]]*\]\]|!\[[^\]]*\]\(<?([^)>]+?)>?(?:\s+"[^"]*")?\)/g)) {
    let ref = (m[1] ?? m[2]!).trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || !/\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(ref)) continue;
    try {
      ref = decodeURIComponent(ref);
    } catch {}
    return ref.replace(/^(\.{1,2}\/|\/)+/, "");
  }
  return null;
}

export function cardText(body: string, title: string): string {
  const lines = body.replace(/^\s+/, "").split("\n");
  if (lines[0]?.replace(/^#+\s*/, "").trim() === title) lines.shift();
  return lines.join("\n").trim().slice(0, 400);
}

export class Vault {
  readonly dir: string;
  private scanning: Promise<ScanResult> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Folder paths seen by the last scan (and created since), so empty folders still show. */
  private folders = new Set<string>();
  /** Non-note files by lowercase name, for resolving `![[image.png]]` embeds. */
  private files = new Map<string, string[]>();
  /** Emits "event" with a VaultEvent. */
  readonly events = new EventEmitter();

  emit(event: VaultEvent) {
    this.events.emit("event", event);
  }

  constructor(
    private db: Database,
    dir: string,
    private timeZone = "UTC",
  ) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true });
  }

  private realDir: Promise<string> | null = null;

  /**
   * Absolute path for a vault-relative one, after following symlinks: a link synced into the vault (Syncthing and
   * git carry them) must not reach the server's own files. Where the path doesn't exist yet, its nearest existing
   * parent is checked instead.
   */
  async abs(path: string): Promise<string> {
    const abs = resolve(this.dir, path);
    if (!abs.startsWith(this.dir + sep)) throw new VaultError(400, "invalid path");
    const root = await (this.realDir ??= realpath(this.dir));
    for (let p = abs; ; p = dirname(p)) {
      try {
        const real = await realpath(p);
        if (real !== root && !real.startsWith(root + sep)) throw new VaultError(400, "invalid path");
        return abs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT" || dirname(p) === p) throw err;
      }
    }
  }

  // ---- index

  private index(path: string, content: string, size: number, mtime: number, hash = sha256(content)): NoteMeta {
    const { title, tags, body, pinned, color } = parseNote(path, content);
    this.db
      .query(
        `INSERT INTO notes (path, title, tags, body, hash, size, mtime, indexed_at, pinned, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET title = excluded.title, tags = excluded.tags, body = excluded.body,
           hash = excluded.hash, size = excluded.size, mtime = excluded.mtime, indexed_at = excluded.indexed_at,
           pinned = excluded.pinned, color = excluded.color`,
      )
      .run(path, title, JSON.stringify(tags), body, hash, size, mtime, now(), pinned ? 1 : 0, color);
    this.db.query("DELETE FROM todos WHERE path = ?").run(path);
    if (!isBoard(path)) {
      const insert = this.db.query(
        "INSERT INTO todos (path, line, raw, text, status, due, remind_at, done_on, priority, start, scheduled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const t of parseTodos(content, this.timeZone))
        insert.run(path, t.line, t.raw, t.text, t.status, t.due, t.remind_at, t.done_on, t.priority, t.start, t.scheduled);
    }
    this.db.query("DELETE FROM links WHERE src = ?").run(path);
    const link = this.db.query("INSERT INTO links (src, target, line) VALUES (?, ?, ?)");
    for (const l of parseLinks(content)) link.run(path, l.target, l.line);
    for (let d = dirname(path); d !== "."; d = dirname(d)) this.folders.add(d);
    return { path, title, tags, mtime, size, hash, pinned, color };
  }

  private unindex(path: string) {
    this.db.query("DELETE FROM notes WHERE path = ?").run(path);
  }

  /**
   * Walks the vault and brings the index in line: new and changed files (by mtime + size) are read and
   * re-indexed, vanished ones dropped. CIFS has no inotify, so this runs on a timer and after errors.
   */
  scan(): Promise<ScanResult> {
    this.scanning ??= this.walkAndIndex().finally(() => (this.scanning = null));
    return this.scanning;
  }

  private async walkAndIndex(): Promise<ScanResult> {
    const known = new Map(
      this.db
        .query<{ path: string; size: number; mtime: number }, []>("SELECT path, size, mtime FROM notes")
        .all()
        .map((r) => [r.path, r]),
    );
    const building = known.size === 0;
    const folders = new Set<string>();
    const files = new Map<string, string[]>();
    const seen = new Set<string>();
    const result: ScanResult = { added: 0, updated: 0, removed: 0, notes: 0 };

    const walk = async (rel: string) => {
      const entries = await readdir(rel ? join(this.dir, rel) : this.dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          folders.add(path);
          await walk(path);
          continue;
        }
        if (!e.isFile()) continue;
        if (!e.name.toLowerCase().endsWith(".md")) {
          const key = e.name.toLowerCase();
          files.set(key, [...(files.get(key) ?? []), path]);
          continue;
        }
        seen.add(path);
        result.notes++;
        const st = await stat(join(this.dir, path));
        const prev = known.get(path);
        const mtime = Math.floor(st.mtimeMs);
        if (prev && prev.size === st.size && prev.mtime === mtime) continue;
        if (st.size > MAX_NOTE_BYTES) continue;
        const content = await readFile(join(this.dir, path), "utf8");
        const before = prev ? this.row(path)?.hash : undefined;
        const m = this.index(path, content, st.size, mtime);
        prev ? result.updated++ : result.added++;
        // A touched file with the same text isn't a change worth telling anyone about.
        // Nor is filling an empty index (a new or rebuilt database): those notes aren't new, just new to us.
        if (before !== m.hash && !building) this.emit({ type: prev ? "note.updated" : "note.created", path, source: "external" });
      }
    };

    try {
      await walk("");
    } catch (err) {
      // Half a walk would look like mass deletion; keep the old index until the share is back.
      console.warn(`[notes] scan failed: ${(err as Error).message}`);
      throw new VaultError(503, "notes storage unavailable");
    }
    this.db.transaction(() => {
      for (const path of known.keys()) {
        if (!seen.has(path)) {
          this.unindex(path);
          result.removed++;
          this.emit({ type: "note.deleted", path, source: "external" });
        }
      }
    })();
    this.folders = folders;
    this.files = files;
    return result;
  }

  start(intervalMs: number) {
    const run = () => this.scan().catch(() => {});
    void run();
    this.timer = setInterval(run, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- reading

  /** Every note, pinned first then newest, each with the start of its text and its first image for a card preview. */
  list(): { notes: (NoteMeta & { excerpt: string; image: string | null })[]; folders: string[] } {
    const notes = this.db
      .query<Row & { excerpt: string; head: string }, []>(
        `SELECT path, title, tags, mtime, size, hash, pinned, color, substr(body, 1, 600) AS excerpt, substr(body, 1, 4000) AS head
         FROM notes ORDER BY pinned DESC, mtime DESC`,
      )
      .all()
      .map(({ head, ...r }) => ({ ...meta(r), excerpt: cardText(r.excerpt, r.title), image: isBoard(r.path) ? null : firstImage(head) }));
    return { notes, folders: [...this.folders].sort((a, b) => a.localeCompare(b)) };
  }

  /**
   * Notes that link here, Obsidian's "linked mentions": `[[Name]]`, `[[Folder/Name]]` or any end of the path, the
   * note's title, with `#heading` or `|alias`, and `[text](Folder/Name.md)`, in any case. Each comes with up to three
   * of the lines that link. Read from the links table, so it's an index lookup, not a scan.
   */
  backlinks(path: string): { path: string; title: string; lines: string[] }[] {
    const clean = cleanPath(path, "note");
    const target = clean.replace(/\.md$/i, "").toLowerCase();
    const parts = target.split("/");
    // The full path, every shorter end of it ("garden/soil", "soil"), and the title.
    const refs = new Set(parts.map((_, i) => parts.slice(i).join("/")));
    const title = this.row(clean)?.title;
    if (title) refs.add(title.toLowerCase());
    const list = [...refs];
    const rows = this.db
      .query<{ src: string; title: string; line: string }, string[]>(
        `SELECT l.src, n.title, l.line FROM links l JOIN notes n ON n.path = l.src
         WHERE l.target IN (${list.map(() => "?").join(", ")}) AND l.src != ?
         ORDER BY n.mtime DESC, l.rowid`,
      )
      .all(...list, clean);
    const out = new Map<string, { path: string; title: string; lines: string[] }>();
    for (const r of rows) {
      const hit = out.get(r.src) ?? (out.size < 50 ? { path: r.src, title: r.title, lines: [] } : null);
      if (!hit) continue;
      out.set(r.src, hit);
      if (hit.lines.length < 3 && !hit.lines.includes(r.line)) hit.lines.push(r.line);
    }
    return [...out.values()];
  }

  search(fts: string, limit: number) {
    return this.db
      .query<Row & { snippet: string }, [string, number]>(
        `SELECT n.path, n.title, n.tags, n.mtime, n.size, n.hash, n.pinned, n.color,
           snippet(notes_fts, 2, '[', ']', '…', 16) AS snippet
         FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts, 2.0, 5.0, 1.0, 3.0) LIMIT ?`,
      )
      .all(fts, limit)
      .map((r) => ({ ...meta(r), snippet: r.snippet }));
  }

  /** Pin or colour a note by rewriting its frontmatter; same conflict rules as a save. */
  async setMeta(path: string, changes: { pinned?: boolean; color?: string | null }): Promise<NoteMeta> {
    for (let attempt = 0; ; attempt++) {
      const note = await this.read(path);
      let content = note.content;
      if (changes.pinned !== undefined) content = setFrontmatterKey(content, "pinned", changes.pinned ? "true" : null);
      if (changes.color !== undefined) content = setFrontmatterKey(content, "color", changes.color);
      try {
        return await this.write(note.path, content, note.hash);
      } catch (err) {
        if (err instanceof VaultError && err.status === 409 && attempt === 0) continue;
        throw err;
      }
    }
  }

  async read(path: string): Promise<Note> {
    path = cleanPath(path, "note");
    try {
      const abs = await this.abs(path);
      const st = await stat(abs);
      if (st.size > MAX_NOTE_BYTES) throw new VaultError(413, "note too large");
      const content = await readFile(abs, "utf8");
      const hash = sha256(content);
      const row = this.db.query<{ hash: string }, [string]>("SELECT hash FROM notes WHERE path = ?").get(path);
      // Edited outside Sink since the last scan.
      const m = row?.hash === hash ? meta(this.row(path)!) : this.index(path, content, st.size, Math.floor(st.mtimeMs), hash);
      return { ...m, content };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") this.unindex(path);
      fsError(err, "note");
    }
  }

  // ---- version history

  /**
   * Keeps `content` (what the file held before a write) as a version, unless the last one is under VERSION_GAP_MS
   * old: autosave writes every few seconds while someone types, and one version per sitting is what's useful.
   * Only the newest MAX_VERSIONS per note are kept.
   */
  private snapshot(path: string, content: string, always = false, at = now()) {
    const last = this.db.query<{ at: number }, [string]>("SELECT max(at) AS at FROM versions WHERE path = ?").get(path)?.at;
    // The text being replaced was last written this long ago. Autosave writes every few seconds while someone types;
    // a pause longer than SITTING_GAP_MS means this write starts a new sitting (maybe another device or an
    // assistant), so what was there is worth keeping even if the last version is recent.
    const written = this.db.query<{ mtime: number }, [string]>("SELECT mtime FROM notes WHERE path = ?").get(path)?.mtime ?? 0;
    const newSitting = at - written >= SITTING_GAP_MS;
    if (!always && !newSitting && last && at - last < VERSION_GAP_MS) return;
    // The same text twice in a row isn't a new version.
    const newest = this.db.query<{ content: string }, [string]>("SELECT content FROM versions WHERE path = ? ORDER BY at DESC, id DESC LIMIT 1").get(path);
    if (newest?.content === content) return;
    this.db.query("INSERT INTO versions (path, at, content) VALUES (?, ?, ?)").run(path, at, content);
    this.db
      .query("DELETE FROM versions WHERE path = ? AND id NOT IN (SELECT id FROM versions WHERE path = ? ORDER BY at DESC, id DESC LIMIT ?)")
      .run(path, path, MAX_VERSIONS);
  }

  /** A note's earlier versions, newest first: when, how big, and how it starts. */
  versions(path: string): { id: number; at: number; size: number; preview: string }[] {
    path = cleanPath(path, "note");
    return this.db
      .query<{ id: number; at: number; size: number; preview: string }, [string]>(
        // Enough to get past long frontmatter before taking the words.
        "SELECT id, at, length(content) AS size, substr(content, 1, 4000) AS preview FROM versions WHERE path = ? ORDER BY at DESC, id DESC",
      )
      .all(path)
      .map((v) => ({
        ...v,
        // Its words, not its title (which every version shares): body lines without headings, run together.
        preview: splitFrontmatter(v.preview)
          .body.split("\n")
          .filter((l) => l.trim() && !/^#{1,6}\s/.test(l))
          .map((l) => l.trim())
          .join(" ")
          .slice(0, 160),
      }));
  }

  /** One earlier version's full text. */
  version(path: string, id: number): { id: number; at: number; content: string } {
    const v = this.db
      .query<{ id: number; at: number; content: string }, [number, string]>("SELECT id, at, content FROM versions WHERE id = ? AND path = ?")
      .get(id, cleanPath(path, "note"));
    if (!v) throw new VaultError(404, "no such version");
    return v;
  }

  /** A note's title from the index, without reading the file. */
  title(path: string): string | undefined {
    return this.db.query<{ title: string }, [string]>("SELECT title FROM notes WHERE path = ?").get(path)?.title;
  }

  private row(path: string) {
    return this.db.query<Row, [string]>("SELECT path, title, tags, mtime, size, hash, pinned, color FROM notes WHERE path = ?").get(path);
  }

  /** Finds an attachment by vault path or, for `![[name.png]]`, by file name (attachments/ first). */
  resolveFile(ref: string): string | null {
    const direct = ref.includes("/") ? ref : `${ATTACHMENTS}/${ref}`;
    try {
      const path = cleanPath(direct, "file");
      if (this.files.get(basename(path).toLowerCase())?.includes(path)) return path;
    } catch {}
    return this.files.get(basename(ref).toLowerCase())?.[0] ?? null;
  }

  // ---- writing

  /**
   * Saves a note. `baseHash` is the hash the client last read: null means "create, must not exist";
   * a mismatch is a conflict and returns the file as it is now so the client can merge.
   */
  async write(path: string, content: string, baseHash: string | null, opts: { keepVersion?: boolean } = {}): Promise<NoteMeta> {
    path = cleanPath(path, "note");
    if (Buffer.byteLength(content) > MAX_NOTE_BYTES) throw new VaultError(413, "note too large");
    const abs = await this.abs(path);
    try {
      const current = await readFile(abs, "utf8").catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      if (current === null && baseHash !== null) throw new VaultError(409, "note was deleted");
      if (current !== null) {
        if (baseHash === null) throw new VaultError(409, "note already exists");
        const hash = sha256(current);
        if (hash !== baseHash || current === content) {
          const st = await stat(abs);
          const m = this.index(path, current, st.size, Math.floor(st.mtimeMs), hash);
          if (hash !== baseHash) throw new VaultError(409, "note changed since it was read", { ...m, content: current });
          return m;
        }
      }
      if (current !== null && !isBoard(path)) this.snapshot(path, current, opts.keepVersion);
      await mkdir(dirname(abs), { recursive: true });
      await atomicWrite(abs, content);
      const st = await stat(abs);
      const m = this.index(path, content, st.size, Math.floor(st.mtimeMs));
      this.emit({ type: current === null ? "note.created" : "note.updated", path, source: "sink" });
      return m;
    } catch (err) {
      fsError(err, "note");
    }
  }

  /** New note in `folder` named after its title, numbered if the name is taken (`Title 1.md`, like Obsidian). */
  async create(folder: string, title: string, content: string): Promise<NoteMeta> {
    const dir = folder ? cleanPath(folder, "folder") : "";
    const name = fileNameFor(title);
    for (let n = 0; n < 1000; n++) {
      const path = `${dir ? dir + "/" : ""}${n ? `${name} ${n}` : name}.md`;
      try {
        return await this.write(path, content, null);
      } catch (err) {
        if (!(err instanceof VaultError && err.status === 409)) throw err;
      }
    }
    throw new VaultError(409, "too many notes with that name");
  }

  /** Renames a note or a whole folder. Never overwrites. Links to it are not rewritten (yet). */
  async move(from: string, to: string): Promise<void> {
    const isNote = from.toLowerCase().endsWith(".md");
    from = cleanPath(from, isNote ? "note" : "folder");
    to = cleanPath(to, isNote ? "note" : "folder");
    if (to === from) return;
    if (!isNote && to.startsWith(from + "/")) throw new VaultError(400, "can't move a folder into itself");
    try {
      const [src, dest] = [await this.abs(from), await this.abs(to)];
      const st = await stat(src);
      // On a case-insensitive share (SMB, macOS) "shopping.md" -> "Shopping.md" finds the note itself at dest.
      const there = await stat(dest).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      const sameFile = there && to.toLowerCase() === from.toLowerCase() && there.ino === st.ino && there.dev === st.dev;
      if (there && !sameFile) throw new VaultError(409, "destination already exists");
      await mkdir(dirname(dest), { recursive: true });
      await rename(src, dest);
    } catch (err) {
      fsError(err, isNote ? "note" : "folder");
    }
    const moved = isNote
      ? [from]
      : this.db
          .query<{ path: string }, [number, string]>("SELECT path FROM notes WHERE substr(path, 1, ?) = ?")
          .all(from.length + 1, from + "/")
          .map((r) => r.path);
    this.db.transaction(() => {
      // Version history and share links aren't tied to the notes table (they outlive a note's row), so they move here too.
      for (const table of ["notes", "versions", "shares"]) {
        if (isNote) this.db.query(`UPDATE ${table} SET path = ? WHERE path = ?`).run(to, from);
        else
          this.db
            .query(`UPDATE ${table} SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?`)
            .run(to, from.length + 1, from.length + 1, from + "/");
      }
    })();
    if (!isNote) {
      this.folders = new Set([...this.folders].map((f) => (f === from ? to : f.startsWith(from + "/") ? to + f.slice(from.length) : f)));
    }
    for (let d = dirname(to); d !== "."; d = dirname(d)) this.folders.add(d);
    for (const old of moved) this.emit({ type: "note.moved", path: isNote ? to : to + old.slice(from.length), from: old, source: "sink" });
    // Links to what moved follow it, as in Obsidian. A failure here leaves a link stale, never the move undone.
    for (const old of moved) {
      await this.relink(old, isNote ? to : to + old.slice(from.length)).catch((err) =>
        console.warn(`[notes] couldn't update links to ${old}: ${(err as Error).message}`),
      );
    }
  }

  /**
   * After a note moved from `from` to `to`, rewrites links to it in other notes: `[[Folder/Name]]` and markdown
   * links by path always; `[[Name]]` by name only when it was renamed and no other note has its old name (else
   * the link may mean that one). Headings and aliases are kept. Titles used as links are left alone.
   */
  private async relink(from: string, to: string) {
    const oldFull = from.replace(/\.md$/i, "").toLowerCase();
    const parts = oldFull.split("/");
    const oldName = parts.at(-1)!;
    const newFull = to.replace(/\.md$/i, "");
    const newName = newFull.split("/").pop()!;
    const renamed = newName.toLowerCase() !== oldName;
    const nameIsOurs = !this.db
      .query<{ n: number }, [string, string, string, string]>(
        "SELECT count(*) AS n FROM notes WHERE path != ? AND (lower(path) = ? OR substr(lower(path), -length(?)) = ?)",
      )
      .get(to, `${oldName}.md`, `/${oldName}.md`, `/${oldName}.md`)!.n;
    const refs = parts.map((_, i) => parts.slice(i).join("/"));
    const srcs = this.db
      .query<{ src: string }, string[]>(`SELECT DISTINCT src FROM links WHERE target IN (${refs.map(() => "?").join(", ")})`)
      .all(...refs)
      .map((r) => r.src);
    for (const src of srcs) {
      const note = await this.read(src);
      const next = rewriteLinks(note.content, { oldFull, oldName, newFull, newName, byName: renamed && nameIsOurs });
      if (next !== note.content) await this.write(src, next, note.hash);
    }
  }

  /** Moves a note or folder into `.trash/`, keeping its path there (Obsidian's "move to .trash" behaviour). */
  async trash(path: string): Promise<{ trashed_to: string }> {
    const isNote = path.toLowerCase().endsWith(".md");
    path = cleanPath(path, isNote ? "note" : "folder");
    let dest = `${TRASH}/${path}`;
    try {
      const src = await this.abs(path);
      await this.abs(TRASH);
      await stat(src);
      for (let n = 1; await exists(join(this.dir, dest)); n++) {
        const ext = extname(path);
        dest = `${TRASH}/${isNote ? path.slice(0, -ext.length) : path} ${n}${isNote ? ext : ""}`;
      }
      // Inside the vault even if something in .trash is a symlink (a sync tool or another app could have put one there).
      await this.abs(dirname(dest));
      await mkdir(dirname(join(this.dir, dest)), { recursive: true });
      await this.abs(dirname(dest));
      await rename(src, join(this.dir, dest));
    } catch (err) {
      fsError(err, isNote ? "note" : "folder");
    }
    const gone = isNote
      ? [path]
      : this.db
          .query<{ path: string }, [number, string]>("SELECT path FROM notes WHERE substr(path, 1, ?) = ?")
          .all(path.length + 1, path + "/")
          .map((r) => r.path);
    this.db.query("INSERT OR REPLACE INTO trash (path, original, at) VALUES (?, ?, ?)").run(dest.slice(TRASH.length + 1), path, now());
    for (const p of gone) this.emit({ type: "note.deleted", path: p, source: "sink" });
    if (isNote) this.unindex(path);
    else {
      this.db.query("DELETE FROM notes WHERE substr(path, 1, ?) = ?").run(path.length + 1, path + "/");
      for (const f of this.folders) if (f === path || f.startsWith(path + "/")) this.folders.delete(f);
    }
    return { trashed_to: dest };
  }

  // ---- trash

  private trashRows() {
    return this.db.query<TrashRow, []>("SELECT path, original, at FROM trash").all();
  }

  /** A path inside the trash from a client, with or without the `.trash/` prefix. */
  private trashPath(raw: string): string {
    return cleanPath(raw.trim().replace(/^\/*\.trash\//, ""), "note");
  }

  /** Every note in `.trash/`, newest deletion first. Notes Obsidian trashed are listed too (dated by ctime). */
  async listTrash(): Promise<TrashedNote[]> {
    const rows = this.trashRows();
    const out: TrashedNote[] = [];
    const walk = async (rel: string) => {
      const entries = await readdir(join(this.dir, TRASH, rel), { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return [];
        throw err;
      });
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path);
        if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
        try {
          cleanPath(path, "note");
        } catch {
          continue;
        }
        const abs = join(this.dir, TRASH, path);
        const st = await stat(abs);
        const content = st.size > MAX_NOTE_BYTES ? "" : await readFile(abs, "utf8");
        const { title, body } = parseNote(path, content);
        const from = trashOrigin(rows, path);
        out.push({
          path,
          original: from?.original ?? path,
          title,
          excerpt: isBoard(path) ? "" : cardText(body, title).slice(0, 200),
          deleted_at: from?.at ?? Math.floor(st.ctimeMs),
          size: st.size,
          ...(from && from.row !== path && { folder: from.row }),
        });
      }
    };
    try {
      await this.abs(TRASH);
      await walk("");
    } catch (err) {
      fsError(err, "trash");
    }
    return out.sort((a, b) => b.deleted_at - a.deleted_at);
  }

  /**
   * Puts a whole trashed folder back where it was (numbered if that name is taken now), indexing every note in it.
   * Returns the folder's path.
   */
  async restoreFolder(trashPath: string): Promise<{ path: string; notes: number }> {
    const rel = cleanPath(trashPath.trim().replace(/^\/*\.trash\//, ""), "folder");
    const from = trashOrigin(this.trashRows(), rel);
    const original = cleanPath(from?.original ?? rel, "folder");
    let dest = original;
    const restored: string[] = [];
    try {
      const src = await this.abs(`${TRASH}/${rel}`);
      if (!(await stat(src)).isDirectory()) throw new VaultError(400, "not a folder");
      for (let n = 1; await exists(await this.abs(dest)); n++) dest = `${original} ${n}`;
      await mkdir(dirname(await this.abs(dest)), { recursive: true });
      await rename(src, await this.abs(dest));
      await this.tidyTrash(dirname(rel), from?.row);
      // Index what came back, the way a scan would, but as Sink's own change.
      const walk = async (folder: string) => {
        this.folders.add(folder);
        for (const e of await readdir(await this.abs(folder), { withFileTypes: true })) {
          if (e.name.startsWith(".")) continue;
          const path = `${folder}/${e.name}`;
          if (e.isDirectory()) await walk(path);
          else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
            const abs = await this.abs(path);
            const st = await stat(abs);
            if (st.size > MAX_NOTE_BYTES) continue;
            this.index(path, await readFile(abs, "utf8"), st.size, Math.floor(st.mtimeMs));
            restored.push(path);
          }
        }
      };
      await walk(dest);
      for (let d = dirname(dest); d !== "."; d = dirname(d)) this.folders.add(d);
    } catch (err) {
      fsError(err, "folder");
    }
    for (const path of restored) this.emit({ type: "note.created", path, source: "sink" });
    return { path: dest, notes: restored.length };
  }

  /** Puts a trashed note back where it was (numbered if that name is taken now) and indexes it again. */
  async restore(trashPath: string): Promise<NoteMeta> {
    const rel = this.trashPath(trashPath);
    const from = trashOrigin(this.trashRows(), rel);
    const original = cleanPath(from?.original ?? rel, "note");
    try {
      const src = await this.abs(`${TRASH}/${rel}`);
      await stat(src);
      const ext = original.toLowerCase().endsWith(".excalidraw.md") ? ".excalidraw.md" : ".md";
      const stem = original.slice(0, -ext.length);
      let dest = original;
      for (let n = 1; await exists(await this.abs(dest)); n++) dest = `${stem} ${n}${ext}`;
      await mkdir(dirname(await this.abs(dest)), { recursive: true });
      await rename(src, await this.abs(dest));
      await this.tidyTrash(dirname(rel), from?.row);
      const content = await readFile(await this.abs(dest), "utf8");
      const st = await stat(await this.abs(dest));
      const m = this.index(dest, content, st.size, Math.floor(st.mtimeMs));
      this.emit({ type: "note.created", path: dest, source: "sink" });
      return m;
    } catch (err) {
      fsError(err, "note");
    }
  }

  /** Deletes one trashed note for good. */
  async deleteForever(trashPath: string): Promise<void> {
    const rel = this.trashPath(trashPath);
    try {
      const abs = await this.abs(`${TRASH}/${rel}`);
      await stat(abs);
      await rm(abs);
    } catch (err) {
      fsError(err, "note");
    }
    await this.tidyTrash(dirname(rel), trashOrigin(this.trashRows(), rel)?.row);
  }

  /** Empties `.trash/` completely, including anything Obsidian put there. */
  async emptyTrash(): Promise<void> {
    try {
      const root = await this.abs(TRASH);
      for (const e of await readdir(root).catch(() => [] as string[])) await rm(join(root, e), { recursive: true, force: true });
    } catch (err) {
      fsError(err, "trash");
    }
    this.db.query("DELETE FROM trash").run();
  }

  /** Deletes what Sink trashed more than `days` ago. Things Obsidian or a person put in .trash/ are left alone. */
  async purgeTrash(days: number, at = now()): Promise<number> {
    if (days <= 0) return 0;
    // History of notes that have been gone (not in the index) for as long as the trash keeps things.
    this.db
      .query("DELETE FROM versions WHERE path NOT IN (SELECT path FROM notes) AND at < ?")
      .run(at - days * 24 * 60 * 60 * 1000);
    const old = this.db
      .query<{ path: string }, [number]>("SELECT path FROM trash WHERE at < ?")
      .all(at - days * 24 * 60 * 60 * 1000);
    let purged = 0;
    for (const { path } of old) {
      try {
        const abs = await this.abs(`${TRASH}/${path}`);
        if (await exists(abs)) purged++;
        await rm(abs, { recursive: true, force: true });
        await this.tidyTrash(dirname(path), path);
      } catch (err) {
        console.warn(`[notes] couldn't purge .trash/${path}: ${(err as Error).message}`);
      }
    }
    return purged;
  }

  /**
   * Removes folders left empty in the trash, from `rel` up (never .trash itself), then forgets `row` (the trashed
   * note or folder a change came from) once nothing of it is left.
   */
  private async tidyTrash(rel: string, row?: string) {
    for (let d = rel; d && d !== "."; d = dirname(d)) {
      try {
        await rmdir(join(this.dir, TRASH, d));
      } catch {
        break;
      }
    }
    if (row && !(await exists(join(this.dir, TRASH, row)))) this.db.query("DELETE FROM trash WHERE path = ?").run(row);
  }

  async createFolder(path: string): Promise<string> {
    path = cleanPath(path, "folder");
    try {
      await mkdir(await this.abs(path), { recursive: true });
    } catch (err) {
      fsError(err, "folder");
    }
    for (let d = path; d !== "."; d = dirname(d)) this.folders.add(d);
    return path;
  }

  /** Stores an uploaded file in `attachments/` under a free name. Returns its vault path. */
  async saveAttachment(name: string, bytes: Uint8Array): Promise<string> {
    const ext = extname(name).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
    const stem = fileNameFor(basename(name, extname(name))).slice(0, 80);
    try {
      await mkdir(await this.abs(ATTACHMENTS), { recursive: true });
      for (let n = 0; n < 1000; n++) {
        const path = `${ATTACHMENTS}/${n ? `${stem} ${n}` : stem}${ext}`;
        try {
          await writeFile(join(this.dir, path), bytes, { flag: "wx" });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw err;
        }
        const key = basename(path).toLowerCase();
        this.files.set(key, [...(this.files.get(key) ?? []), path]);
        this.folders.add(ATTACHMENTS);
        return path;
      }
    } catch (err) {
      fsError(err, "attachment");
    }
    throw new VaultError(409, "too many attachments with that name");
  }

  /**
   * Every file in the vault (notes, attachments, anything else), for an export. Hidden folders (.trash, .obsidian)
   * and symlinks are left out, as the scan leaves them.
   */
  async *allFiles(): AsyncGenerator<{ path: string; data: Uint8Array; mtime: Date }> {
    const walk = async function* (this: Vault, rel: string): AsyncGenerator<{ path: string; data: Uint8Array; mtime: Date }> {
      const entries = await readdir(rel ? join(this.dir, rel) : this.dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) yield* walk.call(this, path);
        else if (e.isFile()) {
          const abs = await this.abs(path);
          const st = await stat(abs);
          yield { path, data: await readFile(abs), mtime: st.mtime };
        }
      }
    };
    yield* walk.call(this, "");
  }

  async readFile(path: string): Promise<Uint8Array> {
    path = cleanPath(path, "file");
    try {
      return await readFile(await this.abs(path));
    } catch (err) {
      fsError(err, "file");
    }
  }
}

/**
 * What changed in the vault, for plugins. `source` says whether Sink made the change or a scan found it
 * (Obsidian, Syncthing, a file manager).
 */
export type VaultEvent =
  | { type: "note.created" | "note.updated" | "note.deleted"; path: string; source: "sink" | "external" }
  | { type: "note.moved"; path: string; from: string; source: "sink" }
  | { type: "todo.done" | "todo.undone"; path: string; text: string; source: "sink" };

export type ScanResult = { added: number; updated: number; removed: number; notes: number };

const meta = ({ excerpt: _, snippet: __, ...r }: Row & { excerpt?: string; snippet?: string }): NoteMeta => ({
  ...r,
  tags: JSON.parse(r.tags) as string[],
  pinned: r.pinned === 1,
});
type TrashRow = { path: string; original: string; at: number };

/** Where a note in the trash came from: its own row, or the row of the folder it was trashed with. */
function trashOrigin(rows: TrashRow[], rel: string): { row: string; original: string; at: number } | null {
  for (const r of rows) {
    if (r.path === rel) return { row: r.path, original: r.original, at: r.at };
    if (rel.startsWith(r.path + "/")) return { row: r.path, original: r.original + rel.slice(r.path.length), at: r.at };
  }
  return null;
}

const exists = (abs: string) =>
  stat(abs).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return false;
      throw err;
    },
  );

/** Temp file beside the target, then rename: a crash or NAS drop never leaves half a note. */
async function atomicWrite(abs: string, content: string) {
  const tmp = join(dirname(abs), `.${basename(abs)}.${crypto.randomUUID().slice(0, 8)}.sink-tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
