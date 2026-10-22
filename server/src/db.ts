import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const migrations: string[] = [
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
];

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  for (let i = version; i < migrations.length; i++) {
    db.transaction(() => {
      db.exec(migrations[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
  }
  return db;
}

export const now = () => Date.now();
export const newId = () => Bun.randomUUIDv7();
