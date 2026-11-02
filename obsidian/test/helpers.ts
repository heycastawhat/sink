import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "../../server/src/app";
import { Auth } from "../../server/src/auth";
import { openDb } from "../../server/src/db";
import { Oidc } from "../../server/src/oidc";
import { Users } from "../../server/src/users";
import { Vault } from "../../server/src/notes";
import { SinkApi, type Http } from "../src/api";
import { SyncEngine, emptyState, type Local, type LocalFile, type SyncState } from "../src/engine";
import { syncable } from "../src/paths";

/** A real Sink server in this process: Hono app, SQLite in memory, a temp vault. */
export function server() {
  const db = openDb(":memory:");
  const vaultDir = mkdtempSync(join(tmpdir(), "sink-srv-"));
  const vault = new Vault(db, vaultDir);
  const auth = new Auth(db);
  const oidc = new Oidc({ issuer: "https://auth.test/", clientId: "c", clientSecret: "", allowedUsers: [], allowedGroups: [], allowAnyone: true });
  const users = new Users(db, { db, vault }, { dir: mkdtempSync(join(tmpdir(), "sink-users-")) });
  const app = createApp({
    db,
    vault,
    users,
    auth,
    oidc,
    config: { secureCookies: false, maxUploadBytes: 5 * 1024 * 1024, webDir: undefined, publicUrls: ["https://sink.test"] },
  });
  const token = auth.issueToken("test", "owner");
  let clock = Date.now();
  const bump = (abs: string) => utimesSync(abs, new Date((clock += 2000)), new Date(clock));
  return {
    app,
    vault,
    vaultDir,
    token,
    auth,
    /** An edit made on the server's disk (the NAS, Syncthing, Obsidian on another machine), found by its scan. */
    async edit(path: string, content: string | Uint8Array) {
      mkdirSync(dirname(join(vaultDir, path)), { recursive: true });
      writeFileSync(join(vaultDir, path), content);
      bump(join(vaultDir, path));
      await vault.scan();
    },
    async remove(path: string) {
      (await import("node:fs")).rmSync(join(vaultDir, path));
      await vault.scan();
    },
    read: (path: string) => readFileSync(join(vaultDir, path), "utf8"),
    has: (path: string) => existsSync(join(vaultDir, path)),
    /** Everything the server's vault holds, notes and files, outside hidden folders. */
    paths: () => [...walk(vaultDir)].sort(),
  };
}

export type Server = ReturnType<typeof server>;

function* walk(dir: string, rel = ""): Generator<string> {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith(".") && !rel.startsWith(".")) continue;
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(dir, path);
    else yield path;
  }
}

/** `requestUrl` stand-in: the same request, answered by the in-process server. `before` can interfere first. */
export function bridge(s: Server, before?: (req: Parameters<Http>[0]) => void | Promise<void>): Http {
  return async (req) => {
    await before?.(req);
    const u = new URL(req.url);
    const res = await s.app.request(u.pathname + u.search, {
      method: req.method,
      headers: { ...req.headers, ...(req.contentType && { "content-type": req.contentType }) },
      body: req.body,
    });
    const arrayBuffer = await res.arrayBuffer();
    return { status: res.status, arrayBuffer, text: new TextDecoder().decode(arrayBuffer) };
  };
}

/** A vault folder on disk, standing in for Obsidian's: trash goes to `.trash/`, like its "move to .trash" setting. */
export class DirLocal implements Local {
  dir = mkdtempSync(join(tmpdir(), "sink-vault-"));
  /** Runs just before a write, to play someone editing at that moment. */
  beforeWrite?: (path: string) => void;
  private clock = Date.now();

  private abs = (path: string) => join(this.dir, path);

  /** A user's edit: new text with a new mtime, as an editor would leave it. */
  edit(path: string, content: string | Uint8Array) {
    mkdirSync(dirname(this.abs(path)), { recursive: true });
    writeFileSync(this.abs(path), content);
    utimesSync(this.abs(path), new Date((this.clock += 2000)), new Date(this.clock));
  }

  rename(from: string, to: string) {
    mkdirSync(dirname(this.abs(to)), { recursive: true });
    renameSync(this.abs(from), this.abs(to));
  }

  read = (path: string) => readFileSync(this.abs(path), "utf8");
  has = (path: string) => existsSync(this.abs(path));
  /** Every synced-looking file in the vault, sorted. */
  paths = () => [...walk(this.dir)].sort();
  /** What's been moved to the vault's trash. */
  trashed = () => (this.has(".trash") ? [...walk(this.dir, ".trash")].sort() : []);

  async list(): Promise<LocalFile[]> {
    return this.paths().filter(syncable).map((path) => ({ path, ...this.statSync(path) }));
  }

  private statSync(path: string) {
    const st = statSync(this.abs(path));
    return { mtime: Math.floor(st.mtimeMs), size: st.size };
  }

  async stat(path: string) {
    return this.statSync(path);
  }

  async readText(path: string) {
    return this.read(path);
  }

  async readBytes(path: string) {
    const b = readFileSync(this.abs(path));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }

  async writeText(path: string, text: string, before: string | null) {
    this.beforeWrite?.(path);
    if (before === null ? this.has(path) : !this.has(path) || this.read(path) !== before) return false;
    mkdirSync(dirname(this.abs(path)), { recursive: true });
    writeFileSync(this.abs(path), text);
    return true;
  }

  async writeBytes(path: string, bytes: ArrayBuffer, before: ArrayBuffer | null) {
    this.beforeWrite?.(path);
    if (before === null ? this.has(path) : !this.has(path) || Buffer.compare(readFileSync(this.abs(path)), Buffer.from(before)) !== 0) return false;
    mkdirSync(dirname(this.abs(path)), { recursive: true });
    writeFileSync(this.abs(path), Buffer.from(bytes));
    return true;
  }

  async trash(path: string) {
    mkdirSync(dirname(join(this.dir, ".trash", path)), { recursive: true });
    renameSync(this.abs(path), join(this.dir, ".trash", path));
  }
}

/** One device: a local vault, the state the plugin would keep in data.json, and an engine to sync them. */
export function device(s: Server, opts: { http?: Http; date?: () => string } = {}) {
  const local = new DirLocal();
  const state: SyncState = emptyState();
  const http = opts.http ?? bridge(s);
  return {
    local,
    state,
    sync: (o: { scan?: boolean; confirmDeletes?: boolean } = {}) =>
      new SyncEngine(local, new SinkApi("https://sink.test", s.token, http), state, { date: opts.date ?? (() => "2026-11-02") }).sync(o),
  };
}
