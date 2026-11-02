import { ApiError, AuthError, Conflict, OfflineError, type SinkApi } from "./api";
import { sha256, type Bytes } from "./hash";
import { conflictPath, isConflictCopy, isNote, syncable } from "./paths";
import { massDeletes, plan, type Hashes } from "./plan";

export type LocalFile = { path: string; mtime: number; size: number };

/**
 * The vault side, with paths as the server has them (the sync folder is the adapter's business). Writes say what the
 * file held when the engine last looked (`before`, null for "isn't there") and return false instead of writing if it
 * has changed since: an edit made while a sync runs is never overwritten.
 */
export interface Local {
  list(): Promise<LocalFile[]>;
  stat(path: string): Promise<{ mtime: number; size: number }>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<ArrayBuffer>;
  writeText(path: string, text: string, before: string | null): Promise<boolean>;
  writeBytes(path: string, bytes: ArrayBuffer, before: ArrayBuffer | null): Promise<boolean>;
  /** To the vault's own trash, as when the user deletes it. */
  trash(path: string): Promise<void>;
}

/** What the last sync left each path as. mtime and size are the local file's then, so an untouched file isn't read again. */
export type Tracked = { hash: string; mtime: number; size: number };
export type SyncState = { files: Record<string, Tracked>; renames: { from: string; to: string }[] };
export const emptyState = (): SyncState => ({ files: {}, renames: [] });

export type SyncResult = {
  pulled: number;
  pushed: number;
  deleted: number;
  /** Conflict copies made by this sync. */
  conflicts: string[];
  /** Conflict copies sitting in the vault now, made by this or an earlier sync. */
  conflictCopies: number;
  errors: { path: string; message: string }[];
  /** Deletions held back because there were suspiciously many; sync again with `confirmDeletes` to do them. */
  blocked: { local: number; remote: number } | null;
  offline: boolean;
};

type Options = { date?: () => string; save?: () => void; progress?: (done: number, total: number) => void };

/** Remembers a rename so the next sync can move the file on the server instead of deleting and re-uploading it. */
export function trackRename(state: SyncState, from: string, to: string) {
  const earlier = state.renames.find((r) => r.to === from);
  if (earlier) {
    earlier.to = to;
    if (earlier.from === earlier.to) state.renames.splice(state.renames.indexOf(earlier), 1);
  } else if (from !== to) state.renames.push({ from, to });
}

