/**
 * What to do with each file, given its hash locally, on the server, and as of the last sync. Only hashes go in, so
 * every rule here can be tested without a vault or a server. The rules never drop an edit: when one side changed a
 * file the other side deleted, the edit wins; when both changed it, both are kept.
 */
export type Hashes = ReadonlyMap<string, string>;

export type Plan = {
  /** Same on both sides: just remember it. */
  record: string[];
  /** Gone from both sides. */
  forget: string[];
  /** `base` is the hash the server must still have, null when the file must not be there yet. */
  push: { path: string; base: string | null }[];
  /** `local` is the hash the local copy must still have, null when there's none. */
  pull: { path: string; local: string | null }[];
  conflict: { path: string; local: string; remote: string }[];
  deleteLocal: { path: string; hash: string }[];
  deleteRemote: { path: string; hash: string }[];
};

export function plan(local: Hashes, remote: Hashes, synced: Hashes): Plan {
  const p: Plan = { record: [], forget: [], push: [], pull: [], conflict: [], deleteLocal: [], deleteRemote: [] };
  for (const path of new Set([...local.keys(), ...remote.keys(), ...synced.keys()])) {
    const l = local.get(path);
    const r = remote.get(path);
    const s = synced.get(path);
    if (l === undefined && r === undefined) p.forget.push(path);
    else if (l === r) p.record.push(path);
    else if (l !== undefined && r === undefined) {
      // New here, or edited here after the server deleted it: the edit stays and goes back up.
      if (l === s) p.deleteLocal.push({ path, hash: l });
      else p.push.push({ path, base: null });
    } else if (l === undefined && r !== undefined) {
      if (r === s) p.deleteRemote.push({ path, hash: r });
      else p.pull.push({ path, local: null });
    } else if (l !== undefined && r !== undefined) {
      if (s === r) p.push.push({ path, base: s });
      else if (s === l) p.pull.push({ path, local: l });
      else p.conflict.push({ path, local: l, remote: r });
    }
  }
  return p;
}

/**
 * Deleting a lot at once usually means one side is empty by accident (a share that didn't mount, a vault that hadn't
 * loaded), not that someone deleted everything. Returns how many deletions per side are held back until confirmed.
 */
export function massDeletes(p: Plan, tracked: number): { local: number; remote: number } {
  const big = (n: number) => (n >= 10 && n * 2 >= tracked ? n : 0);
  return { local: big(p.deleteLocal.length), remote: big(p.deleteRemote.length) };
}
