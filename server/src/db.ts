import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const migrations: string[] = [
  `
  CREATE TABLE captures (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    client_id TEXT UNIQUE,
    source TEXT NOT NULL,
    app_package TEXT,
    image_path TEXT NOT NULL,
    thumb_path TEXT NOT NULL,
    mime TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    note_text TEXT,
    ocr_text TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    kind TEXT,
    title TEXT,
    summary TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    entities TEXT NOT NULL DEFAULT '{}',
    model TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    reviewed_at INTEGER,
    archived_at INTEGER,
    deleted_at INTEGER
  );
  CREATE INDEX captures_created ON captures(created_at DESC);
  CREATE INDEX captures_kind ON captures(kind);

  CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'suggested',
    due_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX actions_capture ON actions(capture_id);

  CREATE TABLE collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE capture_collections (
    capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    PRIMARY KEY (capture_id, collection_id)
  );

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    run_after INTEGER NOT NULL,
    last_error TEXT
  );
  CREATE INDEX jobs_due ON jobs(run_after);

  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE VIRTUAL TABLE captures_fts USING fts5(
    title, summary, note_text, ocr_text, tags,
    content='captures', content_rowid='rowid',
    tokenize='porter unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER captures_ai AFTER INSERT ON captures BEGIN
    INSERT INTO captures_fts(rowid, title, summary, note_text, ocr_text, tags)
    VALUES (new.rowid, new.title, new.summary, new.note_text, new.ocr_text, new.tags);
  END;
  CREATE TRIGGER captures_ad AFTER DELETE ON captures BEGIN
    INSERT INTO captures_fts(captures_fts, rowid, title, summary, note_text, ocr_text, tags)
    VALUES ('delete', old.rowid, old.title, old.summary, old.note_text, old.ocr_text, old.tags);
  END;
  CREATE TRIGGER captures_au AFTER UPDATE OF title, summary, note_text, ocr_text, tags ON captures BEGIN
    INSERT INTO captures_fts(captures_fts, rowid, title, summary, note_text, ocr_text, tags)
    VALUES ('delete', old.rowid, old.title, old.summary, old.note_text, old.ocr_text, old.tags);
    INSERT INTO captures_fts(rowid, title, summary, note_text, ocr_text, tags)
    VALUES (new.rowid, new.title, new.summary, new.note_text, new.ocr_text, new.tags);
  END;
  `,
  // Same screenshot arriving twice (auto-import + share with a note) merges into one capture.
  `
  ALTER TABLE captures ADD COLUMN sha256 TEXT;
  CREATE INDEX captures_sha256 ON captures(sha256);
  `,
  // authentik replaced the shared password; tokens remember which account they belong to.
  `
  ALTER TABLE tokens ADD COLUMN subject TEXT;
  DELETE FROM tokens;
  `,
  // Semantic search: one embedding per capture, tagged with the model that made it.
  `
  CREATE TABLE capture_vectors (
    capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    vec BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // Assistant captures know which page they came from.
  `
  ALTER TABLE captures ADD COLUMN source_url TEXT;
  `,
  // Price watch: opt-in per product capture, checked on a timer, history kept for the detail view.
  `
  CREATE TABLE price_watches (
    capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    currency TEXT,
    first_price REAL,
    last_price REAL,
    lowest_price REAL,
    last_checked_at INTEGER,
    next_check_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX price_watches_due ON price_watches(next_check_at);
  CREATE TABLE price_points (
    capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    price REAL NOT NULL
  );
  CREATE INDEX price_points_capture ON price_points(capture_id, at);
  `,
  // OAuth for MCP connectors: registered clients and refresh tokens (revoking the access token drops its refresh).
  `
  CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    secret_hash TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_refresh (
    token_hash TEXT PRIMARY KEY,
    token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  `,
  // Captures without a screenshot (notes and links saved by assistants): image columns become optional.
  // SQLite can't drop NOT NULL in place, so rebuild the table, keeping rowids for the FTS index.
  `
  CREATE TABLE captures_new (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    client_id TEXT UNIQUE,
    source TEXT NOT NULL,
    app_package TEXT,
    image_path TEXT,
    thumb_path TEXT,
    mime TEXT,
    width INTEGER,
    height INTEGER,
    note_text TEXT,
    ocr_text TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    kind TEXT,
    title TEXT,
    summary TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    entities TEXT NOT NULL DEFAULT '{}',
    model TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    reviewed_at INTEGER,
    archived_at INTEGER,
    deleted_at INTEGER,
    sha256 TEXT,
    source_url TEXT
  );
  INSERT INTO captures_new (rowid, id, created_at, updated_at, client_id, source, app_package, image_path, thumb_path,
    mime, width, height, note_text, ocr_text, status, error, kind, title, summary, tags, entities, model, pinned,
    reviewed_at, archived_at, deleted_at, sha256, source_url)
  SELECT rowid, id, created_at, updated_at, client_id, source, app_package, image_path, thumb_path,
    mime, width, height, note_text, ocr_text, status, error, kind, title, summary, tags, entities, model, pinned,
    reviewed_at, archived_at, deleted_at, sha256, source_url FROM captures;
  DROP TABLE captures;
  ALTER TABLE captures_new RENAME TO captures;
  CREATE INDEX captures_created ON captures(created_at DESC);
  CREATE INDEX captures_kind ON captures(kind);
  CREATE INDEX captures_sha256 ON captures(sha256);
  CREATE TRIGGER captures_ai AFTER INSERT ON captures BEGIN
    INSERT INTO captures_fts(rowid, title, summary, note_text, ocr_text, tags)
    VALUES (new.rowid, new.title, new.summary, new.note_text, new.ocr_text, new.tags);
  END;
  CREATE TRIGGER captures_ad AFTER DELETE ON captures BEGIN
    INSERT INTO captures_fts(captures_fts, rowid, title, summary, note_text, ocr_text, tags)
    VALUES ('delete', old.rowid, old.title, old.summary, old.note_text, old.ocr_text, old.tags);
  END;
  CREATE TRIGGER captures_au AFTER UPDATE OF title, summary, note_text, ocr_text, tags ON captures BEGIN
    INSERT INTO captures_fts(captures_fts, rowid, title, summary, note_text, ocr_text, tags)
    VALUES ('delete', old.rowid, old.title, old.summary, old.note_text, old.ocr_text, old.tags);
    INSERT INTO captures_fts(rowid, title, summary, note_text, ocr_text, tags)
    VALUES (new.rowid, new.title, new.summary, new.note_text, new.ocr_text, new.tags);
  END;
  `,
  // Notes: an index of the markdown vault (the files on the NAS are the truth), and captures promoted into it.
  `
  CREATE TABLE notes (
    path TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    body TEXT NOT NULL,
    hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL
  );
  CREATE INDEX notes_mtime ON notes(mtime DESC);
  CREATE VIRTUAL TABLE notes_fts USING fts5(
    path, title, body, tags,
    content='notes', content_rowid='rowid',
    tokenize='porter unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, path, title, body, tags) VALUES (new.rowid, new.path, new.title, new.body, new.tags);
  END;
  CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, path, title, body, tags) VALUES ('delete', old.rowid, old.path, old.title, old.body, old.tags);
  END;
  CREATE TRIGGER notes_au AFTER UPDATE OF path, title, body, tags ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, path, title, body, tags) VALUES ('delete', old.rowid, old.path, old.title, old.body, old.tags);
    INSERT INTO notes_fts(rowid, path, title, body, tags) VALUES (new.rowid, new.path, new.title, new.body, new.tags);
  END;
  ALTER TABLE captures ADD COLUMN note_path TEXT;
  `,
  // Todos: checkbox lines found in notes, re-read whenever their note is indexed. Moves and deletes follow the note.
  `
  CREATE TABLE todos (
    path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE ON UPDATE CASCADE,
    line INTEGER NOT NULL,
    raw TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    due TEXT,
    remind_at INTEGER,
    done_on TEXT,
    PRIMARY KEY (path, line)
  );
  CREATE INDEX todos_open ON todos(status, due);
  `,
  // Keep-style pin and card colour, read from frontmatter. mtime 0 makes the next scan re-read every note.
  `
  ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE notes ADD COLUMN color TEXT;
  UPDATE notes SET mtime = 0;
  `,
  // Emails already filed, so a failed move out of the inbox can't file them twice after a restart.
  `
  CREATE TABLE email_seen (message_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `,
  // Sink is notes only now: the screenshot inbox (captures, AI actions, collections, price watch, embeddings) goes.
  `
  DROP TABLE IF EXISTS price_points;
  DROP TABLE IF EXISTS price_watches;
  DROP TABLE IF EXISTS capture_vectors;
  DROP TABLE IF EXISTS capture_collections;
  DROP TABLE IF EXISTS collections;
  DROP TABLE IF EXISTS actions;
  DROP TABLE IF EXISTS jobs;
  DROP TRIGGER IF EXISTS captures_ai;
  DROP TRIGGER IF EXISTS captures_ad;
  DROP TRIGGER IF EXISTS captures_au;
  DROP TABLE IF EXISTS captures_fts;
  DROP TABLE IF EXISTS captures;
  `,
  // What a token may do: "full" (browsers, the phone) or "mcp" (AI assistants: notes and todos only, never other tokens).
  `
  ALTER TABLE tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'full';
  UPDATE tokens SET scope = 'mcp' WHERE name LIKE '% (MCP)';
  `,
  // What Sink moved to .trash/ and when, so the trash can be listed, restored and emptied after a while.
  // Paths are inside .trash/; anything put there by Obsidian or by hand has no row and is never purged.
  `
  CREATE TABLE trash (path TEXT PRIMARY KEY, original TEXT NOT NULL, at INTEGER NOT NULL);
  `,
  // Links between notes, for backlinks: one row per line that links somewhere, frontmatter included. `target` is the
  // link as written, normalised (lower case, no .md or #heading). mtime 0 re-reads every note to fill it.
  `
  CREATE TABLE links (
    src TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE ON UPDATE CASCADE,
    target TEXT NOT NULL,
    line TEXT NOT NULL
  );
  CREATE INDEX links_target ON links(target);
  CREATE INDEX links_src ON links(src);
  UPDATE notes SET mtime = 0;
  `,
  // Version history: a note's text as it was before Sink overwrote it, at most one per note every few minutes.
  // Lives here (the data dir), not in the vault, so Obsidian and sync tools never see it.
  `
  CREATE TABLE versions (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE ON UPDATE CASCADE,
    at INTEGER NOT NULL,
    content TEXT NOT NULL
  );
  CREATE INDEX versions_path ON versions(path, at DESC);
  `,
  // Versions outlive their index row: a note in the trash (or briefly missing on a flaky share) keeps its history,
  // and a save never fails on it. Moves update the path; the trash purge drops versions of notes long gone.
  `
  CREATE TABLE versions_new (id INTEGER PRIMARY KEY, path TEXT NOT NULL, at INTEGER NOT NULL, content TEXT NOT NULL);
  INSERT INTO versions_new SELECT id, path, at, content FROM versions;
  DROP TABLE versions;
  ALTER TABLE versions_new RENAME TO versions;
  CREATE INDEX versions_path ON versions(path, at DESC);
  `,
  // OAuth access tokens expire (an hour; refresh gets a new one). Null: until revoked (devices, hand-made tokens).
  `
  ALTER TABLE tokens ADD COLUMN expires_at INTEGER;
  `,
  // Share links (routes/share.ts): one per shared note, by a random id. Not tied to the notes row, so a share
  // survives the note going to the trash and back; moves update the path.
  `
  CREATE TABLE shares (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
  `,
  // Tasks priority (0 highest .. 3 none .. 5 lowest) and start/scheduled dates. mtime 0 re-reads every note.
  `
  ALTER TABLE todos ADD COLUMN priority INTEGER NOT NULL DEFAULT 3;
  ALTER TABLE todos ADD COLUMN start TEXT;
  ALTER TABLE todos ADD COLUMN scheduled TEXT;
  UPDATE notes SET mtime = 0;
  `,
];

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  // Foreign keys stay off while migrating so a table rebuild doesn't cascade-delete its children.
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  for (let i = version; i < migrations.length; i++) {
    db.transaction(() => {
      db.exec(migrations[i]!);
      if (db.query("PRAGMA foreign_key_check").all().length) throw new Error(`migration ${i + 1} broke foreign keys`);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
  }
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export const now = () => Date.now();
export const newId = () => Bun.randomUUIDv7();