/** A folder rename is every synced file inside it moving. */
export function trackFolderRename(state: SyncState, from: string, to: string) {
  for (const path of Object.keys(state.files)) if (path.startsWith(from + "/")) trackRename(state, path, to + path.slice(from.length));
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function pool(jobs: (() => Promise<void>)[], size = 4) {
  let next = 0;
  let failed: { err: unknown } | null = null;
  const worker = async () => {
    while (!failed && next < jobs.length) {
      try {
        await jobs[next++]!();
      } catch (err) {
        failed = { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker));
  if (failed) throw (failed as { err: unknown }).err;
}

export class SyncEngine {
  /** Hash of each local file as of its mtime and size. */
  private seen = new Map<string, Tracked>();
  private taken = new Set<string>();
  private again = false;
  private result!: SyncResult;

  constructor(
    private local: Local,
    private api: SinkApi,
    private state: SyncState,
    private o: Options = {},
  ) {}

  /**
   * Brings both sides level: pulls what changed on the server, pushes what changed here. Up to three rounds, because
   * a round can leave more to do (a conflict copy to upload, a file that changed under it).
   */
  async sync(opts: { scan?: boolean; confirmDeletes?: boolean } = {}): Promise<SyncResult> {
    this.result = { pulled: 0, pushed: 0, deleted: 0, conflicts: [], conflictCopies: 0, errors: [], blocked: null, offline: false };
    try {
      if (opts.scan) await this.api.scan();
      for (let pass = 0; pass < 3 && (await this.round(opts)); pass++);
    } catch (err) {
      if (!(err instanceof OfflineError)) throw err;
      this.result.offline = true;
    }
    return this.result;
  }

  private async remote(): Promise<Map<string, string>> {
    const [notes, files] = await Promise.all([this.api.notes(), this.api.files()]);
    // A name the server lists but won't serve (put there by another sync tool) would fail on every pull.
    return new Map([...notes, ...files].filter((f) => syncable(f.path)).map((f) => [f.path, f.hash]));
  }

  private async hashes(files: LocalFile[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await pool(
      files.map((f) => async () => {
        const known = this.seen.get(f.path) ?? this.state.files[f.path];
        if (known && known.mtime === f.mtime && known.size === f.size) return void out.set(f.path, known.hash);
        const hash = await sha256(await this.read(f.path));
        this.seen.set(f.path, { hash, mtime: f.mtime, size: f.size });
        out.set(f.path, hash);
      }),
    );
    return out;
  }

  private read(path: string): Promise<Bytes> {
    return isNote(path) ? this.local.readText(path) : this.local.readBytes(path);
  }

  private write(path: string, content: Bytes, before: Bytes | null): Promise<boolean> {
    return typeof content === "string"
      ? this.local.writeText(path, content, before as string | null)
      : this.local.writeBytes(path, content, before as ArrayBuffer | null);
  }

  private track(path: string, hash: string, stat: { mtime: number; size: number }) {
    this.state.files[path] = { hash, mtime: stat.mtime, size: stat.size };
    this.seen.set(path, this.state.files[path]!);
  }

  /** Something changed under us; the next round looks again. */
  private skip() {
    this.again = true;
  }

  private async round(opts: { confirmDeletes?: boolean }): Promise<boolean> {
    this.again = false;
    const files = await this.local.list();
    const stats = new Map(files.map((f) => [f.path, f]));
    let remote = await this.remote();
    if (this.state.renames.length && (await this.applyRenames(stats, remote))) remote = await this.remote();
    const local = await this.hashes(files);
    this.result.conflictCopies = files.filter((f) => isConflictCopy(f.path)).length;
    for (const path of this.seen.keys()) if (!stats.has(path)) this.seen.delete(path);

    const synced: Hashes = new Map(Object.entries(this.state.files).map(([path, t]) => [path, t.hash]));
    const p = plan(local, remote, synced);
    const held = massDeletes(p, synced.size);
    if (!opts.confirmDeletes && (held.local || held.remote)) {
      this.result.blocked = held;
      if (held.local) p.deleteLocal = [];
      if (held.remote) p.deleteRemote = [];
    }
    this.taken = new Set([...local.keys(), ...remote.keys()]);

    for (const path of p.record) this.track(path, local.get(path)!, stats.get(path)!);
    for (const path of p.forget) delete this.state.files[path];

    const total = p.pull.length + p.push.length + p.conflict.length + p.deleteLocal.length + p.deleteRemote.length;
    let done = 0;
    const job = (path: string, fn: () => Promise<void>) => async () => {
      try {
        await fn();
      } catch (err) {
        if (err instanceof OfflineError || err instanceof AuthError) throw err;
        this.result.errors.push({ path, message: (err as Error).message });
      }
      this.o.progress?.(++done, total);
      this.o.save?.();
    };
    // Images before the notes that show them, so another device never sees a note without its picture.
    for (const notes of [false, true]) {
      const here = <T extends { path: string }>(items: T[]) => items.filter((i) => isNote(i.path) === notes);
      await pool([
        ...here(p.pull).map((x) => job(x.path, () => this.pull(x.path, x.local, remote.get(x.path)!))),
        ...here(p.push).map((x) => job(x.path, () => this.push(x.path, x.base, local.get(x.path)!, stats.get(x.path)!))),
        ...here(p.conflict).map((x) => job(x.path, () => this.conflict(x.path, x.local, x.remote))),
        ...here(p.deleteRemote).map((x) => job(x.path, () => this.deleteRemote(x.path))),
        ...here(p.deleteLocal).map((x) => job(x.path, () => this.deleteLocal(x.path, x.hash))),
      ]);
    }
    return this.again;
  }

  /** Moves on the server what was renamed here, when the server's copy is untouched; otherwise the plan handles it. */
  private async applyRenames(local: Map<string, LocalFile>, remote: Map<string, string>): Promise<boolean> {
    let moved = false;
    while (this.state.renames.length) {
      const { from, to } = this.state.renames[0]!;
      const s = this.state.files[from];
      if (s && remote.get(from) === s.hash && !remote.has(to) && !this.state.files[to] && !local.has(from) && local.has(to)) {
        try {
          await this.api.move(from, to);
          this.state.files[to] = s;
          delete this.state.files[from];
          remote.delete(from);
          remote.set(to, s.hash);
          moved = true;
        } catch (err) {
          if (err instanceof OfflineError || err instanceof AuthError) throw err;
        }
      }
      this.state.renames.shift();
      this.o.save?.();
    }
    return moved;
  }

  private async pull(path: string, before: string | null, listed: string) {
    const was = before === null ? null : await this.read(path);
    if (was !== null && (await sha256(was)) !== before) return this.skip();
    const got = isNote(path) ? (await this.api.getNote(path)).content : await this.api.getFile(path);
    const hash = await sha256(got);
    // A file by path can come back as a same-named one from another folder, or change as it's read.
    if (typeof got !== "string" && hash !== listed) return this.skip();
    if (!(await this.write(path, got, was))) return this.skip();
    this.track(path, hash, await this.local.stat(path));
    this.result.pulled++;
  }

  private async push(path: string, base: string | null, hash: string, stat: LocalFile) {
    const content = await this.read(path);
    if ((await sha256(content)) !== hash) return this.skip();
    try {
      if (typeof content === "string") await this.api.putNote(path, content, base);
      else await this.api.putFile(path, content, base);
    } catch (err) {
      if (!(err instanceof Conflict)) throw err;
      // Without `current` the file is there when it should be new, or gone when it should be there: the next round sees which.
      const now = err.current;
      if (!now) return this.skip();
      if (now.hash === hash) this.track(path, hash, stat);
      else {
        const theirs = "content" in now ? now.content : await this.api.getFile(path);
        if (typeof theirs !== "string" && (await sha256(theirs)) !== now.hash) return this.skip();
        await this.keepBoth(path, content, theirs, now.hash);
      }
      return;
    }
    this.track(path, hash, stat);
    this.result.pushed++;
  }

  private async conflict(path: string, localHash: string, listed: string) {
    const content = await this.read(path);
    if ((await sha256(content)) !== localHash) return this.skip();
    const theirs = isNote(path) ? (await this.api.getNote(path)).content : await this.api.getFile(path);
    const theirHash = await sha256(theirs);
    if (typeof theirs !== "string" && theirHash !== listed) return this.skip();
    await this.keepBoth(path, content, theirs, theirHash);
  }

  /** The server's version takes the path; ours is saved beside it and goes up as a note of its own next round. */
  private async keepBoth(path: string, mine: Bytes, theirs: Bytes, theirHash: string) {
    const copy = conflictPath(path, (this.o.date ?? today)(), (p) => this.taken.has(p));
    if (!(await this.write(copy, mine, null))) return this.skip();
    this.taken.add(copy);
    this.result.conflicts.push(copy);
    this.again = true;
    if (!(await this.write(path, theirs, mine))) return;
    this.track(path, theirHash, await this.local.stat(path));
  }

  private async deleteRemote(path: string) {
    await this.api.trash(path);
    delete this.state.files[path];
    this.result.deleted++;
  }

  private async deleteLocal(path: string, hash: string) {
    // The server's list comes from an index; before throwing a local file away, ask for the file itself.
    if (isNote(path)) {
      try {
        await this.api.getNote(path);
        return this.skip();
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
    }
    const here = await this.read(path).catch(() => null);
    if (here === null || (await sha256(here)) !== hash) return this.skip();
    await this.local.trash(path);
    delete this.state.files[path];
    this.result.deleted++;
  }
}
